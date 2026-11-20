import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8787 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "cloud-test-"));
let server: ChildProcess;

const wrangler = (...args: string[]) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe" });
const as = (who: string) => async (path: string, init: RequestInit = {}) =>
  fetch(BASE + path, { ...init, headers: { "x-dev-email": who, ...init.headers } });
const mom = as("mom@example.com");
const dad = as("dad@example.com");
const json = async (r: Response) => r.json() as Promise<any>;
const mkdir = async (f: typeof mom, name: string, parent?: number) =>
  json(await f("/api/folders", { method: "POST", body: JSON.stringify({ name, parent }) }));
const upload = (f: typeof mom, name: string, body: Uint8Array, parent?: number) =>
  f(`/api/files?name=${encodeURIComponent(name)}${parent ? `&parent=${parent}` : ""}`, { method: "PUT", body, headers: { "content-type": "image/png" } });
const names = async (f: typeof mom, parent?: number) =>
  (await json(await f(`/api/files${parent ? `?parent=${parent}` : ""}`))).items.map((i: any) => i.name);

before(async () => {
  const p = ["--local", "--persist-to", dir];
  wrangler("d1", "migrations", "apply", "DB", ...p);
  wrangler("d1", "execute", "DB", ...p, "--command", "insert into users (email, role) values ('mom@example.com','admin'), ('dad@example.com','member')");
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", dir, "--var", "DEV_EMAIL:mom@example.com"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dev server did not start");
});
after(() => {
  server?.kill();
  try { execFileSync("pkill", ["-f", `wrangler.*${PORT}`]); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

test("upload then download returns identical bytes, including ranges", async () => {
  const data = new Uint8Array(3_000_000); // getRandomValues caps at 65536 bytes per call
  for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
  const up = await upload(mom, "photo.png", data);
  assert.equal(up.status, 201);
  const f = await json(up);
  const res = await mom(`/api/files/${f.id}`);
  assert.equal(res.headers.get("content-disposition")?.startsWith("inline"), true);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), data);

  const part = await mom(`/api/files/${f.id}`, { headers: { range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-19/3000000");
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), data.slice(10, 20));
  const tail = await mom(`/api/files/${f.id}`, { headers: { range: "bytes=-5" } });
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), data.slice(-5));
  const open = await mom(`/api/files/${f.id}`, { headers: { range: "bytes=2999990-" } });
  assert.deepEqual(new Uint8Array(await open.arrayBuffer()), data.slice(2999990));
  assert.equal((await mom(`/api/files/${f.id}`, { headers: { range: "bytes=9999999-" } })).status, 416);
});

test("empty files and unsafe types", async () => {
  const empty = await json(await upload(mom, "empty.png", new Uint8Array()));
  assert.equal((await (await mom(`/api/files/${empty.id}`)).arrayBuffer()).byteLength, 0);
  const svg = await json(await mom("/api/files?name=x.svg", { method: "PUT", body: "<svg/>", headers: { "content-type": "image/svg+xml" } }));
  assert.match((await mom(`/api/files/${svg.id}`)).headers.get("content-disposition")!, /^attachment/);
});

test("folders, listing order, duplicate names, bad names", async () => {
  const docs = await mkdir(mom, "Docs");
  assert.equal(docs.kind, "folder");
  assert.equal((await mkdir(mom, "docs")).error !== undefined, true); // case-insensitive duplicate
  assert.equal((await mom("/api/folders", { method: "POST", body: JSON.stringify({ name: "a/b" }) })).status, 400);
  assert.equal((await mom("/api/folders", { method: "POST", body: JSON.stringify({ name: ".." }) })).status, 400);
  assert.equal((await upload(mom, "a.png", new Uint8Array([1]), docs.id)).status, 201);
  assert.equal((await upload(mom, "a.png", new Uint8Array([2]), docs.id)).status, 409);
  assert.deepEqual(await names(mom, docs.id), ["a.png"]);
  const top = await names(mom);
  assert.ok(top.indexOf("Docs") < top.indexOf("photo.png"), "folders come before files");
});

