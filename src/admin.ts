import type { User } from "./auth";
import { backup, backupStatus } from "./backup";
import { err, bodyOf } from "./files";

type Person = { id: number; email: string; role: "admin" | "member"; active: number; bytes: number };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PERSON = "select u.id, u.email, u.role, u.active, coalesce((select sum(size) from nodes n where n.owner_id = u.id), 0) + coalesce((select sum(v.size) from versions v join nodes n on n.id = v.node_id where n.owner_id = u.id), 0) as bytes from users u";

/** Family list and storage use. Admins only. Removing someone turns their access off; their files stay. */
export async function handleAdmin(req: Request, env: Env, user: User, url: URL): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/api\/admin(\/users(?:\/(\d+)(\/transfer)?)?|\/backup)?$/);
  if (!m) return undefined;
  if (user.role !== "admin") return err(403, "admins only");

  if (!m[1] && req.method === "GET") {
    const { results } = await env.DB.prepare(`${PERSON} order by u.id`).all<Person>();
    const family = await env.DB.prepare("select coalesce(sum(size), 0) + coalesce((select sum(v.size) from versions v join nodes n on n.id = v.node_id where n.owner_id is null), 0) as b from nodes where owner_id is null").first<{ b: number }>();
    return Response.json({ users: results, family_bytes: family!.b, total_bytes: results.reduce((t, u) => t + u.bytes, family!.b), backup: await backupStatus(env) });
  }

  if (m[1] === "/backup" && req.method === "POST") return Response.json(await backup(env));

  if (m[1] === "/users" && req.method === "POST") {
    const b = await bodyOf<{ email?: string; role?: string }>(req);
    const email = b.email?.trim().toLowerCase();
    if (!email || !EMAIL.test(email)) return err(400, "enter a valid email address");
    const role = b.role === "admin" ? "admin" : "member";
    await env.DB.prepare("insert into users (email, role) values (?, ?) on conflict (email) do update set active = 1, role = excluded.role").bind(email, role).run();
    return Response.json(await env.DB.prepare(`${PERSON} where u.email = ?`).bind(email).first<Person>(), { status: 201 });
  }

  // Hand a removed person's files to someone else: everything lands in one new folder, "Files from <email>", at the top of that person's files (or inside Family).
  if (m[3] && req.method === "POST") {
    const from = await env.DB.prepare("select id, email, active from users where id = ?").bind(Number(m[2])).first<{ id: number; email: string; active: number }>();
    if (!from) return err(404, "not found");
    if (from.active) return err(400, "remove their access first, then hand over their files");
    const b = await bodyOf<{ to?: number | "family" }>(req);
    let owner: number | null = null; // null = the Family space
    let parent: number | null = null;
    if (b.to === "family") {
      const root = await env.DB.prepare("select id from nodes where parent_id is null and owner_id is null and kind = 'folder' limit 1").first<{ id: number }>();
      if (!root) return err(500, "the Family folder is missing");
      parent = root.id;
    } else if (Number.isInteger(b.to)) {
      if (b.to === from.id) return err(400, "choose someone else");
      const to = await env.DB.prepare("select id, active from users where id = ?").bind(b.to).first<{ id: number; active: number }>();
      if (!to) return err(404, "that person does not exist");
      if (!to.active) return err(400, "that person has no access");
      owner = to.id;
    } else return err(400, 'choose a person, or "family"');
    const count = await env.DB.prepare("select count(*) c from nodes where owner_id = ?").bind(from.id).first<{ c: number }>();
    if (!count!.c) return Response.json({ moved: 0, folder: null });
    let folder = `Files from ${from.email}`;
    for (let i = 1; await env.DB.prepare("select 1 from nodes where ifnull(parent_id, 0) = ? and ifnull(owner_id, 0) = ? and name = ? collate nocase and trashed_at is null").bind(parent ?? 0, owner ?? 0, folder).first(); i++) folder = `Files from ${from.email} (${i})`;
    // One all-or-nothing step: make the folder, put their top level inside it, then give everything the new owner.
    await env.DB.batch([
      env.DB.prepare("insert into nodes (parent_id, owner_id, name, kind) values (?, ?, ?, 'folder')").bind(parent, owner, folder),
      env.DB.prepare("update nodes set parent_id = last_insert_rowid() where owner_id = ? and parent_id is null").bind(from.id),
      env.DB.prepare("update nodes set owner_id = ? where owner_id = ?").bind(owner, from.id),
    ]);
    return Response.json({ moved: count!.c, folder });
  }

  if (m[1] !== "/backup" && m[2] && !m[3] && req.method === "PATCH") {
    const id = Number(m[2]);
    const b = await bodyOf<{ role?: string; active?: boolean }>(req);
    if (id === user.id && (b.active === false || b.role === "member")) return err(400, "you cannot remove your own admin access");
    if (b.role !== undefined && b.role !== "admin" && b.role !== "member") return err(400, "role must be admin or member");
    const target = await env.DB.prepare("select id, role, active from users where id = ?").bind(id).first<{ role: string; active: number }>();
    if (!target) return err(404, "not found");
    await env.DB.prepare("update users set role = ?, active = ? where id = ?").bind(b.role ?? target.role, b.active === undefined ? target.active : b.active ? 1 : 0, id).run();
    return Response.json(await env.DB.prepare(`${PERSON} where u.id = ?`).bind(id).first<Person>());
  }
  return undefined;
}
