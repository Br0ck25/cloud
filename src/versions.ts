import type { User } from "./auth";
import { err, getNode, item, serveFile } from "./files";

const KEEP = 10; // earlier versions kept per file
const MAX_VERSION = 100_000_000; // new versions go up in one request, like small uploads

type Version = { id: number; blob_key: string; thumb_key: string | null; size: number; mime: string; content_at: number };

/** Upload a new version of a file, list earlier ones, download or restore one. The file keeps its name and place. */
export async function handleVersions(req: Request, env: Env, user: User, url: URL): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/api\/files\/(\d+)\/(content|versions(?:\/(\d+)(\/restore)?)?)$/);
  if (!m) return undefined;
  const node = await getNode(env, user, Number(m[1]));
  if (!node || node.trashed_at) return err(404, "not found");
  if (node.kind !== "file" || !node.blob_key) return err(400, "not a file");

  // Putting the current content aside as a version is the same step in both directions.
  const keepCurrent = env.DB.prepare("insert into versions (node_id, blob_key, thumb_key, size, mime, content_at) values (?, ?, ?, ?, ?, ?)")
    .bind(node.id, node.blob_key, node.thumb_key, node.size, node.mime, node.content_at);

  if (m[2] === "content" && req.method === "PUT") {
    if (!req.headers.has("content-length")) return err(411, "content-length required");
    const size = Number(req.headers.get("content-length"));
    if (size > MAX_VERSION) return err(413, "new versions are limited to 100 MB for now");
    const mime = req.headers.get("content-type") || "application/octet-stream";
    const key = `blobs/${crypto.randomUUID()}`;
    await env.FILES.put(key, req.body, { httpMetadata: { contentType: mime } });
    await env.DB.batch([
      keepCurrent,
      env.DB.prepare("update nodes set blob_key = ?, thumb_key = null, size = ?, mime = ?, content_at = unixepoch(), updated_at = unixepoch() where id = ?").bind(key, size, mime, node.id),
    ]);
    const { results: extra } = await env.DB.prepare("select id, blob_key, thumb_key from versions where node_id = ? order by id desc limit -1 offset ?").bind(node.id, KEEP).all<Version>();
    if (extra.length) {
      await env.DB.batch(extra.map((v) => env.DB.prepare("delete from versions where id = ?").bind(v.id)));
      await env.FILES.delete(extra.flatMap((v) => (v.thumb_key ? [v.blob_key, v.thumb_key] : [v.blob_key])));
    }
    return Response.json(await item(env, node.id));
  }

  if (!m[3] && m[2] === "versions" && req.method === "GET") {
    const { results } = await env.DB.prepare("select id, size, mime, content_at from versions where node_id = ? order by id desc").bind(node.id).all();
    return Response.json({ current: { size: node.size, mime: node.mime, content_at: node.content_at }, items: results });
  }

  if (m[3]) {
    const v = await env.DB.prepare("select * from versions where id = ? and node_id = ?").bind(Number(m[3]), node.id).first<Version>();
    if (!v) return err(404, "version not found");
    if (!m[4] && req.method === "GET") return serveFile(req, env, { ...node, blob_key: v.blob_key, size: v.size, mime: v.mime }, true);
    if (m[4] && req.method === "POST") {
      await env.DB.batch([
        keepCurrent,
        env.DB.prepare("update nodes set blob_key = ?, thumb_key = ?, size = ?, mime = ?, content_at = ?, updated_at = unixepoch() where id = ?").bind(v.blob_key, v.thumb_key, v.size, v.mime, v.content_at, node.id),
        env.DB.prepare("delete from versions where id = ?").bind(v.id),
      ]);
      return Response.json(await item(env, node.id));
    }
  }
  return undefined;
}
