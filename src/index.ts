import { requireUser } from "./auth";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/health") {
      const row = await env.DB.prepare("select 1 as ok").first();
      return Response.json({ ok: row?.ok === 1 });
    }
    if (pathname === "/api/me") {
      const user = await requireUser(req, env);
      return user instanceof Response ? user : Response.json(user);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
