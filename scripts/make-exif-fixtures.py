#!/usr/bin/env python3
"""Writes the tiny sample photos used by src/exif.test.ts into src/fixtures/. Needs: pip install pillow pillow-heif.
The dates differ on purpose: DateTimeOriginal (when the picture was taken) must win over DateTimeDigitized and DateTime (edited)."""
import pillow_heif
from PIL import ExifTags, Image

pillow_heif.register_heif_opener()
OUT = "src/fixtures"


def exif(original, digitized=None, edited=None, offset=None):
    e = Image.Exif()
    if edited:
        e[0x0132] = edited  # DateTime in the main block: when the file was last edited
    sub = e.get_ifd(ExifTags.IFD.Exif)
    sub[0x9003] = original  # DateTimeOriginal
    if digitized:
        sub[0x9004] = digitized  # DateTimeDigitized
    if offset:
        sub[0x9011] = offset  # OffsetTimeOriginal
    return e


img = Image.new("RGB", (32, 24), (200, 80, 40))
img.save(f"{OUT}/exif-offset.jpg", exif=exif("2019:07:04 15:30:45", "2019:07:04 15:30:46", "2020:01:01 00:00:00", "+02:00"))
img.save(f"{OUT}/exif-local.jpg", exif=exif("2018:03:09 07:05:03", "2018:03:09 07:05:04", "2020:01:01 00:00:00"))
img.save(f"{OUT}/exif.heic", exif=exif("2021:12:25 08:15:00", "2021:12:25 08:15:01", "2022:02:02 02:02:02").tobytes())
img.save(f"{OUT}/exif.png", exif=exif("2017:11:30 23:59:58").tobytes())
img.save(f"{OUT}/no-exif.jpg")
img.save(f"{OUT}/bad-clock.jpg", exif=exif("1970:01:01 00:00:00"))
img.save(f"{OUT}/zero-date.jpg", exif=exif("0000:00:00 00:00:00"))
for name in ["exif-offset.jpg", "exif-local.jpg", "exif.heic", "exif.png"]:
    e = Image.open(f"{OUT}/{name}").getexif().get_ifd(ExifTags.IFD.Exif)
    print(name, "reads back as", e.get(0x9003), e.get(0x9011))
