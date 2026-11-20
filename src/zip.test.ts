import test from "node:test";
import assert from "node:assert/strict";
import { crc32 as reference } from "node:zlib";
import { crc32, zipBytes, zipStream, type ZipEntry } from "./zipwriter.ts";
import { inspectZip, sha } from "../e2e/zipcheck.mjs";

const pattern = (n: number, seed = 0) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 131 + (i >> 7) + seed) & 255; return a; };
const chunked = (data: Uint8Array, size = 65536) => new ReadableStream<Uint8Array>({
  start(c) { for (let i = 0; i < data.length; i += size) c.enqueue(data.slice(i, i + size)); c.close(); },
});

test("crc32 matches zlib's, also when fed in pieces", () => {
  const data = pattern(200_000, 3);
  assert.equal(crc32(data), reference(data));
  let c = 0;
  for (const [a, b] of [[0, 1], [1, 70_000], [70_000, 70_001], [70_001, 200_000]]) c = crc32(data.subarray(a, b), c);
  assert.equal(c, reference(data));
  assert.equal(crc32(new Uint8Array()), 0);
});

test("zip: a nested tree with unicode names, an empty folder, an empty file and a 3 MB file opens cleanly in an independent reader", async () => {
  const files: Record<string, Uint8Array> = {
    "k-a": new TextEncoder().encode("hello zip"), "k-u": pattern(1234, 9), "k-z": new Uint8Array(), "k-big": pattern(3_000_000, 5),
  };
  const entries: ZipEntry[] = [
    { path: "Album", dir: true, size: 0, mtime: 1_700_000_000, key: null },
    { path: "Album/a.txt", dir: false, size: files["k-a"].length, mtime: 1_700_000_000, key: "k-a" },
    { path: "Album/ünï", dir: true, size: 0, mtime: 1_700_000_000, key: null },
    { path: "Album/ünï/日本語 café.bin", dir: false, size: files["k-u"].length, mtime: 1_700_000_100, key: "k-u" },
    { path: "Empty", dir: true, size: 0, mtime: 1_700_000_000, key: null },
    { path: "zero.bin", dir: false, size: 0, mtime: 100, key: "k-z" }, // a date before 1980 is clamped
    { path: "big.bin", dir: false, size: files["k-big"].length, mtime: 1_700_000_200, key: "k-big" },
  ];
  const out = new Uint8Array(await new Response(zipStream(zipBytes(entries, async (k) => chunked(files[k])))).arrayBuffer());
  const r = inspectZip(out);
  assert.equal(r.bad, null, "every file's CRC checks out");
  assert.deepEqual(r.names, ["Album/", "Album/a.txt", "Album/ünï/", "Album/ünï/日本語 café.bin", "Empty/", "zero.bin", "big.bin"]);
  assert.deepEqual(r.dirs, ["Album/", "Album/ünï/", "Empty/"]);
  assert.deepEqual(r.sha, {
    "Album/a.txt": sha(files["k-a"]), "Album/ünï/日本語 café.bin": sha(files["k-u"]), "zero.bin": sha(files["k-z"]), "big.bin": sha(files["k-big"]),
  });
});

test("zip: a wrong size or missing data makes the download fail instead of producing a bad archive", async () => {
  const bad = (entries: ZipEntry[], open: (k: string) => Promise<ReadableStream<Uint8Array> | null>) => new Response(zipStream(zipBytes(entries, open))).arrayBuffer();
  const one: ZipEntry = { path: "x.bin", dir: false, size: 10, mtime: 1_700_000_000, key: "k" };
  await assert.rejects(bad([one], async () => chunked(pattern(9))), /expected 10/);
  await assert.rejects(bad([one], async () => null), /missing/);
  await assert.rejects(bad([{ ...one, key: null }], async () => chunked(pattern(10))), /missing/);
});

test("zip: a downloader that gives up half way releases the stored file", async () => {
  let cancelled = false;
  const big = pattern(500_000);
  const body = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < big.length; i += 10_000) c.enqueue(big.slice(i, i + 10_000)); }, cancel() { cancelled = true; } });
  const reader = zipStream(zipBytes([{ path: "big.bin", dir: false, size: big.length, mtime: 1_700_000_000, key: "k" }], async () => body)).getReader();
  await reader.read(); await reader.read(); // header, first chunk
  await reader.cancel();
  assert.equal(cancelled, true);
});

test("crc32 is right for every length around the 8-byte steps and for random contents", () => {
  const random = new Uint8Array(4099); for (let i = 0; i < random.length; i++) random[i] = (Math.random() * 256) | 0;
  for (let n = 0; n <= 40; n++) assert.equal(crc32(random.subarray(0, n)), reference(random.subarray(0, n)), `length ${n}`);
  for (const n of [1023, 1024, 1025, 4099]) assert.equal(crc32(random.subarray(0, n)), reference(random.subarray(0, n)), `length ${n}`);
  let c = 0; for (let i = 0; i < random.length; i += 13) c = crc32(random.subarray(i, i + 13), c); // pieces of 13 bytes: never aligned
  assert.equal(c, reference(random));
  assert.equal(crc32(new Uint8Array(100).fill(255)), reference(new Uint8Array(100).fill(255)), "high bytes (sign handling)");
});
