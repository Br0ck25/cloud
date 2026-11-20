import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8787 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "cloud-test-"));
let server: ChildProcess;

const wrangler = (...args: string[]) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe" });
const as = (who: string) => async (path: string, init: RequestInit = {}) => {
  try {
    // "connection: close": after a long pause (slow CLI steps) the server drops idle connections, and Node does not retry a POST on a dead one.
    return await fetch(BASE + path, { ...init, headers: { "x-dev-email": who, connection: "close", ...init.headers } });
  } catch (e) {
    const c = (e as { cause?: { code?: string; message?: string } }).cause; // Node's "fetch failed" hides the real reason
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${c?.code ?? c?.message ?? e}`);
  }
};
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
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", dir, "--test-scheduled", "--var", "DEV_EMAIL:mom@example.com"], { stdio: process.env.TEST_SERVER_LOG ? ["ignore", openSync(process.env.TEST_SERVER_LOG, "w"), openSync(process.env.TEST_SERVER_LOG, "a")] : "ignore" }); // set TEST_SERVER_LOG=file to see the server's output
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

// ---- public link shares ----
const pub = (path: string, init?: RequestInit) => fetch(BASE + path, init); // no identity header: this is what an outsider sends
const makeShare = async (f: typeof mom, node: number, days: number | null = 7) => json(await f("/api/shares", { method: "POST", body: JSON.stringify({ node, days }) }));
const putFile = async (f: typeof mom, name: string, data: Uint8Array, parent?: number, type = "image/png") =>
  json(await f(`/api/files?name=${encodeURIComponent(name)}${parent ? `&parent=${parent}` : ""}`, { method: "PUT", body: data, headers: { "content-type": type } }));

test("link share of a file: public page, bytes, ranges and safe HTML", async () => {
  const data = pattern(5000);
  const f = await putFile(mom, "<img src=x onerror=alert(1)>.png", data);
  const s = await makeShare(mom, f.id);
  assert.match(s.token, /^[\w-]{22}$/);

  const page = await pub(`/s/${s.token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("&#60;img src=x onerror=alert(1)&#62;.png"), "file name is escaped");
  assert.ok(!html.includes("<img src=x"), "no raw markup from names");
  assert.ok(html.includes("--brand"), "app stylesheet is inlined");
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");

  const raw = await pub(`/s/${s.token}/f/${f.id}`);
  assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), data);
  const part = await pub(`/s/${s.token}/f/${f.id}`, { headers: { range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), data.slice(10, 20));
  assert.match((await pub(`/s/${s.token}/f/${f.id}?download=1`)).headers.get("content-disposition")!, /^attachment/);

  const other = await putFile(mom, "not-shared.png", pattern(10));
  assert.equal((await pub(`/s/${s.token}/f/${other.id}`)).status, 404); // a link opens only what it was made for
  assert.equal((await pub(`/s/${s.token}`, { method: "POST" })).status, 404);
  assert.equal((await pub("/s/AAAAAAAAAAAAAAAAAAAAAA")).status, 404); // unknown token
});

test("link share of a folder reaches everything inside it and nothing else", async () => {
  const parent = await mkdir(mom, "ShareParent");
  const dir = await mkdir(mom, "Shared dir", parent.id);
  const sub = await mkdir(mom, "Sub", dir.id);
  const a = await putFile(mom, "a.png", pattern(10), dir.id);
  const b = await putFile(mom, "b.png", pattern(20), sub.id);
  const outside = await putFile(mom, "outside.png", pattern(30), parent.id);
  const { token } = await makeShare(mom, dir.id);

  const root = await (await pub(`/s/${token}`)).text();
  assert.ok(root.includes(">a.png<") && root.includes(">Sub<") && !root.includes("outside.png"));
  const inner = await pub(`/s/${token}/d/${sub.id}`);
  assert.equal(inner.status, 200);
  const innerHtml = await inner.text();
  assert.ok(innerHtml.includes(">b.png<") && innerHtml.includes(`href="/s/${token}"`), "subfolder page lists its file and links back to the share root");
  assert.equal((await pub(`/s/${token}/f/${b.id}`)).status, 200);

  assert.equal((await pub(`/s/${token}/f/${outside.id}`)).status, 404);
  assert.equal((await pub(`/s/${token}/d/${parent.id}`)).status, 404); // cannot climb above the shared folder

  await mom(`/api/files/${sub.id}`, { method: "DELETE" });
  assert.equal((await pub(`/s/${token}/f/${b.id}`)).status, 404); // trashed folder hides what is inside
  await mom(`/api/files/${sub.id}/restore`, { method: "POST" });
  assert.equal((await pub(`/s/${token}/f/${b.id}`)).status, 200);
  await mom(`/api/files/${dir.id}`, { method: "DELETE" });
  assert.equal((await pub(`/s/${token}`)).status, 404); // trashing the shared item switches the link off
  assert.ok(a.id);
});

