// App shell only: keeps the app opening when offline. API calls are never cached.
// Also receives files shared to the app from the phone's Share sheet and parks them for the page to pick up.
const CACHE = "shell-v1";
const INBOX = "share-inbox";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== INBOX).map((k) => caches.delete(k)))).then(() => clients.claim())));

async function receiveShare(req) {
  const files = (await req.formData()).getAll("files").filter((f) => typeof f !== "string");
  await caches.delete(INBOX);
  const inbox = await caches.open(INBOX);
  await Promise.all(files.map((f, i) => inbox.put(`/share-inbox/${i}`, new Response(f, { headers: { "content-type": f.type, "x-name": encodeURIComponent(f.name) } }))));
  return Response.redirect("/#/share", 303);
}

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === "POST" && u.pathname === "/share-target") return e.respondWith(receiveShare(e.request));
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/cdn-cgi/")) return; // sign-in and sign-out belong to Cloudflare
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/"))),
  );
});
