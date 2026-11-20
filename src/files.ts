import type { User } from "./auth";

export type Node = {
  id: number; parent_id: number | null; owner_id: number | null; name: string; kind: "file" | "folder";
  size: number | null; mime: string | null; blob_key: string | null; thumb_key: string | null; content_at: number; trashed_at: number | null;
};

const MAX_THUMB = 300_000;
const MAX_UPLOAD = 100_000_000; // Worker request bodies stop at ~100 MB; bigger files need multipart (milestone 5)
const COLS = "id, parent_id, name, kind, size, mime, updated_at, owner_id is null as shared, thumb_key is not null as thumb";
// Only types a browser cannot run code from may open inline; everything else downloads.
const INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$)/;

export const err = (status: number, error: string) => Response.json({ error }, { status });
export const cleanName = (n: unknown) => (typeof n === "string" && /^[^/\0]{1,255}$/.test(n.trim()) && !/^\.\.?$/.test(n.trim()) ? n.trim() : null);

/** A node the user may touch: their own or in the Family space. Null if missing or not theirs. */
export const getNode = (env: Env, user: User, id: unknown) =>
  Number.isInteger(id)
    ? env.DB.prepare("select * from nodes where id = ? and (owner_id is null or owner_id = ?)").bind(id, user.id).first<Node>()
    : Promise.resolve(null);

export const item = (env: Env, id: number) => env.DB.prepare(`select ${COLS} from nodes where id = ?`).bind(id).first();

/** Resolves a parent folder id (null = the user's top level) to where a new node goes. */
export async function parentOf(env: Env, user: User, raw: unknown): Promise<{ id: number | null; owner: number | null } | Response> {
  if (raw == null || raw === "") return { id: null, owner: user.id };
  const p = await getNode(env, user, Number(raw));
  return p && p.kind === "folder" && !p.trashed_at ? { id: p.id, owner: p.owner_id } : err(404, "folder not found");
}