test("link share lifecycle: validation, listing, expiry, revoke and who may manage links", async () => {
  const f = await putFile(mom, "lifecycle.png", pattern(10));
  for (const days of [0, 366, 1.5, "7"]) assert.equal((await mom("/api/shares", { method: "POST", body: JSON.stringify({ node: f.id, days }) })).status, 400);
  const forever = await makeShare(mom, f.id, null);
  assert.equal(forever.expires_at, null);
  const week = await makeShare(mom, f.id, 7);
  assert.ok(Math.abs(week.expires_at - (Date.now() / 1000 + 7 * 86400)) < 60);
  const listed = (await json(await mom(`/api/shares?node=${f.id}`))).items;
  assert.deepEqual(listed.map((l: any) => l.id), [week.id, forever.id]); // newest first

  assert.equal((await dad(`/api/shares?node=${f.id}`)).status, 404); // dad cannot see mom's private file or its links
  assert.equal((await dad("/api/shares", { method: "POST", body: JSON.stringify({ node: f.id, days: 1 }) })).status, 404);
  assert.equal((await dad(`/api/shares/${week.id}`, { method: "DELETE" })).status, 404);

  wrangler("d1", "execute", "DB", "--local", "--persist-to", dir, "--command", `update shares set expires_at = 1 where id = ${week.id}`);
  assert.equal((await pub(`/s/${week.token}`)).status, 404); // expired
  assert.equal((await pub(`/s/${forever.token}`)).status, 200);
  assert.equal((await mom(`/api/shares/${forever.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await pub(`/s/${forever.token}`)).status, 404); // revoked

  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const shared = await putFile(mom, "family-pic.png", pattern(10), family.id);
  const fam = await makeShare(dad, shared.id); // any family member can link an item in Family...
  assert.equal((await mom(`/api/shares/${fam.id}`, { method: "DELETE" })).status, 204); // ...and any can revoke it
});

// ---- admin ----
test("admin: only admins, adding and removing family, storage numbers", async () => {
  assert.equal((await dad("/api/admin")).status, 403); // members cannot see the family list
  assert.equal((await dad("/api/admin/users", { method: "POST", body: JSON.stringify({ email: "x@example.com" }) })).status, 403);

  const aunt = as("aunt@example.com");
  assert.equal((await aunt("/api/me")).status, 403); // not on the list yet
  const added = await mom("/api/admin/users", { method: "POST", body: JSON.stringify({ email: "  Aunt@Example.com " }) });
  assert.equal(added.status, 201);
  const auntRow = await json(added);
  assert.deepEqual([auntRow.email, auntRow.role, auntRow.active], ["aunt@example.com", "member", 1]);
  assert.equal((await aunt("/api/me")).status, 200); // now she can sign in
  assert.equal((await mom("/api/admin/users", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) })).status, 400);

  const mine = (await json(await mom("/api/admin"))).users.find((u: any) => u.email === "mom@example.com");
  assert.equal((await mom(`/api/admin/users/${mine.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) })).status, 400); // no locking yourself out
  assert.equal((await mom(`/api/admin/users/${mine.id}`, { method: "PATCH", body: JSON.stringify({ role: "member" }) })).status, 400);
  assert.equal((await mom("/api/admin/users/99999", { method: "PATCH", body: JSON.stringify({ active: false }) })).status, 404);
  assert.equal((await mom(`/api/admin/users/${auntRow.id}`, { method: "PATCH", body: JSON.stringify({ role: "boss" }) })).status, 400);

  await aunt("/api/files?name=aunt.png", { method: "PUT", body: new Uint8Array(1234), headers: { "content-type": "image/png" } });
  const removed = await json(await mom(`/api/admin/users/${auntRow.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) }));
  assert.equal(removed.active, 0);
  assert.equal(removed.bytes, 1234); // her files are kept and still counted
  assert.equal((await aunt("/api/me")).status, 403); // access is off
  assert.equal((await aunt("/api/files")).status, 403);
  assert.equal((await mom("/api/admin/users", { method: "POST", body: JSON.stringify({ email: "aunt@example.com", role: "admin" }) })).status, 201); // adding again restores access
  assert.equal((await aunt("/api/me")).status, 200);
  assert.equal((await json(await aunt("/api/me"))).role, "admin");

  const before = await json(await mom("/api/admin"));
  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  await upload(mom, "admin-count.png", new Uint8Array(1000), family.id);
  const after = await json(await mom("/api/admin"));
  assert.equal(after.family_bytes - before.family_bytes, 1000);
  assert.equal(after.total_bytes, after.users.reduce((t: number, u: any) => t + u.bytes, after.family_bytes));
});

// ---- search ----
test("search finds names anywhere you can see, and nothing you cannot", async () => {
  const find = async (f: typeof mom, q: string) => (await json(await f(`/api/search?q=${encodeURIComponent(q)}`))).items;
  const album = await mkdir(mom, "Quokka Album");
  const deep = await mkdir(mom, "deeper", album.id);
  const a = await putFile(mom, "QUOKKA at beach.png", pattern(5), deep.id);
  await putFile(mom, "100%_real.png", pattern(5));
  await putFile(mom, "100 real.png", pattern(5));
  await putFile(mom, "dad-cannot-see-quokka.png", pattern(5));
  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  await putFile(mom, "quokka-family.png", pattern(5), family.id);

  const hits = await find(mom, "quokka");
  assert.deepEqual(hits.map((h: any) => h.name), ["Quokka Album", "dad-cannot-see-quokka.png", "QUOKKA at beach.png", "quokka-family.png"].sort((x, y) => (x === "Quokka Album" ? -1 : y === "Quokka Album" ? 1 : x.toLowerCase().localeCompare(y.toLowerCase()))));
  assert.equal(hits.find((h: any) => h.id === a.id).folder, "deeper"); // tells you where it lives
  assert.deepEqual((await find(dad, "quokka")).map((h: any) => h.name), ["quokka-family.png"]); // only Family's file, none of mom's private ones
  assert.equal((await find(mom, "%_")).length, 1); // wildcards are matched literally
  assert.equal((await find(mom, "nonexistent-zzz")).length, 0);
  assert.equal((await mom("/api/search?q=")).status, 400);
  assert.equal((await mom("/api/search?q=" + "x".repeat(101))).status, 400);

  await mom(`/api/files/${deep.id}`, { method: "DELETE" }); // trash a folder: what is inside disappears from search too
  assert.ok(!(await find(mom, "quokka")).some((h: any) => h.id === a.id || h.id === deep.id));
  await mom(`/api/files/${deep.id}/restore`, { method: "POST" });
  assert.ok((await find(mom, "quokka")).some((h: any) => h.id === a.id));
});

// ---- versions ----
const newVersion = (f: typeof mom, id: number, data: Uint8Array, type = "image/png") => f(`/api/files/${id}/content`, { method: "PUT", body: data, headers: { "content-type": type } });
const versionsOf = async (f: typeof mom, id: number) => json(await f(`/api/files/${id}/versions`));
const sql = (q: string) => JSON.parse(wrangler("d1", "execute", "DB", "--local", "--persist-to", dir, "--json", "--command", q).toString())[0].results as any[];

test("versions: new content keeps the old as history and any version can be restored", async () => {
  const A = pattern(3000), B = pattern(5000).reverse(), C = new Uint8Array([1, 2, 3]);
  const f = await putFile(mom, "report.png", A);
  assert.deepEqual((await versionsOf(mom, f.id)).items, []);
  await mom(`/api/files/${f.id}/thumb`, { method: "PUT", body: new Uint8Array([0xff, 0xd8]), headers: { "content-type": "image/jpeg" } });
  assert.equal((await json(await mom(`/api/files`))).items.find((i: any) => i.id === f.id).thumb, 1);

  const v2 = await json(await newVersion(mom, f.id, B));
  assert.equal(v2.size, 5000);
  assert.equal(v2.name, "report.png"); // same file: name, place and id unchanged
  assert.equal(v2.thumb, 0); // the new content needs its own thumbnail
  assert.deepEqual(await bytesOf(mom, f.id), B);
  const list = await versionsOf(mom, f.id);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].size, 3000);
  assert.equal(list.current.size, 5000);
  const old = await mom(`/api/files/${f.id}/versions/${list.items[0].id}`);
  assert.match(old.headers.get("content-disposition")!, /^attachment/);
  assert.deepEqual(new Uint8Array(await old.arrayBuffer()), A); // the old bytes are still downloadable

  const back = await json(await mom(`/api/files/${f.id}/versions/${list.items[0].id}/restore`, { method: "POST" }));
  assert.equal(back.size, 3000);
  assert.equal(back.thumb, 1); // the restored content gets its thumbnail back
  assert.deepEqual(await bytesOf(mom, f.id), A);
  const after = await versionsOf(mom, f.id);
  assert.deepEqual(after.items.map((v: any) => v.size), [5000]); // what we replaced is now the history entry: restoring is undoable
  assert.equal((await mom(`/api/files/${f.id}/versions/${list.items[0].id}`)).status, 404); // the restored entry left the list

  await newVersion(mom, f.id, C);
  assert.deepEqual((await versionsOf(mom, f.id)).items.map((v: any) => v.size), [3000, 5000]);
});

test("versions: only the last 10 are kept and old ones are removed from storage", async () => {
  const f = await putFile(mom, "many.png", new Uint8Array([0]));
  const firstBlob = sql(`select blob_key k from nodes where id = ${f.id}`)[0].k;
  for (let i = 1; i <= 12; i++) await newVersion(mom, f.id, new Uint8Array(i));
  const kept = (await versionsOf(mom, f.id)).items;
  assert.equal(kept.length, 10);
  assert.deepEqual(kept.map((v: any) => v.size), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]); // newest first; the two oldest were dropped
  assert.equal(sql(`select count(*) c from versions where node_id = ${f.id}`)[0].c, 10);
  // the dropped blobs must be gone from R2 too, not only from the table
  const r2get = (key: string) => wrangler("r2", "object", "get", `cloud-files/${key}`, "--local", "--persist-to", dir, "--pipe");
  assert.throws(() => r2get(firstBlob), "the original content was pruned from storage");
  const keptKey = sql(`select blob_key k from versions where node_id = ${f.id} order by id desc limit 1`)[0].k;
  assert.doesNotThrow(() => r2get(keptKey), "a kept version is still in storage");
});

test("versions: who may use them, and what they cost", async () => {
  const f = await putFile(mom, "private-v.png", pattern(10));
  assert.equal((await newVersion(dad, f.id, pattern(5))).status, 404); // dad cannot touch mom's private file
  assert.equal((await dad(`/api/files/${f.id}/versions`)).status, 404);
  const folder = await mkdir(mom, "VersionsFolder");
  assert.equal((await newVersion(mom, folder.id, pattern(5))).status, 400); // only files have versions
  assert.equal((await mom(`/api/files/${f.id}/content`, { method: "PUT", body: pattern(5), headers: { "content-type": "image/png", "content-length": "5" } })).status, 200);

  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const shared = await putFile(mom, "shared-v.png", new Uint8Array(1000), family.id);
  const before = (await json(await mom("/api/admin"))).family_bytes;
  assert.equal((await newVersion(dad, shared.id, new Uint8Array(400))).status, 200); // anyone in the family can version a Family file
  const afterBytes = (await json(await mom("/api/admin"))).family_bytes;
  assert.equal(afterBytes - before, 400, "storage now counts 1000 (kept as a version) + 400 (current) instead of 1000");

  await mom(`/api/files/${shared.id}`, { method: "DELETE" });
  assert.equal((await newVersion(mom, shared.id, pattern(5))).status, 404); // trashed files are frozen
  assert.equal((await mom(`/api/files/${shared.id}/versions`)).status, 404);
});

// ---- nightly cleanup ----
const nightly = () => fetch(`${BASE}/cdn-cgi/handler/scheduled`); // dev server started with --test-scheduled
const inStorage = (key: string) => { try { wrangler("r2", "object", "get", `cloud-files/${key}`, "--local", "--persist-to", dir, "--pipe"); return true; } catch { return false; } };

test("nightly cleanup: month-old trash is gone for good, everything else is untouched", async () => {
  const old = await mkdir(mom, "OldTrash");
  const inner = await mkdir(mom, "inner", old.id);
  const f = await putFile(mom, "doomed.png", pattern(100), inner.id);
  await mom(`/api/files/${f.id}/thumb`, { method: "PUT", body: new Uint8Array([0xff, 0xd8]), headers: { "content-type": "image/jpeg" } });
  await newVersion(mom, f.id, pattern(50)); // now: a current blob, plus a version holding the old blob and the thumbnail
  const link = await makeShare(mom, f.id);
  const recent = await putFile(mom, "recent-trash.png", pattern(10));
  const keeper = await putFile(mom, "keeper.png", pattern(12));

  const keys: string[] = sql(`select blob_key k from nodes where id = ${f.id} union select blob_key from versions where node_id = ${f.id} union select thumb_key from versions where node_id = ${f.id}`).map((r) => r.k);
  assert.equal(keys.length, 3);
  assert.ok(keys.every(inStorage), "all three objects exist before the cleanup");

  assert.equal((await mom(`/api/files/${old.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await mom(`/api/files/${recent.id}`, { method: "DELETE" })).status, 204);
  sql(`update nodes set trashed_at = unixepoch() - 31 * 86400 where id = ${old.id}`);
  sql(`update nodes set trashed_at = unixepoch() - 5 * 86400 where id = ${recent.id}`);
  assert.equal((await pub(`/s/${link.token}`)).status, 404); // already off because its folder is in the trash

  assert.equal((await nightly()).status, 200);

  const left = (table: string, col: string, ids: number[]) => sql(`select count(*) c from ${table} where ${col} in (${ids.join(",")})`)[0].c;
  assert.equal(left("nodes", "id", [old.id, inner.id, f.id]), 0, "the folder, its subfolder and the file are gone");
  assert.equal(left("versions", "node_id", [f.id]), 0);
  assert.equal(left("shares", "node_id", [f.id]), 0);
  assert.ok(keys.every((k) => !inStorage(k)), "their storage objects were deleted too");

  assert.ok((await json(await mom("/api/trash"))).items.some((i: any) => i.id === recent.id), "5-day-old trash is still recoverable");
  assert.equal((await mom(`/api/files/${recent.id}/restore`, { method: "POST" })).status, 200);
  assert.deepEqual(await bytesOf(mom, keeper.id), pattern(12), "live files are untouched");
  assert.equal((await nightly()).status, 200); // running again changes nothing
  assert.equal((await mom(`/api/files/${keeper.id}`)).status, 200);
});

