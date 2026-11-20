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
