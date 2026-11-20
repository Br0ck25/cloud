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