test("nightly cleanup: abandoned large uploads are dropped, fresh ones kept", async () => {
  const data = pattern(9 * MiB);
  const stale = await json(await startUpload(mom, { name: "abandoned.bin", size: data.length }));
  await sendPart(mom, stale.id, 1, data.slice(0, 8 * MiB));
  const fresh = await json(await startUpload(mom, { name: "fresh.bin", size: data.length }));
  sql(`update uploads set created_at = unixepoch() - 7 * 86400 where id = '${stale.id}'`);

  assert.equal((await nightly()).status, 200);

  assert.equal((await sendPart(mom, stale.id, 2, data.slice(8 * MiB))).status, 404, "the abandoned session is gone");
  assert.equal((await sendPart(mom, fresh.id, 2, data.slice(8 * MiB))).status, 204, "a recent session is untouched");
  assert.equal(sql(`select count(*) c from upload_parts where upload_id = '${stale.id}'`)[0].c, 0);
  const again = await json(await startUpload(mom, { name: "abandoned.bin", size: data.length }));
  assert.notEqual(again.id, stale.id);
  assert.deepEqual(again.parts, [], "starting that file again begins cleanly");
});

// ---- backup ----
import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const bucketGet = (bucket: string, key: string) => wrangler("r2", "object", "get", `${bucket}/${key}`, "--local", "--persist-to", dir, "--pipe");
const inBucket = (bucket: string, key: string) => { try { bucketGet(bucket, key); return true; } catch { return false; } };
const runBackup = async (f = mom) => json(await f("/api/admin/backup", { method: "POST" }));
const settle = async () => { let s = await runBackup(); for (let i = 0; i < 10 && s.waiting - s.too_big > 0; i++) s = await runBackup(); return s; };

