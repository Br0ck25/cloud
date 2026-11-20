import { requireUser } from "./auth";
import { handleFiles } from "./files";
import { handleUploads } from "./uploads";
import { handleShares } from "./shares";
import { handlePublic } from "./public";
import { handleAdmin } from "./admin";
import { handleVersions } from "./versions";
import { cleanup } from "./cleanup";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      const row = await env.DB.prepare("select 1 as ok").first();
      return Response.json({ ok: row?.ok === 1 });
    }
    if (url.pathname.startsWith("/s/")) return handlePublic(req, env, url); // public links: no sign-in
    if (url.pathname.startsWith("/api/")) {
      const user = await requireUser(req, env);
      if (user instanceof Response) return user;
      if (url.pathname === "/api/me") return Response.json(user);
      const res = (await handleFiles(req, env, user, url)) ?? (await handleUploads(req, env, user, url)) ?? (await handleShares(req, env, user, url)) ?? (await handleVersions(req, env, user, url)) ?? (await handleAdmin(req, env, user, url));
      if (res) return res;
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
