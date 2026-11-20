// When was this photo taken? Read from the EXIF block inside the file; the file's own date is the fallback.
// The block is a small TIFF structure ("MM\0*" or "II*\0"). JPEG, HEIC (iPhone) and PNG all carry one, so instead of
// understanding every container we look for that marker near the start of the file and read the dates from it.
const OLDEST = Date.UTC(1990, 0, 1) / 1000; // earlier than this is a camera clock that was never set

type Tags = { text: Map<number, string>; sub: number | null };

/** The text entries of one EXIF directory, and where its Exif sub-directory is (tag 0x8769). Null if it does not look like a directory. */
function readDirectory(b: Uint8Array, base: number, at: number, le: boolean): Tags | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (at < 8 || base + at + 2 > b.length) return null;
  const count = dv.getUint16(base + at, le);
  if (count > 500) return null;
  const text = new Map<number, string>();
  let sub: number | null = null;
  for (let i = 0; i < count; i++) {
    const e = base + at + 2 + i * 12;
    if (e + 12 > b.length) return null;
    const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), n = dv.getUint32(e + 4, le);
    if (tag === 0x8769) sub = dv.getUint32(e + 8, le);
    else if (type === 2 && n >= 1 && n < 64) { // ASCII text, stored in the entry itself when 4 bytes or fewer
      const from = n <= 4 ? e + 8 : base + dv.getUint32(e + 8, le);
      if (from + n <= b.length) text.set(tag, String.fromCharCode(...b.subarray(from, from + n).filter((c) => c !== 0)));
    }
  }
  return { text, sub };
}

/** "2019:07:04 15:30:45" (+ optional "+02:00") to unix seconds. Without an offset the time is the phone's local time. */
function toUnix(stamp: string | undefined, offset: string | undefined): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(stamp ?? "");
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const off = /^([+-])(\d{2}):(\d{2})$/.exec(offset ?? "");
  const ms = off ? Date.UTC(y, mo - 1, d, h, mi, s) - (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60000 : new Date(y, mo - 1, d, h, mi, s).getTime();
  const t = Math.floor(ms / 1000);
  return t >= OLDEST && t <= Date.now() / 1000 + 86400 ? t : null; // not in the future either
}

function readTiff(b: Uint8Array, base: number): number | null {
  const le = b[base] === 0x49;
  const first = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(base + 4, le);
  const main = readDirectory(b, base, first, le);
  if (!main) return null;
  const exif = main.sub === null ? null : readDirectory(b, base, main.sub, le);
  // Best first: when the picture was taken, when it was digitised, when the file was last edited.
  return toUnix(exif?.text.get(0x9003), exif?.text.get(0x9011)) ?? toUnix(exif?.text.get(0x9004), exif?.text.get(0x9012)) ?? toUnix(main.text.get(0x0132), exif?.text.get(0x9010));
}

/** The capture date found in the first bytes of an image file, in unix seconds, or null. */
export function takenFromBytes(b: Uint8Array): number | null {
  let tries = 0;
  for (let i = 0; i + 8 < b.length && tries < 16; i++) {
    if (b[i] !== 0x4d && b[i] !== 0x49) continue;
    const motorola = b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a;
    const intel = b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0;
    if (!motorola && !intel) continue;
    tries++;
    try { const t = readTiff(b, i); if (t !== null) return t; } catch { /* not a real EXIF block: keep looking */ }
  }
  return null;
}

/** When the photo was taken (unix seconds): from inside the file if it says, else the file's own date. A phone's file date can be the day it was copied, so the inside date is better. */
export async function takenAt(file: File): Promise<number> {
  if (file.type.startsWith("image/") || /\.(jpe?g|heic|heif|png|webp|tiff?|dng)$/i.test(file.name)) {
    try {
      const t = takenFromBytes(new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer()));
      if (t !== null) return t;
    } catch { /* unreadable: use the file date */ }
  }
  return Math.floor(file.lastModified / 1000);
}