test("backup: every file and thumbnail is copied byte for byte, once, with a database dump", async () => {
  assert.equal((await dad("/api/admin/backup", { method: "POST" })).status, 403);

  const data = pattern(4000);
  const f = await putFile(mom, "to-back-up.png", data);
  await mom(`/api/files/${f.id}/thumb`, { method: "PUT", body: new Uint8Array([0xff, 0xd8, 7]), headers: { "content-type": "image/jpeg" } });
  await newVersion(mom, f.id, pattern(900)); // old content + its thumbnail become a version
  const keys: string[] = sql(`select blob_key k from nodes where id = ${f.id} union select blob_key from versions where node_id = ${f.id} union select thumb_key from versions where node_id = ${f.id}`).map((r) => r.k);
  assert.equal(keys.length, 3);
  assert.ok(keys.every((k) => !inBucket("cloud-backup", k)), "nothing is in the backup bucket yet");

  const s = await settle();
  assert.equal(s.waiting, 0);
  assert.equal(s.failed, 0);
  assert.ok(s.ran_at && s.files >= 3 && s.bytes > 0);
  for (const k of keys) assert.deepEqual(bucketGet("cloud-backup", k), bucketGet("cloud-files", k), `${k} matches the original`);

  const filesBefore = s.files;
  await putFile(mom, "second-file.png", pattern(100));
  const s2 = await runBackup();
  assert.equal(s2.files, filesBefore + 1, "only the new file was copied");
  assert.equal(s2.waiting, 0);
  assert.equal((await json(await mom("/api/admin"))).backup.files, s2.files, "the admin page shows the same status");

  const dump = JSON.parse(gunzipSync(bucketGet("cloud-backup", `db/${new Date().toISOString().slice(0, 10)}.json.gz`)).toString());
  assert.equal(dump.tables.nodes.length, sql("select count(*) c from nodes")[0].c);
  assert.equal(dump.tables.users.length, sql("select count(*) c from users")[0].c);
});

