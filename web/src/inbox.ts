// Files shared to the app land in this cache (written by the service worker) until the person picks a folder.
export async function readInbox(): Promise<File[]> {
  const cache = await caches.open("share-inbox");
  const files: File[] = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (res) files.push(new File([await res.blob()], decodeURIComponent(res.headers.get("x-name") ?? "file"), { type: res.headers.get("content-type") ?? "" }));
  }
  return files;
}

export const clearInbox = () => caches.delete("share-inbox");
