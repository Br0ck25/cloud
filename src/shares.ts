import type { User } from "./auth";
import { err, getNode } from "./files";

const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // 128 random bits

/** Manage public links for items the signed-in person can access. */
export async function handleShares(req: Request, env: Env, user: User, url: URL): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/api\/shares(?:\/(\d+))?$/);
  if (!m) return undefined;

  if (!m[1] && req.method === "GET") {
    const node = await getNode(env, user, Number(url.searchParams.get("node")));
    if (!node) return err(404, "not found");
    const { results } = await env.DB.prepare("select id, token, expires_at, created_at from shares where node_id = ? order by id desc").bind(node.id).all();
    return Response.json({ items: results });
  }

  if (!m[1] && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { node?: number; days?: number | null };
    const node = await getNode(env, user, b.node);
    if (!node || node.trashed_at) return err(404, "not found");
    if (b.days != null && !(Number.isInteger(b.days) && b.days >= 1 && b.days <= 365)) return err(400, "days must be 1 to 365, or null for no expiry");
    const token = newToken();
    const expires = b.days == null ? null : Math.floor(Date.now() / 1000) + b.days * 86400;
    const r = await env.DB.prepare("insert into shares (node_id, created_by, token, expires_at) values (?, ?, ?, ?)").bind(node.id, user.id, token, expires).run();
    return Response.json({ id: r.meta.last_row_id, token, expires_at: expires, created_at: Math.floor(Date.now() / 1000) }, { status: 201 });
  }

  if (m[1] && req.method === "DELETE") {
    const s = await env.DB.prepare("select node_id from shares where id = ?").bind(Number(m[1])).first<{ node_id: number }>();
    if (!s || !(await getNode(env, user, s.node_id))) return err(404, "not found");
    await env.DB.prepare("delete from shares where id = ?").bind(Number(m[1])).run();
    return new Response(null, { status: 204 });
  }
  return undefined;
}