test("backup: deleting the original keeps the copy, and the database can be rebuilt from the dump", async () => {
  const f = await putFile(mom, "will-be-purged.png", pattern(777));
  const key = sql(`select blob_key k from nodes where id = ${f.id}`)[0].k;
  await settle();
  assert.ok(inBucket("cloud-backup", key));

  await mom(`/api/files/${f.id}`, { method: "DELETE" });
  sql(`update nodes set trashed_at = unixepoch() - 40 * 86400 where id = ${f.id}`);
  await nightly(); // purge
  assert.ok(!inBucket("cloud-files", key), "the original is gone for good");
  assert.ok(inBucket("cloud-backup", key), "the backup copy is still there");
  assert.deepEqual(new Uint8Array(bucketGet("cloud-backup", key)), pattern(777));
  const s = await runBackup();
  assert.ok(s.kept_after_delete >= 1, "the admin status counts copies kept after deletion");

  // Rebuild the database in a brand new D1 from the dump and compare every table row by row.
  const tables = ["users", "nodes", "versions", "shares"];
  const snapshot = (where: string) => tables.map((t) => JSON.stringify(JSON.parse(wrangler("d1", "execute", "DB", "--local", "--persist-to", where, "--json", "--command", `select * from ${t} order by ${t === "shares" || t === "versions" || t === "nodes" || t === "users" ? "id" : "rowid"}`).toString())[0].results));
  const before = snapshot(dir);
  const scratch = mkdtempSync(join(tmpdir(), "cloud-restore-")); // outside the server's data folder: files appearing there make the dev server restart
  const dumpFile = join(scratch, "dump.json.gz");
  const sqlFile = join(scratch, "restore.sql");
  writeFileSync(dumpFile, bucketGet("cloud-backup", `db/${new Date().toISOString().slice(0, 10)}.json.gz`));
  writeFileSync(sqlFile, execFileSync("node", ["scripts/restore-db.mjs", dumpFile]));
  const fresh = join(scratch, "fresh");
  wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", fresh);
  wrangler("d1", "execute", "DB", "--local", "--persist-to", fresh, "--file", sqlFile);
  assert.deepEqual(snapshot(fresh), before, "users, nodes, versions and shares are identical after the restore");
  rmSync(scratch, { recursive: true, force: true });
});

// ---- backup care: warning, pruning, self-healing ----
test("backup: admins are warned on /api/me when it is stale; members never see it", async () => {
  await settle();
  assert.equal((await json(await mom("/api/me"))).backup_warning, null);
  sql("update backup_status set ran_at = unixepoch() - 40 * 3600 where id = 1");
  assert.match((await json(await mom("/api/me"))).backup_warning, /more than a day and a half/);
  assert.ok(!("backup_warning" in (await json(await dad("/api/me")))), "regular members get no backup information");
  await runBackup();
  assert.equal((await json(await mom("/api/me"))).backup_warning, null, "a fresh run clears it");
});

test("backup: a copy is removed 30 days after its original is gone, never before and never while the original exists", async () => {
  const live = await putFile(mom, "stays-forever.png", pattern(50));
  const recent = await putFile(mom, "gone-recently.png", pattern(60));
  const old = await putFile(mom, "gone-long-ago.png", pattern(70));
  const keyOf = (id: number) => sql(`select blob_key k from nodes where id = ${id}`)[0].k as string;
  const [kLive, kRecent, kOld] = [live.id, recent.id, old.id].map(keyOf);
  await settle();
  for (const k of [kLive, kRecent, kOld]) assert.ok(inBucket("cloud-backup", k));

  for (const f of [recent, old]) {
    await mom(`/api/files/${f.id}`, { method: "DELETE" });
    sql(`update nodes set trashed_at = unixepoch() - 40 * 86400 where id = ${f.id}`);
  }
  await nightly(); // purge both from the main bucket
  await runBackup(); // notices they are gone and starts the 30-day clock
  assert.ok(sql(`select gone_at g from backed_up where key = '${kOld}'`)[0].g, "the clock started for the deleted file");
  assert.equal(sql(`select gone_at g from backed_up where key = '${kLive}'`)[0].g, null, "no clock for a file that still exists");

  sql(`update backed_up set gone_at = unixepoch() - 31 * 86400 where key = '${kOld}'`);
  sql(`update backed_up set gone_at = unixepoch() - 5 * 86400 where key = '${kRecent}'`);
  sql(`update backed_up set gone_at = unixepoch() - 400 * 86400 where key = '${kLive}'`); // even a bogus ancient mark must not delete a live file's copy
  await runBackup();

  assert.ok(!inBucket("cloud-backup", kOld), "31 days after it was gone, the copy is removed");
  assert.equal(sql(`select count(*) c from backed_up where key = '${kOld}'`)[0].c, 0, "and its tracking row");
  assert.ok(inBucket("cloud-backup", kRecent), "5 days after it was gone, the copy is still there");
  assert.ok(inBucket("cloud-backup", kLive), "a file that still exists keeps its copy however old the mark");
  assert.equal(sql(`select gone_at g from backed_up where key = '${kLive}'`)[0].g, null, "the bogus mark was cleared");
});

