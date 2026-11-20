import { requireUser } from "./auth";
import { handleFiles } from "./files";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      const row = await env.DB.prepare("select 1 as ok").first();
      return Response.json({ ok: row?.ok === 1 });
    }
    if (url.pathname.startsWith("/api/")) {
      const user = await requireUser(req, env);
      if (user instanceof Response) return user;
      if (url.pathname === "/api/me") return Response.json(user);
      const res = await handleFiles(req, env, user, url);
      if (res) return res;
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
