import { serveFile, serveThumb, type Node } from "./files";

// Public link pages: plain server-rendered HTML, no scripts, no sign-in. The app's stylesheet is inlined so they match the theme.
const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "cache-control": "private, no-store",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const size = (n: number | null) => (n == null ? "" : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(1)} GB`);
const icon = (n: Pick<Node, "kind" | "mime">) => (n.kind === "folder" ? "📁" : n.mime?.startsWith("image/") ? "🖼️" : n.mime?.startsWith("video/") ? "🎬" : n.mime?.startsWith("audio/") ? "🎵" : "📄");

let css: string | undefined;
async function appCss(env: Env): Promise<string> {
  if (css === undefined) {
    const html = await (await env.ASSETS.fetch("https://assets.local/")).text();
    const href = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    css = href ? await (await env.ASSETS.fetch(`https://assets.local${href}`)).text() : "";
  }
  return css;
}

/** Is `id` the shared item itself or inside it, with nothing on the way trashed? */
const inShare = (env: Env, root: number, id: number) =>
  env.DB.prepare(
    "with recursive up(id, parent_id) as (select id, parent_id from nodes where id = ? and trashed_at is null union all select n.id, n.parent_id from nodes n join up on n.id = up.parent_id where n.trashed_at is null) select 1 from up where id = ?",
  ).bind(id, root).first();

export async function handlePublic(req: Request, env: Env, url: URL): Promise<Response> {
  const m = url.pathname.match(/^\/s\/([\w-]{16,64})(?:\/([dft])\/(\d+))?$/);
  if (!m || (req.method !== "GET" && req.method !== "HEAD")) return NOT_FOUND();
  const [, token, view, rawId] = m;
  const share = await env.DB.prepare("select node_id from shares where token = ? and (expires_at is null or expires_at > unixepoch())").bind(token).first<{ node_id: number }>();
  if (!share) return NOT_FOUND();
  const id = rawId ? Number(rawId) : share.node_id;
  if (!(await inShare(env, share.node_id, id))) return NOT_FOUND();
  const node = await env.DB.prepare("select * from nodes where id = ?").bind(id).first<Node>();
  if (!node) return NOT_FOUND();

  if (view === "f") return node.kind === "file" ? serveFile(req, env, node, url.searchParams.has("download")) : NOT_FOUND();
  if (view === "t") return serveThumb(env, node);

  const base = `/s/${token}`;
  const up = id === share.node_id ? "" : `<a href="${node.parent_id === share.node_id ? base : `${base}/d/${node.parent_id}`}">←</a> `;
  let body: string;
  if (node.kind === "folder") {
    const { results } = await env.DB.prepare("select id, name, kind, size, mime, thumb_key is not null as thumb from nodes where parent_id = ? and trashed_at is null order by kind = 'file', name collate nocase").bind(id).all<Node & { thumb: number }>();
    const rows = results.map((c) => {
      const tile = c.thumb ? `<img src="${base}/t/${c.id}" alt="">` : icon(c);
      const href = c.kind === "folder" ? `${base}/d/${c.id}` : `${base}/f/${c.id}`;
      return `<li><a class="main" href="${href}"><span class="tile">${tile}</span><span class="name">${esc(c.name)}</span></a><span class="meta">${size(c.size)}</span></li>`;
    });
    body = `<ul class="list">${rows.join("") || '<li class="empty">This folder is empty.</li>'}</ul>`;
  } else {
    const src = `${base}/f/${id}`;
    const mime = node.mime ?? "";
    const preview = mime.startsWith("image/") && !mime.startsWith("image/svg") ? `<img src="${src}" alt="">`
      : mime.startsWith("video/") ? `<video src="${src}" controls></video>`
      : mime.startsWith("audio/") ? `<audio src="${src}" controls></audio>` : "";
    body = `${preview ? `<div class="view">${preview}</div>` : ""}<div class="bar"><a class="btn primary" href="${src}?download=1">Download</a><span class="meta">${size(node.size)}</span></div>`;
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(node.name)}</title><style>${await appCss(env)}</style></head><body><div class="page"><header><h1>${up}${esc(node.name)}</h1></header>${body}</div></body></html>`;
  return new Response(req.method === "HEAD" ? null : html, { headers: HEADERS });
}
