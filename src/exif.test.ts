import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { takenAt, takenFromBytes } from "../web/src/exif.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(`src/fixtures/${name}`)); // made by Pillow / pillow-heif: scripts/make-exif-fixtures.py
const local = (y: number, mo: number, d: number, h: number, mi: number, s: number) => Math.floor(new Date(y, mo - 1, d, h, mi, s).getTime() / 1000);

test("exif: the date taken is read from JPEG, HEIC and PNG made by other software", () => {
  assert.equal(takenFromBytes(fixture("exif-offset.jpg")), Date.UTC(2019, 6, 4, 15, 30, 45) / 1000 - 2 * 3600, "a time-zone offset (+02:00) is applied");
  assert.equal(takenFromBytes(fixture("exif-local.jpg")), local(2018, 3, 9, 7, 5, 3), "no offset: the phone's local time");
  assert.equal(takenFromBytes(fixture("exif.heic")), local(2021, 12, 25, 8, 15, 0), "an iPhone-style HEIC");
  assert.equal(takenFromBytes(fixture("exif.png")), local(2017, 11, 30, 23, 59, 58));
});

test("exif: the picture-taken date wins over the digitised and edited dates (the fixtures disagree on purpose)", () => {
  // exif-offset.jpg also says digitized +1s and edited 2020-01-01; exif.heic says edited 2022-02-02
  assert.notEqual(takenFromBytes(fixture("exif-offset.jpg")), local(2020, 1, 1, 0, 0, 0));
  assert.notEqual(takenFromBytes(fixture("exif.heic")), local(2022, 2, 2, 2, 2, 2));
});

test("exif: nothing, nonsense and broken files give null, never an error", () => {
  assert.equal(takenFromBytes(fixture("no-exif.jpg")), null);
  assert.equal(takenFromBytes(fixture("bad-clock.jpg")), null, "1970: a clock that was never set");
  assert.equal(takenFromBytes(fixture("zero-date.jpg")), null, "0000:00:00");
  assert.equal(takenFromBytes(new Uint8Array()), null);
  const noise = new Uint8Array(100_000); for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  assert.equal(takenFromBytes(noise), null);
  const real = fixture("exif-offset.jpg");
  const taken = Date.UTC(2019, 6, 4, 15, 30, 45) / 1000 - 7200, edited = local(2020, 1, 1, 0, 0, 0); // no offset tag for the edit date: local time
  const takenNoOffset = local(2019, 7, 4, 15, 30, 45); // the cut can remove only the time-zone tag
  for (let cut = 0; cut <= real.length; cut += 7) { // a photo cut off anywhere: never an error, never a made-up date
    const t = takenFromBytes(real.subarray(0, cut));
    assert.ok(t === null || t === taken || t === takenNoOffset || t === edited, `cut at ${cut} bytes gave ${t}`);
  }
  assert.equal(takenFromBytes(real.subarray(0, 40)), null, "cut before any date");
  const fake = new Uint8Array(64); fake.set([0x4d, 0x4d, 0, 0x2a, 0, 0, 0xff, 0xff], 8); // looks like the marker, points outside the file
  assert.equal(takenFromBytes(fake), null);
});

test("takenAt: uses the date inside the file, else the file's own date", async () => {
  const lastModified = Date.UTC(2026, 10, 20, 12, 0, 0); // "today": the day the photo was copied
  const withExif = new File([fixture("exif-offset.jpg")], "IMG_1.jpg", { type: "image/jpeg", lastModified });
  assert.equal(await takenAt(withExif), Date.UTC(2019, 6, 4, 15, 30, 45) / 1000 - 7200, "the inside date, not the copy date");
  const heic = new File([fixture("exif.heic")], "IMG_2.HEIC", { type: "", lastModified }); // some phones give no type
  assert.equal(await takenAt(heic), local(2021, 12, 25, 8, 15, 0), "recognised by its name");
  const plain = new File([fixture("no-exif.jpg")], "x.jpg", { type: "image/jpeg", lastModified });
  assert.equal(await takenAt(plain), lastModified / 1000, "no date inside: the file's date");
  const video = new File([new Uint8Array(1000)], "clip.mp4", { type: "video/mp4", lastModified });
  assert.equal(await takenAt(video), lastModified / 1000, "videos use the file's date");
});
