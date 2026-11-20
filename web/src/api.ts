export type Item = {
  id: number; parent_id: number | null; name: string; kind: "file" | "folder";
  size: number | null; mime: string | null; updated_at: number; taken_at?: number; shared: number; thumb: number; trashed_at?: number; folder?: string | null;
};

export class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new HttpError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText, res.status);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
const send = (method: string, body?: object): RequestInit => ({ method, body: body && JSON.stringify(body) });

export type Share = { id: number; token: string; expires_at: number | null; created_at: number };

export type Person = { id: number; email: string; role: "admin" | "member"; active: number; bytes: number };

export const me = () => call<{ id: number; email: string; role: "admin" | "member"; backup_warning?: string | null }>("/api/me");
export type Backup = { ran_at: number | null; files: number; bytes: number; waiting: number; kept_after_delete: number; failed: number; too_big: number; repaired: number };
export const admin = () => call<{ users: Person[]; family_bytes: number; total_bytes: number; backup: Backup }>("/api/admin");
export const backupNow = () => call<Backup>("/api/admin/backup", send("POST"));
export const addPerson = (email: string) => call("/api/admin/users", send("POST", { email }));
export const editPerson = (id: number, patch: { role?: string; active?: boolean }) => call(`/api/admin/users/${id}`, send("PATCH", patch));
export const list = (parent?: number) => call<{ parent: Item | null; items: Item[] }>(`/api/files${parent ? `?parent=${parent}` : ""}`);
export const search = (q: string) => call<{ items: Item[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.items);
export const photos = (before?: string) => call<{ items: Item[]; next: string | null }>(`/api/photos${before ? `?before=${before}` : ""}`);
export const purge = (ids?: number[]) => call<{ purged: number; remaining: number }>("/api/trash/purge", send("POST", ids ? { ids } : {}));
export const trashed = () => call<{ items: Item[] }>("/api/trash");
export const mkdir = (name: string, parent?: number) => call<Item>("/api/folders", send("POST", { name, parent }));
export const rename = (id: number, name: string) => call(`/api/files/${id}`, send("PATCH", { name }));
export const move = (id: number, parent: number | null) => call(`/api/files/${id}`, send("PATCH", { parent }));
export const shares = (node: number) => call<{ items: Share[] }>(`/api/shares?node=${node}`).then((r) => r.items);
export const createShare = (node: number, days: number | null) => call<Share>("/api/shares", send("POST", { node, days }));
export const revokeShare = (id: number) => call(`/api/shares/${id}`, send("DELETE"));
export type Version = { id: number; size: number; mime: string; content_at: number };
export const versions = (id: number) => call<{ current: { size: number; content_at: number }; items: Version[] }>(`/api/files/${id}/versions`);
export const restoreVersion = (id: number, version: number) => call(`/api/files/${id}/versions/${version}/restore`, send("POST"));
export const versionUrl = (id: number, version: number) => `/api/files/${id}/versions/${version}`;
export const trash = (id: number) => call(`/api/files/${id}`, send("DELETE"));
export const restore = (id: number) => call(`/api/files/${id}/restore`, send("POST"));
export const thumbUrl = (id: number, changed: number) => `/api/files/${id}/thumb?v=${changed}`; // the address changes with the file, so a new version never shows the old picture
export const putThumb = (id: number, jpeg: Blob) => fetch(`/api/files/${id}/thumb`, { method: "PUT", body: jpeg, headers: { "content-type": "image/jpeg" } });
export const zipUrl = (ids: number[]) => `/api/zip?ids=${ids.join(",")}`;
export const zipCheck = (ids: number[]) => call<{ name: string; files: number; bytes: number }>(`/api/zip?ids=${ids.join(",")}&check=1`);
export const fileUrl = (id: number, download = false) => `/api/files/${id}${download ? "?download=1" : ""}`;

/** XHR rather than fetch because fetch cannot report upload progress. */
function put<T>(url: string, body: Blob, type: string, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("content-type", type);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status < 300) return resolve((x.responseText ? JSON.parse(x.responseText) : undefined) as T);
      let msg = `Upload failed (${x.status})`;
      try { msg = JSON.parse(x.responseText).error ?? msg; } catch {}
      reject(new HttpError(msg, x.status));
    };
    x.onerror = () => reject(new Error("Network error"));
    x.send(body);
  });
}

export async function retry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
}

export const uploadVersion = (id: number, file: File, onProgress: (fraction: number) => void) => put<Item>(`/api/files/${id}/content`, file, file.type || "application/octet-stream", onProgress);

const SINGLE_MAX = 8 * 1024 * 1024; // up to one part: a single request; bigger files go in parts the server can resume

/** Uploads a file; picking the same file again after a failure or reload resumes where it stopped. */
export async function upload(file: File, parent: number | undefined, onProgress: (fraction: number) => void): Promise<Item> {
  const mime = file.type || "application/octet-stream";
  const taken = Math.floor(file.lastModified / 1000); // the phone's own date for the photo; orders the Photos timeline
  if (file.size <= SINGLE_MAX) return put<Item>(`/api/files?name=${encodeURIComponent(file.name)}${parent ? `&parent=${parent}` : ""}&taken=${taken}`, file, mime, onProgress);
  const s = await call<{ id: string; partSize: number; parts: number[] }>("/api/uploads", send("POST", { name: file.name, parent, size: file.size, mime, taken }));
  const done = new Set(s.parts);
  for (let n = 1, start = 0; start < file.size; n++, start += s.partSize) {
    const part = file.slice(start, start + s.partSize);
    if (!done.has(n)) await retry(() => put(`/api/uploads/${s.id}/parts/${n}`, part, "application/octet-stream", (f) => onProgress((start + f * part.size) / file.size)));
    onProgress((start + part.size) / file.size);
  }
  return retry(() => call<Item>(`/api/uploads/${s.id}/complete`, send("POST")));
}

/** Like `upload`, but if the name is taken the file is saved as "name (1).ext", "name (2).ext", and so on. */
export async function uploadAvoidingClash(file: File, parent: number | undefined, onProgress: (fraction: number) => void): Promise<Item> {
  for (let n = 0; ; n++) {
    const f = n === 0 ? file : new File([file], file.name.replace(/(\.[^./]*)?$/, ` (${n})$1`), { type: file.type, lastModified: file.lastModified });
    try { return await upload(f, parent, onProgress); } catch (e) { if ((e as HttpError).status !== 409 || n >= 20) throw e; }
  }
}