test("backup: a copy deleted from the backup bucket is noticed and copied again", async () => {
  const data = pattern(321);
  const f = await putFile(mom, "heal-me.png", data);
  const key = sql(`select blob_key k from nodes where id = ${f.id}`)[0].k as string;
  await settle();
  assert.ok(inBucket("cloud-backup", key));

  wrangler("r2", "object", "delete", `cloud-backup/${key}`, "--local", "--persist-to", dir);
  assert.ok(!inBucket("cloud-backup", key), "someone deleted the backup copy");
  sql(`update backed_up set checked_at = unixepoch() where key != '${key}'`); // so this one is first in line for checking
  sql(`update backed_up set checked_at = null where key = '${key}'`);

  const s = await runBackup();
  assert.equal(s.repaired, 1);
  assert.ok(inBucket("cloud-backup", key), "it was copied again");
  assert.deepEqual(new Uint8Array(bucketGet("cloud-backup", key)), data, "with the right bytes");
  assert.match((await json(await mom("/api/me"))).backup_warning, /1 backup copy had gone missing and was copied again/);
  assert.equal((await runBackup()).repaired, 0, "and the next run is clean");
  assert.equal((await json(await mom("/api/me"))).backup_warning, null);
});

// ---- photos timeline ----
const putTaken = async (f: typeof mom, name: string, taken: number | string | null, opts: { parent?: number; type?: string } = {}) =>
  json(await f(`/api/files?name=${encodeURIComponent(name)}${opts.parent ? `&parent=${opts.parent}` : ""}${taken != null ? `&taken=${taken}` : ""}`, { method: "PUT", body: pattern(8), headers: { "content-type": opts.type ?? "image/png" } }));
const photosOf = async (f: typeof mom, limit = 50) => {
  const out: any[] = [];
  let before = "";
  for (let i = 0; i < 100; i++) {
    const r = await json(await f(`/api/photos?limit=${limit}${before}`));
    out.push(...r.items);
    if (!r.next) return out;
    before = `&before=${r.next}`;
  }
  throw new Error("never-ending pages");
};

test("photos: newest first by the date taken, paged without gaps, and only what you may see", async () => {
  const T = 1_000_000_000; // September 2001: older than anything else the tests create
  const now = Math.floor(Date.now() / 1000);
  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const a = await putTaken(mom, "ph-a.png", T + 100);
  await putTaken(mom, "ph-b.mp4", T + 200, { type: "video/mp4" });
  await putTaken(mom, "ph-tie1.png", T + 50);
  await putTaken(mom, "ph-tie2.png", T + 50); // same moment: the later upload comes first
  await putTaken(mom, "ph-doc.txt", T + 300, { type: "text/plain" }); // not a photo or video
  await putTaken(mom, "ph-vec.svg", T + 310, { type: "image/svg+xml" }); // can run scripts: never shown as a picture
  const gone = await putTaken(mom, "ph-trashed.png", T + 320);
  await mom(`/api/files/${gone.id}`, { method: "DELETE" });
  const binned = await mkdir(mom, "ph-binned");
  await putTaken(mom, "ph-infolder.png", T + 330, { parent: binned.id });
  await mom(`/api/files/${binned.id}`, { method: "DELETE" });
  await putTaken(dad, "ph-dad.png", T + 340); // dad's private photo
  await putTaken(dad, "ph-fam.png", T + 350, { parent: family.id });
  const garbage = await putTaken(mom, "ph-garbage.png", "abc"); // nonsense date: the upload time is used instead
  const future = await putTaken(mom, "ph-future.png", now + 10 * 86400); // a phone with a wrong clock
  assert.ok(Math.abs(garbage.taken_at - now) < 60 && Math.abs(future.taken_at - now) < 60, "bad dates fall back to the upload time");
  assert.equal(a.taken_at, T + 100);

  const mine = (await photosOf(mom)).filter((p) => p.name.startsWith("ph-"));
  assert.deepEqual(mine.map((p) => p.name), ["ph-future.png", "ph-garbage.png", "ph-fam.png", "ph-b.mp4", "ph-a.png", "ph-tie2.png", "ph-tie1.png"],
    "newest first; videos in, documents, SVG, trashed and trashed-folder items out, dad's private photo hidden, his Family photo shown");

  assert.deepEqual((await photosOf(mom, 2)).map((p) => p.id), (await photosOf(mom, 200)).map((p) => p.id), "paging two at a time gives the same list as one big page");
  const sorted = await photosOf(mom, 3);
  assert.ok(sorted.every((p, i) => i === 0 || p.taken_at < sorted[i - 1].taken_at || (p.taken_at === sorted[i - 1].taken_at && p.id < sorted[i - 1].id)), "strictly ordered by (date taken, id)");
  assert.equal(new Set(sorted.map((p) => p.id)).size, sorted.length, "no photo appears twice");

  const his = (await photosOf(dad)).filter((p) => p.name.startsWith("ph-")).map((p) => p.name);
  assert.ok(his.includes("ph-dad.png") && his.includes("ph-fam.png") && !his.includes("ph-a.png"), "dad sees his own and Family's, not mom's private photos");
  assert.ok(!mine.some((p) => p.name === "ph-dad.png"));
  const one = await json(await mom("/api/photos?limit=1"));
  assert.equal(one.items.length, 1);
  assert.match(one.next, /^\d+:\d+$/);
});

