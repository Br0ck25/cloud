const MAX = 320; // longest side in pixels

function toJpeg(src: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const k = Math.min(1, MAX / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((done) => c.toBlob(done, "image/jpeg", 0.72));
}

function videoFrame(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const finish = (b: Blob | null) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(b); };
    const timer = setTimeout(() => finish(null), 8000);
    v.muted = true; v.playsInline = true; v.preload = "metadata";
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, v.duration / 2); };
    v.onseeked = async () => finish(await toJpeg(v, v.videoWidth, v.videoHeight));
    v.onerror = () => finish(null);
    v.src = url;
  });
}

/** A small JPEG preview of a photo or video, or null when the browser cannot decode it (the UI then shows an icon). */
export async function makeThumb(file: File): Promise<Blob | null> {
  try {
    if (file.type.startsWith("video/")) return await videoFrame(file);
    if (file.type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      try { return await toJpeg(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
    }
  } catch {}
  return null;
}