test("rename, move, cycle protection, trash and restore", async () => {
  const a = await mkdir(mom, "A");
  const b = await mkdir(mom, "B", a.id);
  assert.equal((await mom(`/api/files/${a.id}`, { method: "PATCH", body: JSON.stringify({ parent: b.id }) })).status, 400); // into own child
  assert.equal((await mom(`/api/files/${a.id}`, { method: "PATCH", body: JSON.stringify({ name: "A2" }) })).status, 200);
  assert.equal((await mom(`/api/files/${b.id}`, { method: "PATCH", body: JSON.stringify({ parent: null }) })).status, 200); // to top level
  assert.ok((await names(mom)).includes("B"));

  assert.equal((await mom(`/api/files/${b.id}`, { method: "DELETE" })).status, 204);
  assert.ok(!(await names(mom)).includes("B"));
  assert.equal((await mom(`/api/files/${b.id}`, { method: "PATCH", body: "{}" })).status, 404); // trashed items are frozen
  assert.ok((await json(await mom("/api/trash"))).items.some((i: any) => i.id === b.id));
  await mkdir(mom, "B"); // name is free again while B is in the trash
  assert.equal((await mom(`/api/files/${b.id}/restore`, { method: "POST" })).status, 409);
  assert.equal((await mom(`/api/files/${(await json(await mom("/api/files"))).items.find((i: any) => i.name === "B").id}`, { method: "DELETE" })).status, 204);
  assert.equal((await mom(`/api/files/${b.id}/restore`, { method: "POST" })).status, 200);

  // a folder in the trash hides its contents and blocks restoring them alone
  const f = await json(await upload(mom, "inner.png", new Uint8Array([1]), a.id));
  await mom(`/api/files/${f.id}`, { method: "DELETE" });
  await mom(`/api/files/${a.id}`, { method: "DELETE" });
  assert.equal((await mom(`/api/files/${f.id}/restore`, { method: "POST" })).status, 409);
  assert.ok(!(await json(await mom("/api/trash"))).items.some((i: any) => i.id === f.id));
});

test("people only see their own files plus the Family folder", async () => {
  const secret = await json(await upload(mom, "secret.png", new Uint8Array([9])));
  assert.equal((await dad(`/api/files/${secret.id}`)).status, 404);
  assert.equal((await dad(`/api/files/${secret.id}`, { method: "DELETE" })).status, 404);
  assert.ok(!(await names(dad)).includes("secret.png"));

  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  assert.equal(family.shared, 1);
  assert.ok((await names(dad)).includes("Family"));
  const shared = await json(await upload(mom, "trip.png", new Uint8Array([7]), family.id));
  assert.equal((await dad(`/api/files/${shared.id}`)).status, 200); // dad can read mom's Family upload
  assert.equal((await dad(`/api/files/${shared.id}`, { method: "DELETE" })).status, 204); // and manage it

  assert.equal((await mom(`/api/files/${secret.id}`, { method: "PATCH", body: JSON.stringify({ parent: family.id }) })).status, 400); // no moving across spaces
  assert.equal((await mom(`/api/files/${family.id}`, { method: "DELETE" })).status, 400);
  assert.equal((await as("stranger@example.com")("/api/files")).status, 403);
});

test("thumbnails: store, serve, replace, and the rules around them", async () => {
  const f = await json(await upload(mom, "pic.png", new Uint8Array([1, 2, 3])));
  assert.equal(f.thumb, 0);
  assert.equal((await mom(`/api/files/${f.id}/thumb`)).status, 404);
  const put = (body: BodyInit, type = "image/jpeg", who = mom) => who(`/api/files/${f.id}/thumb`, { method: "PUT", body, headers: { "content-type": type } });
  assert.equal((await put(new Uint8Array([0xff, 0xd8, 1]))).status, 204);
  const got = await mom(`/api/files/${f.id}/thumb`);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), new Uint8Array([0xff, 0xd8, 1]));
  assert.equal((await json(await mom("/api/files"))).items.find((i: any) => i.id === f.id).thumb, 1);
  assert.equal((await put(new Uint8Array([9, 9]))).status, 204); // replace
  assert.deepEqual(new Uint8Array(await (await mom(`/api/files/${f.id}/thumb`)).arrayBuffer()), new Uint8Array([9, 9]));

  assert.equal((await put("<svg/>", "image/svg+xml")).status, 400);
  assert.equal((await put(new Uint8Array(300_001))).status, 413);
  assert.equal((await put(new Uint8Array([1]), "image/jpeg", dad)).status, 404); // not dad's file
  assert.equal((await dad(`/api/files/${f.id}/thumb`)).status, 404);
  const folder = await mkdir(mom, "ThumbFolder");
  assert.equal((await mom(`/api/files/${folder.id}/thumb`, { method: "PUT", body: new Uint8Array([1]), headers: { "content-type": "image/jpeg" } })).status, 400);
  await mom(`/api/files/${f.id}`, { method: "DELETE" });
  assert.equal((await mom(`/api/files/${f.id}/thumb`)).status, 404); // trashed
});

// ---- large (multipart) uploads ----
const MiB = 1024 * 1024;
const pattern = (n: number) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 31 + (i >> 8)) & 255; return a; };
const startUpload = (f: typeof mom, body: object) => f("/api/uploads", { method: "POST", body: JSON.stringify(body) });
const sendPart = (f: typeof mom, id: string, n: number, data: Uint8Array) => f(`/api/uploads/${id}/parts/${n}`, { method: "PUT", body: data });
const finish = (f: typeof mom, id: string) => f(`/api/uploads/${id}/complete`, { method: "POST" });
const bytesOf = async (f: typeof mom, id: number) => new Uint8Array(await (await f(`/api/files/${id}`)).arrayBuffer());