test("photos: the date taken also travels with large (multipart) uploads", async () => {
  const data = pattern(9 * MiB);
  const s = await json(await startUpload(mom, { name: "ph-big.bin", size: data.length, taken: 1_000_000_400 }));
  await sendPart(mom, s.id, 1, data.slice(0, 8 * MiB));
  await sendPart(mom, s.id, 2, data.slice(8 * MiB));
  assert.equal((await json(await finish(mom, s.id))).taken_at, 1_000_000_400);
  const s2 = await json(await startUpload(mom, { name: "ph-big2.bin", size: data.length, taken: "yesterday" }));
  await sendPart(mom, s2.id, 1, data.slice(0, 8 * MiB));
  await sendPart(mom, s2.id, 2, data.slice(8 * MiB));
  assert.ok(Math.abs((await json(await finish(mom, s2.id))).taken_at - Date.now() / 1000) < 60, "a nonsense date falls back to the upload time here too");
});

// ---- delete forever ----
const purge = (f: typeof mom, body?: object) => f("/api/trash/purge", { method: "POST", body: JSON.stringify(body ?? {}) });
const trashIds = async (f: typeof mom) => (await json(await f("/api/trash"))).items.map((i: any) => i.id) as number[];

test("delete forever: chosen items go for good with their files, versions and links; everything else stays", async () => {
  const doomed = await putFile(mom, "forever.png", pattern(40));
  await newVersion(mom, doomed.id, pattern(30));
  await mom(`/api/files/${doomed.id}/thumb`, { method: "PUT", body: new Uint8Array([0xff, 0xd8]), headers: { "content-type": "image/jpeg" } });
  const link = await makeShare(mom, doomed.id);
  const folder = await mkdir(mom, "ForeverFolder");
  const inside = await putFile(mom, "inside-forever.png", pattern(20), folder.id);
  const keeper = await putFile(mom, "stays-in-trash.png", pattern(15));
  const keys = sql(`select blob_key k from nodes where id in (${doomed.id}, ${inside.id}) union select blob_key from versions where node_id = ${doomed.id}`).map((r) => r.k as string);
  assert.equal(keys.length, 3);
  for (const id of [doomed.id, folder.id, keeper.id]) assert.equal((await mom(`/api/files/${id}`, { method: "DELETE" })).status, 204);

  assert.equal((await purge(mom, { ids: "all" })).status, 400);
  assert.equal((await purge(mom, { ids: [1.5] })).status, 400);
  assert.deepEqual(await json(await purge(mom, { ids: [] })), { purged: 0, remaining: (await trashIds(mom)).length }, "an empty list deletes nothing");
  assert.ok(await trashIds(mom).then((t) => t.includes(keeper.id)));

  const r = await json(await purge(mom, { ids: [doomed.id, folder.id, inside.id] })); // inside.id is not at the top of the trash: ignored
  assert.equal(r.purged, 2);
  assert.equal(sql(`select count(*) c from nodes where id in (${doomed.id}, ${folder.id}, ${inside.id})`)[0].c, 0, "the file, the folder and what was inside it are gone");
  assert.equal(sql(`select count(*) c from versions where node_id = ${doomed.id}`)[0].c, 0);
  assert.equal(sql(`select count(*) c from shares where node_id = ${doomed.id}`)[0].c, 0);
  assert.ok(keys.every((k) => !inStorage(k)), "their stored files are deleted");
  assert.equal((await pub(`/s/${link.token}`)).status, 404);
  assert.ok((await trashIds(mom)).includes(keeper.id), "the item that was not chosen is still in the trash");
});

test("delete forever: only your own trash (and Family's); emptying takes everything", async () => {
  const secret = await putFile(mom, "mom-trash.png", pattern(10));
  await mom(`/api/files/${secret.id}`, { method: "DELETE" });
  assert.equal((await json(await purge(dad, { ids: [secret.id] }))).purged, 0, "dad cannot delete mom's trashed file");
  assert.ok((await trashIds(mom)).includes(secret.id));

  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const shared = await putFile(mom, "family-trash.png", pattern(10), family.id);
  await mom(`/api/files/${shared.id}`, { method: "DELETE" });
  assert.equal((await json(await purge(dad, { ids: [shared.id] }))).purged, 1, "anyone in the family can empty Family's trash");

  const all = await json(await purge(mom)); // no ids: everything of hers
  assert.equal(all.remaining, 0);
  assert.deepEqual(await trashIds(mom), []);
});

// ---- zip download ----
import { inspectZip, sha as shaOf } from "../e2e/zipcheck.mjs";
const zipOf = async (f: typeof mom, ids: number[]) => f(`/api/zip?ids=${ids.join(",")}`);
const zipBody = async (r: Response) => new Uint8Array(await r.arrayBuffer());

test("zip: a folder downloads with its whole tree, empty folders and exact bytes", async () => {
  const root = await mkdir(mom, "ZipRoot");
  const sub = await mkdir(mom, "Sub folder", root.id);
  await mkdir(mom, "Empty", root.id);
  const deep = await mkdir(mom, "Ünï", sub.id);
  const a = pattern(5000, 1), b = pattern(70_000, 2), c = pattern(3, 3);
  await putFile(mom, "a.png", a, root.id);
  await putFile(mom, "b café.png", b, sub.id);
  await putFile(mom, "日本語.png", c, deep.id);
  const gone = await putFile(mom, "trashed.png", pattern(10), root.id);
  await mom(`/api/files/${gone.id}`, { method: "DELETE" });

  const r = await zipOf(mom, [root.id]);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  assert.match(r.headers.get("content-disposition")!, /^attachment; filename\*=UTF-8''ZipRoot\.zip$/);
  const z = inspectZip(await zipBody(r));
  assert.equal(z.bad, null, "every file's CRC checks out in an independent reader");
  assert.deepEqual([...z.names].sort(), ["ZipRoot/", "ZipRoot/Empty/", "ZipRoot/Sub folder/", "ZipRoot/Sub folder/Ünï/", "ZipRoot/Sub folder/Ünï/日本語.png", "ZipRoot/Sub folder/b café.png", "ZipRoot/a.png"].sort());
  assert.deepEqual(z.sha, { "ZipRoot/a.png": shaOf(a), "ZipRoot/Sub folder/b café.png": shaOf(b), "ZipRoot/Sub folder/Ünï/日本語.png": shaOf(c) });
  assert.ok(!z.names.some((n: string) => n.includes("trashed")), "trashed items are left out");

  const info = await json(await mom(`/api/zip?ids=${root.id}&check=1`));
  assert.deepEqual(info, { name: "ZipRoot.zip", files: 3, bytes: 5000 + 70_000 + 3 });
});

