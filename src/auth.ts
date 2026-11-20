export type User = { id: number; email: string; role: "admin" | "member" };

type Jwk = JsonWebKey & { kid: string };

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64(s)));

/** Returns the lower-cased email if the Access JWT is valid for this team and app, else null. */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
  getKeys: () => Promise<Jwk[]>,
): Promise<string | null> {
  try {
    const [h, p, s] = token.split(".");
    const header = json(h);
    const claims = json(p);
    const jwk = (await getKeys()).find((k) => k.kid === header.kid);
    if (header.alg !== "RS256" || !jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(s), new TextEncoder().encode(`${h}.${p}`));
    const auds: string[] = [].concat(claims.aud);
    if (!ok || claims.iss !== `https://${teamDomain}` || !auds.includes(aud) || claims.exp * 1000 < Date.now()) return null;
    return typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

let keyCache: { at: number; keys: Jwk[] } | undefined;
async function accessKeys(teamDomain: string): Promise<Jwk[]> {
  if (!keyCache || Date.now() - keyCache.at > 3600_000) {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    keyCache = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  }
  return keyCache.keys;
}

/** The signed-in family member, or a 401 (not signed in) / 403 (signed in but not on the list) Response. */
export async function requireUser(req: Request, env: Env): Promise<User | Response> {
  const dev: string = env.DEV_EMAIL; // only set via the gitignored .dev.vars or tests; "" in production, where it must stay empty
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  const email = dev ? (req.headers.get("x-dev-email") ?? dev).toLowerCase() : token && (await verifyAccessJwt(token, env.TEAM_DOMAIN, env.ACCESS_AUD, () => accessKeys(env.TEAM_DOMAIN)));
  const admin: string = env.ADMIN_EMAIL;
  if (!email) return new Response("Unauthorized", { status: 401 });
  if (admin && email === admin.toLowerCase()) {
    await env.DB.prepare("insert into users (email, role) values (?, 'admin') on conflict(email) do nothing").bind(email).run();
  }
  const user = await env.DB.prepare("select id, email, role from users where email = ?").bind(email).first<User>();
  return user ?? new Response("Forbidden", { status: 403 });
}