test("large upload: parts sent out of order assemble into identical bytes", async () => {
  const data = pattern(20 * MiB); // 8 + 8 + 4 MiB
  const s = await json(await startUpload(mom, { name: "movie.bin", size: data.length }));
  assert.equal(s.partSize, 8 * MiB);
  assert.deepEqual(s.parts, []);
  for (const n of [3, 1, 2]) assert.equal((await sendPart(mom, s.id, n, data.slice((n - 1) * 8 * MiB, n * 8 * MiB))).status, 204);
  const done = await finish(mom, s.id);
  assert.equal(done.status, 201);
  const f = await json(done);
  assert.equal(f.size, data.length);
  assert.deepEqual(await bytesOf(mom, f.id), data);
});

test("large upload: starting again with the same file resumes and keeps finished parts", async () => {
  const data = pattern(17 * MiB); // 8 + 8 + 1 MiB
  const body = { name: "resume.bin", size: data.length };
  const a = await json(await startUpload(mom, body));
  await sendPart(mom, a.id, 1, data.slice(0, 8 * MiB));
  await sendPart(mom, a.id, 2, data.slice(8 * MiB, 16 * MiB));
  const b = await json(await startUpload(mom, body)); // e.g. after a reload or dropped connection
  assert.equal(b.id, a.id);
  assert.deepEqual(b.parts, [1, 2]);
  assert.equal((await finish(mom, a.id)).status, 409); // part 3 still missing
  await sendPart(mom, a.id, 2, data.slice(8 * MiB, 16 * MiB)); // re-sending a part is harmless
  await sendPart(mom, a.id, 3, data.slice(16 * MiB));
  const f = await json(await finish(mom, a.id));
  assert.deepEqual(await bytesOf(mom, f.id), data);
  assert.equal((await startUpload(mom, body)).status, 409); // name is now taken
});

test("large upload: size, ownership and destination rules", async () => {
  const data = pattern(9 * MiB);
  const s = await json(await startUpload(mom, { name: "rules.bin", size: data.length }));
  assert.equal((await sendPart(mom, s.id, 1, data.slice(0, MiB))).status, 400); // part 1 must be exactly 8 MiB
  assert.equal((await sendPart(mom, s.id, 2, data.slice(8 * MiB, 9 * MiB - 1))).status, 400); // last part must be the exact remainder
  assert.equal((await sendPart(mom, s.id, 3, data.slice(0, MiB))).status, 400); // no part 3
  assert.equal((await sendPart(mom, s.id, 0, data.slice(0, MiB))).status, 400);
  assert.equal((await sendPart(dad, s.id, 1, data.slice(0, 8 * MiB))).status, 404); // dad cannot touch mom's upload
  assert.equal((await finish(dad, s.id)).status, 404);
  assert.equal((await mom("/api/uploads/not-a-real-id/complete", { method: "POST" })).status, 404);

  assert.equal((await startUpload(mom, { name: "z.bin", size: 0 })).status, 400);
  assert.equal((await startUpload(mom, { name: "z.bin", size: 51 * 1024 ** 3 })).status, 400);
  assert.equal((await startUpload(mom, { name: "a/b", size: 10 })).status, 400);
  const secret = await mkdir(mom, "PrivateForMom");
  assert.equal((await startUpload(dad, { name: "x.bin", size: 10, parent: secret.id })).status, 404);

  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const small = pattern(9 * MiB);
  const fs = await json(await startUpload(dad, { name: "family.bin", size: small.length, parent: family.id }));
  await sendPart(dad, fs.id, 1, small.slice(0, 8 * MiB));
  await sendPart(dad, fs.id, 2, small.slice(8 * MiB));
  const shared = await json(await finish(dad, fs.id));
  assert.equal(shared.shared, 1);
  assert.deepEqual(await bytesOf(mom, shared.id), small); // mom can read what dad put in Family
});

test("folders nest to any depth, including inside Family, and files move between them", async () => {
  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const dadsFolder = await mkdir(dad, "Dad", family.id);
  const photos = await mkdir(dad, "Photos", dadsFolder.id);
  const trips = await mkdir(mom, "Trips", photos.id); // mom can add inside dad's folder: Family is open to everyone
  const f = await json(await upload(mom, "lake.png", new Uint8Array([5]), family.id));
  const moved = await mom(`/api/files/${f.id}`, { method: "PATCH", body: JSON.stringify({ parent: trips.id }) });
  assert.equal(moved.status, 200);
  assert.deepEqual(await names(dad, trips.id), ["lake.png"]);
  assert.equal((await json(await dad(`/api/files?parent=${trips.id}`))).parent.name, "Trips");
  assert.equal((await mom(`/api/files/${f.id}`, { method: "PATCH", body: JSON.stringify({ parent: null }) })).status, 400); // Family files cannot go to someone's top level
});
