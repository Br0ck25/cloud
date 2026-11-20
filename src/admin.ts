import type { User } from "./auth";
import { err } from "./files";

type Person = { id: number; email: string; role: "admin" | "member"; active: number; bytes: number };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PERSON = "select u.id, u.email, u.role, u.active, coalesce((select sum(size) from nodes n where n.owner_id = u.id), 0) as bytes from users u";

/** Family list and storage use. Admins only. Removing someone turns their access off; their files stay. */
export async function handleAdmin(req: Request, env: Env, user: User, url: URL): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/api\/admin(\/users(?:\/(\d+))?)?$/);
  if (!m) return undefined;
  if (user.role !== "admin") return err(403, "admins only");

  if (!m[1] && req.method === "GET") {
    const { results } = await env.DB.prepare(`${PERSON} order by u.id`).all<Person>();
    const family = await env.DB.prepare("select coalesce(sum(size), 0) as b from nodes where owner_id is null").first<{ b: number }>();
    return Response.json({ users: results, family_bytes: family!.b, total_bytes: results.reduce((t, u) => t + u.bytes, family!.b) });
  }

  if (m[1] && !m[2] && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { email?: string; role?: string };
    const email = b.email?.trim().toLowerCase();
    if (!email || !EMAIL.test(email)) return err(400, "enter a valid email address");
    const role = b.role === "admin" ? "admin" : "member";
    await env.DB.prepare("insert into users (email, role) values (?, ?) on conflict (email) do update set active = 1, role = excluded.role").bind(email, role).run();
    return Response.json(await env.DB.prepare(`${PERSON} where u.email = ?`).bind(email).first<Person>(), { status: 201 });
  }

  if (m[2] && req.method === "PATCH") {
    const id = Number(m[2]);
    const b = (await req.json().catch(() => ({}))) as { role?: string; active?: boolean };
    if (id === user.id && (b.active === false || b.role === "member")) return err(400, "you cannot remove your own admin access");
    if (b.role !== undefined && b.role !== "admin" && b.role !== "member") return err(400, "role must be admin or member");
    const target = await env.DB.prepare("select id, role, active from users where id = ?").bind(id).first<{ role: string; active: number }>();
    if (!target) return err(404, "not found");
    await env.DB.prepare("update users set role = ?, active = ? where id = ?").bind(b.role ?? target.role, b.active === undefined ? target.active : b.active ? 1 : 0, id).run();
    return Response.json(await env.DB.prepare(`${PERSON} where u.id = ?`).bind(id).first<Person>());
  }
  return undefined;
}
