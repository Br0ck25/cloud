import type { User } from "./auth";
import { err } from "./files";
import { zipBytes, zipStream, type ZipEntry } from "./zipwriter";

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 4 * 1024 ** 3 - 16 * 1024 ** 2; // one archive must stay under 4 GB; this leaves room for the headers and directory

type Root = { id: number; name: string; kind: "file" | "folder"; size: number | null; blob_key: string | null; updated_at: number };

/** GET /api/zip?ids=1,2,3 downloads those files and folders (folders with everything inside) as one ZIP. Add &check=1 to get the size or the reason it is refused, as JSON. */
export async function handleZip(req: Request, env: Env, user: User, url: URL): Promise<Response | undefined> {
  if (url.pathname !== "/api/zip" || req.method !== "GET") return undefined;
  const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number))];
  if (!ids.length || ids.length > 100 || !ids.every(Number.isInteger)) return err(400, "choose between 1 and 100 items");
  const { results: roots } = await env.DB.prepare(
    `select id, name, kind, size, blob_key, updated_at from nodes where id in (${ids.map(() => "?").join(",")}) and trashed_at is null and (owner_id = ? or owner_id is null) order by id`,
  ).bind(...ids, user.id).all<Root>();
  if (!roots.length) return err(404, "nothing to download");

  const used = new Set<string>();
  const unique = (name: string) => { let n = name, i = 0; while (used.has(n.toLowerCase())) n = name.replace(/(\.[^./]*)?$/, ` (${++i})$1`); used.add(n.toLowerCase()); return n; }; // two picked items can share a name: "same.png", "same (1).png"
  const entries: ZipEntry[] = [];
  for (const r of roots) {
    const top = unique(r.name);
    if (r.kind === "file") { entries.push({ path: top, dir: false, size: r.size ?? 0, mtime: r.updated_at, key: r.blob_key }); continue; }
    const { results } = await env.DB.prepare(
      `with recursive tree(id, path, kind, size, key, mtime) as (
         select id, ?, kind, size, blob_key, updated_at from nodes where id = ?
         union all select n.id, t.path || '/' || n.name, n.kind, n.size, n.blob_key, n.updated_at from nodes n join tree t on n.parent_id = t.id where n.trashed_at is null)
       select path, kind, size, key, mtime from tree order by path`,
    ).bind(top, r.id).all<{ path: string; kind: string; size: number | null; key: string | null; mtime: number }>();
    for (const t of results) entries.push({ path: t.path, dir: t.kind === "folder", size: t.size ?? 0, mtime: t.mtime, key: t.key });
    if (entries.length > MAX_ENTRIES) break;
  }
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  if (entries.length > MAX_ENTRIES || bytes > MAX_BYTES) return err(413, "That is more than one zip can hold (about 4 GB or 20,000 files). Download it in smaller parts.");

  const name = roots.length === 1 ? `${roots[0].name}.zip` : "Family Cloud.zip";
  if (url.searchParams.has("check")) return Response.json({ name, files: entries.filter((e) => !e.dir).length, bytes });
  return new Response(zipStream(zipBytes(entries, async (key) => (await env.FILES.get(key))?.body ?? null)), {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "cache-control": "no-store" },
  });
}