/** Runs a write; a duplicate name becomes a 409. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T | Response> {
  try { return await fn(); } catch (e) {
    if (/UNIQUE/.test(String(e))) return err(409, "an item with that name already exists here");
    throw e;
  }
}

export const insertFile = (env: Env, p: { id: number | null; owner: number | null }, name: string, size: number, mime: string, key: string) =>
  guarded(() => env.DB.prepare("insert into nodes (parent_id, owner_id, name, kind, size, mime, blob_key, content_at) values (?, ?, ?, 'file', ?, ?, ?, unixepoch())").bind(p.id, p.owner, name, size, mime, key).run());

const isFamilyRoot = (n: Node) => n.parent_id === null && n.owner_id === null;

/** Streams a file's bytes with Range support. Shared by signed-in downloads and public links. */
export async function serveFile(req: Request, env: Env, node: Node, download: boolean): Promise<Response> {
  if (node.kind !== "file" || !node.blob_key) return err(400, "not a file");
  const from = /^bytes=(\d+)-/.exec(req.headers.get("range") ?? "");
  if (from && Number(from[1]) >= (node.size ?? 0)) return err(416, "range not satisfiable");
  const obj = await env.FILES.get(node.blob_key, { range: req.headers });
  if (!obj) return err(404, "file data missing");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  const inline = INLINE.test(node.mime ?? "") && !download;
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(node.name)}`);
  const r = obj.range as { offset?: number; length?: number } | undefined;
  const start = r?.offset ?? 0;
  const length = r?.length ?? obj.size - start;
  const partial = start !== 0 || length !== obj.size; // R2 reports a range even when none was asked for
  headers.set("content-length", String(length));
  if (partial) headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
  return new Response(obj.body, { status: partial ? 206 : 200, headers });
}

export async function serveThumb(env: Env, node: Node): Promise<Response> {
  const obj = node.thumb_key && (await env.FILES.get(node.thumb_key));
  return obj ? new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } }) : err(404, "no thumbnail");
}

export async function handleFiles(req: Request, env: Env, user: User, url: URL): Promise<Response | undefined> {
  const { pathname, searchParams } = url;
  const m = pathname.match(/^\/api\/files(?:\/(\d+)(\/restore|\/thumb)?)?$/);
  const id = m?.[1] ? Number(m[1]) : null;

  if (pathname === "/api/folders" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { parent?: number; name?: string };
    const name = cleanName(body.name);
    if (!name) return err(400, "invalid name");
    const p = await parentOf(env, user, body.parent);
    if (p instanceof Response) return p;
    const r = await guarded(() => env.DB.prepare("insert into nodes (parent_id, owner_id, name, kind) values (?, ?, ?, 'folder')").bind(p.id, p.owner, name).run());
    return r instanceof Response ? r : Response.json(await item(env, r.meta.last_row_id), { status: 201 });
  }

  if (pathname === "/api/trash" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `select ${COLS}, trashed_at from nodes n where trashed_at is not null and (owner_id = ? or owner_id is null)
       and (parent_id is null or exists (select 1 from nodes p where p.id = n.parent_id and p.trashed_at is null)) order by trashed_at desc`,
    ).bind(user.id).all();
    return Response.json({ items: results });
  }

  if (pathname === "/api/search" && req.method === "GET") {
    const q = (searchParams.get("q") ?? "").trim();
    if (!q || q.length > 100) return err(400, "enter something to search for");
    // "dead" = everything in the trash plus everything inside trashed folders
    const { results } = await env.DB.prepare(
      `with recursive dead(id) as (select id from nodes where trashed_at is not null union all select n.id from nodes n join dead on n.parent_id = dead.id)
       select n.id, n.parent_id, n.name, n.kind, n.size, n.mime, n.updated_at, n.owner_id is null as shared, n.thumb_key is not null as thumb, p.name as folder
       from nodes n left join nodes p on p.id = n.parent_id
       where n.id not in (select id from dead) and (n.owner_id = ? or n.owner_id is null) and n.name like ? escape '\\'
       order by n.kind = 'file', n.name collate nocase limit 50`,
    ).bind(user.id, `%${q.replace(/[\\%_]/g, "\\$&")}%`).all();
    return Response.json({ items: results });
  }

  if (!m) return undefined;

  // /api/files: list a folder, or upload into one
  if (id === null) {
    if (req.method === "GET") {
      const raw = searchParams.get("parent");
      const p = await parentOf(env, user, raw);
      if (p instanceof Response) return p;
      const order = "order by kind = 'file', name collate nocase";
      const { results } = p.id === null
        ? await env.DB.prepare(`select ${COLS} from nodes where parent_id is null and trashed_at is null and (owner_id = ? or owner_id is null) ${order}`).bind(user.id).all()
        : await env.DB.prepare(`select ${COLS} from nodes where parent_id = ? and trashed_at is null ${order}`).bind(p.id).all();
      return Response.json({ parent: p.id === null ? null : await item(env, p.id), items: results });
    }
    if (req.method === "PUT") {
      const name = cleanName(searchParams.get("name"));
      if (!name) return err(400, "invalid name");
      if (!req.headers.has("content-length")) return err(411, "content-length required");
      const size = Number(req.headers.get("content-length"));
      if (size > MAX_UPLOAD) return err(413, "file too large for a single upload");
      const p = await parentOf(env, user, searchParams.get("parent"));
      if (p instanceof Response) return p;
      const mime = req.headers.get("content-type") || "application/octet-stream";
      const key = `blobs/${crypto.randomUUID()}`;
      await env.FILES.put(key, req.body, { httpMetadata: { contentType: mime } });
      const r = await insertFile(env, p, name, size, mime, key);
      if (r instanceof Response) { await env.FILES.delete(key); return r; }
      return Response.json(await item(env, r.meta.last_row_id), { status: 201 });
    }
    return undefined;
  }

  // /api/files/:id[/restore]
  const node = await getNode(env, user, id);
  if (!node) return err(404, "not found");

  if (m[2] === "/restore") {
    if (req.method !== "POST" || !node.trashed_at) return err(404, "not found");
    const parent = node.parent_id && (await env.DB.prepare("select trashed_at from nodes where id = ?").bind(node.parent_id).first<{ trashed_at: number | null }>());
    if (parent && parent.trashed_at) return err(409, "restore the parent folder first");
    const r = await guarded(() => env.DB.prepare("update nodes set trashed_at = null where id = ?").bind(node.id).run());
    return r instanceof Response ? r : Response.json(await item(env, node.id));
  }
  if (node.trashed_at) return err(404, "not found");

  if (m[2] === "/thumb") {
    if (req.method === "GET") return serveThumb(env, node);
    if (req.method === "PUT") {
      if (node.kind !== "file") return err(400, "not a file");
      if (req.headers.get("content-type") !== "image/jpeg") return err(400, "thumbnails must be image/jpeg");
      const len = Number(req.headers.get("content-length"));
      if (!req.headers.has("content-length")) return err(411, "content-length required");
      if (len > MAX_THUMB) return err(413, "thumbnail too large");
      const key = `thumbs/${crypto.randomUUID()}`;
      await env.FILES.put(key, req.body, { httpMetadata: { contentType: "image/jpeg" } });
      await env.DB.prepare("update nodes set thumb_key = ? where id = ?").bind(key, node.id).run();
      if (node.thumb_key) await env.FILES.delete(node.thumb_key);
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  if (req.method === "GET") return serveFile(req, env, node, searchParams.has("download"));

  if (isFamilyRoot(node)) return err(400, "the Family folder cannot be changed");

  if (req.method === "DELETE") {
    await env.DB.prepare("update nodes set trashed_at = unixepoch() where id = ?").bind(node.id).run();
    return new Response(null, { status: 204 });
  }

  if (req.method === "PATCH") {
    const body = (await req.json().catch(() => ({}))) as { name?: string; parent?: number | null };
    const name = "name" in body ? cleanName(body.name) : node.name;
    if (!name) return err(400, "invalid name");
    let parentId = node.parent_id;
    if ("parent" in body) {
      const p = await parentOf(env, user, body.parent);
      if (p instanceof Response) return p;
      if (p.owner !== node.owner_id) return err(400, "items cannot move between your files and the Family folder");
      // Moving a folder into itself or one of its own subfolders would orphan it.
      const loop = p.id !== null && (await env.DB.prepare(
        "with recursive up(id, parent_id) as (select id, parent_id from nodes where id = ? union all select n.id, n.parent_id from nodes n join up on n.id = up.parent_id) select 1 from up where id = ?",
      ).bind(p.id, node.id).first());
      if (loop) return err(400, "cannot move a folder into itself");
      parentId = p.id;
    }
    const r = await guarded(() => env.DB.prepare("update nodes set name = ?, parent_id = ?, updated_at = unixepoch() where id = ?").bind(name, parentId, node.id).run());
    return r instanceof Response ? r : Response.json(await item(env, node.id));
  }
  return undefined;
}
