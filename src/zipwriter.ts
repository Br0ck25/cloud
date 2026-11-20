// Streams a ZIP archive without compression ("store"). Files are read from R2 one at a time and passed straight through,
// so memory stays flat however big the folder is. No Zip64: an archive must stay under 4 GB and 65,535 entries (the caller enforces that).
export type ZipEntry = { path: string; dir: boolean; size: number; mtime: number; key: string | null };

const enc = new TextEncoder();
// Slicing-by-8: eight lookup tables let the loop swallow 8 bytes per step (measured about 1.6x faster than one byte at a time). This loop is the CPU cost of zipping big files.
const TABLE = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  for (let n = 0; n < 256; n++) { let c = t[n]; for (let k = 1; k < 8; k++) { c = (t[c & 0xff] ^ (c >>> 8)) >>> 0; t[k * 256 + n] = c; } }
  return t;
})();

/** CRC-32 of `buf`, continuing from `prev` (0 to start). ZIP stores this for every file. */
export function crc32(buf: Uint8Array, prev = 0): number {
  let c = (prev ^ 0xffffffff) >>> 0;
  let i = 0;
  for (; i + 8 <= buf.length; i += 8) {
    const lo = (c ^ (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24))) >>> 0;
    c = (TABLE[1792 + (lo & 255)] ^ TABLE[1536 + ((lo >>> 8) & 255)] ^ TABLE[1280 + ((lo >>> 16) & 255)] ^ TABLE[1024 + (lo >>> 24)]
      ^ TABLE[768 + buf[i + 4]] ^ TABLE[512 + buf[i + 5]] ^ TABLE[256 + buf[i + 6]] ^ TABLE[buf[i + 7]]) >>> 0;
  }
  for (; i < buf.length; i++) c = (TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const dosTime = (sec: number) => {
  const d = new Date(Math.max(sec, 315532800) * 1000); // ZIP dates start in 1980
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
};

function record(size: number, fill: (v: DataView) => void, name?: Uint8Array): Uint8Array {
  const b = new Uint8Array(size + (name?.length ?? 0));
  fill(new DataView(b.buffer));
  if (name) b.set(name, size);
  return b;
}
const UTF8 = 0x0800, DESCRIPTOR = 0x0008; // flag bits: names are UTF-8; sizes and CRC follow the data

const localHeader = (name: Uint8Array, flags: number, time: number, date: number) => record(30, (v) => {
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, flags, true); v.setUint16(8, 0, true);
  v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint16(26, name.length, true); // CRC and sizes are 0: they follow the data
}, name);
const descriptor = (crc: number, size: number) => record(16, (v) => { v.setUint32(0, 0x08074b50, true); v.setUint32(4, crc, true); v.setUint32(8, size, true); v.setUint32(12, size, true); });
const centralHeader = (name: Uint8Array, flags: number, time: number, date: number, crc: number, size: number, offset: number, dir: boolean) => record(46, (v) => {
  v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, flags, true); v.setUint16(10, 0, true);
  v.setUint16(12, time, true); v.setUint16(14, date, true); v.setUint32(16, crc, true); v.setUint32(20, size, true); v.setUint32(24, size, true);
  v.setUint16(28, name.length, true); v.setUint32(38, dir ? 0x10 : 0, true); v.setUint32(42, offset, true);
}, name);
const endRecord = (count: number, size: number, offset: number) => record(22, (v) => {
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, count, true); v.setUint16(10, count, true); v.setUint32(12, size, true); v.setUint32(16, offset, true);
});

/** The archive's bytes, in order. `open` returns the stored bytes for a key. */
export async function* zipBytes(entries: ZipEntry[], open: (key: string) => Promise<ReadableStream<Uint8Array> | null>): AsyncGenerator<Uint8Array> {
  let offset = 0;
  const central: Uint8Array[] = [];
  for (const e of entries) {
    const name = enc.encode(e.dir ? `${e.path}/` : e.path);
    const { time, date } = dosTime(e.mtime);
    const flags = e.dir ? UTF8 : UTF8 | DESCRIPTOR;
    const start = offset;
    const head = localHeader(name, flags, time, date);
    yield head; offset += head.length;
    let crc = 0, size = 0;
    if (!e.dir) {
      const body = e.key ? await open(e.key) : null;
      if (!body) throw new Error(`stored data is missing for ${e.path}`);
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32(value, crc); size += value.length; offset += value.length;
          yield value;
        }
      } finally { await reader.cancel().catch(() => {}); } // also runs when the downloader gives up half way
      if (size !== e.size) throw new Error(`${e.path} is ${size} bytes, expected ${e.size}`);
      const tail = descriptor(crc, size);
      yield tail; offset += tail.length;
    }
    central.push(centralHeader(name, flags, time, date, crc, size, start, e.dir));
  }
  const dirStart = offset;
  let dirSize = 0;
  for (const c of central) { yield c; dirSize += c.length; }
  yield endRecord(central.length, dirSize, dirStart);
}

export const zipStream = (bytes: AsyncGenerator<Uint8Array>) => new ReadableStream<Uint8Array>({
  async pull(c) { const r = await bytes.next(); if (r.done) c.close(); else c.enqueue(r.value); },
  async cancel() { await bytes.return(undefined); },
});

