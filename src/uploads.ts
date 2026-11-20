import type { User } from "./auth";
import { err, cleanName, insertFile, item, parentOf, takenParam } from "./files";

// R2 needs every part except the last to be the same size (and at least 5 MiB), so the server fixes the size.
const PART_SIZE = 8 * 1024 * 1024;
const MAX_SIZE = 50 * 1024 ** 3;
const STALE = 6 * 86400; // R2 aborts unfinished multipart uploads after 7 days

type Session = { id: string; blob_key: string; upload_id: string; size: number; name: string; mime: string; parent_id: number | null; owner_id: number | null; taken_at: number | null; created_at: number };

const dropSession = (env: Env, id: string) =>
  env.DB.batch([env.DB.prepare("delete from upload_parts where upload_id = ?").bind(id), env.DB.prepare("delete from uploads where id = ?").bind(id)]);

const doneParts = async (env: Env, id: string) =>
  (await env.DB.prepare("select part, etag from upload_parts where upload_id = ? order by part").bind(id).all<{ part: number; etag: string }>()).results;

/** Large uploads: POST /api/uploads starts (or resumes) one, PUT .../parts/N sends a part, POST .../complete finishes. */
export async function handleUploads(req: Request, env: Env, user: User, url: URL): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/api\/uploads(?:\/([\w-]+)(?:\/(complete)|\/parts\/(\d+)))?$/);
  if (!m) return undefined;
  const [, id, complete, partNo] = m;

  if (!id) {
    if (req.method !== "POST") return undefined;
    const b = (await req.json().catch(() => ({}))) as { name?: string; parent?: number; size?: number; mime?: string; taken?: number };
    const name = cleanName(b.name);
    const size = b.size;
    if (!name) return err(400, "invalid name");
    if (!Number.isInteger(size) || size! <= 0 || size! > MAX_SIZE) return err(400, "invalid size");
    const p = await parentOf(env, user, b.parent);
    if (p instanceof Response) return p;
    const taken = await env.DB.prepare("select 1 from nodes where ifnull(parent_id, 0) = ? and ifnull(owner_id, 0) = ? and name = ? collate nocase and trashed_at is null").bind(p.id ?? 0, p.owner ?? 0, name).first();
    if (taken) return err(409, "an item with that name already exists here");

    let s = await env.DB.prepare("select * from uploads where user_id = ? and ifnull(parent_id, 0) = ? and name = ? and size = ?").bind(user.id, p.id ?? 0, name, size).first<Session>();
    if (s && s.created_at < Date.now() / 1000 - STALE) {
      await env.FILES.resumeMultipartUpload(s.blob_key, s.upload_id).abort().catch(() => {});
      await dropSession(env, s.id);
      s = null;
    }
    if (!s) {
      const mime = b.mime || "application/octet-stream";
      const key = `blobs/${crypto.randomUUID()}`;
      const mp = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
      s = { id: crypto.randomUUID(), blob_key: key, upload_id: mp.uploadId, size: size!, name, mime, parent_id: p.id, owner_id: p.owner, taken_at: takenParam(b.taken), created_at: 0 };
      await env.DB.prepare("insert into uploads (id, user_id, parent_id, owner_id, name, size, mime, blob_key, upload_id, taken_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(s.id, user.id, p.id, p.owner, name, size, mime, key, mp.uploadId, s.taken_at).run();
    }
    return Response.json({ id: s.id, partSize: PART_SIZE, parts: (await doneParts(env, s.id)).map((r) => r.part) });
  }

  const s = await env.DB.prepare("select * from uploads where id = ? and user_id = ?").bind(id, user.id).first<Session>();
  if (!s) return err(404, "upload not found");
  const count = Math.ceil(s.size / PART_SIZE);
  const mp = env.FILES.resumeMultipartUpload(s.blob_key, s.upload_id);

  if (partNo && req.method === "PUT") {
    const n = Number(partNo);
    const expected = n < count ? PART_SIZE : s.size - PART_SIZE * (count - 1);
    if (n < 1 || n > count) return err(400, "no such part");
    if (Number(req.headers.get("content-length")) !== expected) return err(400, `part ${n} must be exactly ${expected} bytes`);
    const { etag } = await mp.uploadPart(n, req.body!);
    await env.DB.prepare("insert into upload_parts (upload_id, part, etag) values (?, ?, ?) on conflict (upload_id, part) do update set etag = excluded.etag").bind(s.id, n, etag).run();
    return new Response(null, { status: 204 });
  }

  if (complete && req.method === "POST") {
    const parts = await doneParts(env, s.id);
    if (parts.length !== count) return err(409, `${count - parts.length} parts still missing`);
    await mp.complete(parts.map((r) => ({ partNumber: r.part, etag: r.etag })));
    const r = await insertFile(env, { id: s.parent_id, owner: s.owner_id }, s.name, s.size, s.mime, s.blob_key, s.taken_at);
    await dropSession(env, s.id);
    if (r instanceof Response) { await env.FILES.delete(s.blob_key); return r; }
    return Response.json(await item(env, r.meta.last_row_id), { status: 201 });
  }
  return undefined;
}