test("zip: several picked items, same names, and who may download what", async () => {
  const one = await mkdir(mom, "ZipPickA");
  const two = await mkdir(mom, "ZipPickB");
  const x = await putFile(mom, "same.png", pattern(11, 4), one.id);
  const y = await putFile(mom, "same.png", pattern(22, 5), two.id); // picked together, same name
  const lone = await putFile(mom, "lone.png", pattern(33, 6));
  const r = await zipOf(mom, [x.id, y.id, lone.id]);
  assert.match(r.headers.get("content-disposition")!, /Family%20Cloud\.zip/);
  const z = inspectZip(await zipBody(r));
  assert.equal(z.bad, null);
  assert.deepEqual([...z.names].sort(), ["lone.png", "same (1).png", "same.png"], "a clash gets a number, nothing is overwritten");
  assert.deepEqual(new Set(Object.values(z.sha)), new Set([shaOf(pattern(11, 4)), shaOf(pattern(22, 5)), shaOf(pattern(33, 6))]));

  const secret = await putFile(mom, "zip-secret.png", pattern(9));
  assert.equal((await zipOf(dad, [secret.id])).status, 404, "dad cannot download mom's private file");
  const mixed = inspectZip(await zipBody(await zipOf(dad, [secret.id, (await putFile(dad, "dads.png", pattern(7))).id])));
  assert.deepEqual(mixed.names, ["dads.png"], "what he may not see is simply left out");
  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const shared = await putFile(mom, "zip-family.png", pattern(15, 8), family.id);
  assert.deepEqual(inspectZip(await zipBody(await zipOf(dad, [shared.id]))).names, ["zip-family.png"], "anyone can download Family's files");
});

test("zip: bad requests get a clear refusal", async () => {
  assert.equal((await mom("/api/zip")).status, 400);
  assert.equal((await mom("/api/zip?ids=abc")).status, 400);
  assert.equal((await mom("/api/zip?ids=1.5")).status, 400);
  assert.equal((await mom(`/api/zip?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(",")}`)).status, 400, "more than 100 items");
  assert.equal((await mom("/api/zip?ids=999999")).status, 404);
  const trashed = await putFile(mom, "zip-trashed.png", pattern(5));
  await mom(`/api/files/${trashed.id}`, { method: "DELETE" });
  assert.equal((await zipOf(mom, [trashed.id])).status, 404, "a trashed item is not downloadable");
  assert.equal((await mom("/api/zip?ids=1", { method: "POST" })).status, 404);
});

// ---- all share links ----
test("share links overview: every link on items you can see, who made it, and none that cannot work", async () => {
  const mine = await putFile(mom, "links-mine.png", pattern(10));
  const dir = await mkdir(mom, "LinksDir");
  const doomed = await putFile(mom, "links-trashed.png", pattern(10));
  const dadsPrivate = await putFile(dad, "links-dad-private.png", pattern(10));
  const family = (await json(await mom("/api/files"))).items.find((i: any) => i.name === "Family");
  const shared = await putFile(dad, "links-family.png", pattern(10), family.id);
  const a = await makeShare(mom, mine.id, 7);
  const b = await makeShare(mom, dir.id, null);
  const c = await makeShare(mom, doomed.id);
  const d = await makeShare(dad, dadsPrivate.id);
  const e = await makeShare(dad, shared.id);
  await mom(`/api/files/${doomed.id}`, { method: "DELETE" });
  sql(`update shares set expires_at = 1 where id = ${a.id}`);

  const all = (await json(await mom("/api/shares/all"))).items;
  const ids = all.map((l: any) => l.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id) && ids.includes(e.id), "her own links, including an expired one, and one on a Family file made by dad");
  assert.ok(!ids.includes(c.id), "a link on a trashed item is not listed");
  assert.ok(!ids.includes(d.id), "a link on dad's private file is not hers to see");
  const row = (id: number) => all.find((l: any) => l.id === id);
  assert.deepEqual([row(a.id).name, row(a.id).kind, row(a.id).made_by], ["links-mine.png", "file", "mom@example.com"]);
  assert.equal(row(a.id).expires_at, 1);
  assert.equal(row(b.id).expires_at, null);
  assert.equal(row(b.id).kind, "folder");
  assert.equal(row(e.id).made_by, "dad@example.com");
  assert.deepEqual(ids, [...ids].sort((x: number, y: number) => y - x), "newest first");
  assert.match(row(a.id).token, /^[\w-]{22}$/);

  const his = (await json(await dad("/api/shares/all"))).items.map((l: any) => l.id);
  assert.ok(his.includes(d.id) && his.includes(e.id) && !his.includes(a.id) && !his.includes(b.id), "dad sees his links and Family's, not mom's private ones");
  assert.equal((await mom("/api/shares/all", { method: "POST" })).status, 404);
});
