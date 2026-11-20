export type Item = {
  id: number; parent_id: number | null; name: string; kind: "file" | "folder";
  size: number | null; mime: string | null; updated_at: number; shared: number; thumb: number; trashed_at?: number;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
const send = (method: string, body?: object): RequestInit => ({ method, body: body && JSON.stringify(body) });

export const me = () => call<{ email: string }>("/api/me");
export const list = (parent?: number) => call<{ parent: Item | null; items: Item[] }>(`/api/files${parent ? `?parent=${parent}` : ""}`);
export const trashed = () => call<{ items: Item[] }>("/api/trash");
export const mkdir = (name: string, parent?: number) => call("/api/folders", send("POST", { name, parent }));
export const rename = (id: number, name: string) => call(`/api/files/${id}`, send("PATCH", { name }));
export const trash = (id: number) => call(`/api/files/${id}`, send("DELETE"));
export const restore = (id: number) => call(`/api/files/${id}/restore`, send("POST"));
export const thumbUrl = (id: number) => `/api/files/${id}/thumb`;
export const putThumb = (id: number, jpeg: Blob) => fetch(`/api/files/${id}/thumb`, { method: "PUT", body: jpeg, headers: { "content-type": "image/jpeg" } });
export const fileUrl = (id: number, download = false) => `/api/files/${id}${download ? "?download=1" : ""}`;

/** XHR rather than fetch because fetch cannot report upload progress. */
export function upload(file: File, parent: number | undefined, onProgress: (fraction: number) => void): Promise<Item> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", `/api/files?name=${encodeURIComponent(file.name)}${parent ? `&parent=${parent}` : ""}`);
    x.setRequestHeader("content-type", file.type || "application/octet-stream");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status < 300) return resolve(JSON.parse(x.responseText));
      let msg = `Upload failed (${x.status})`;
      try { msg = JSON.parse(x.responseText).error ?? msg; } catch {}
      reject(new Error(msg));
    };
    x.onerror = () => reject(new Error("Network error"));
    x.send(file);
  });
}
