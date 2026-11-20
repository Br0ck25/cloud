# Plan: family Google Drive replacement on Cloudflare

## Scope (decided)
- Domain: `cloud.brocksville.com` (Worker custom domain + Access app on the same hostname).
- Personal project for a few family members (~5 users). Not multi-tenant, no signup flow, no billing.
- Web only, delivered as an installable **PWA** (phone home-screen + desktop). No native or sync clients.
- v1 = files, folders, sharing, search, trash, phone photo/file upload. No in-browser document editing.

## Stack
| Need | Choice | Why |
|---|---|---|
| API | Worker, plain `fetch` router | one deployable; add Hono only if routing gets painful |
| File bytes | R2 | cheap, no egress fees |
| Metadata | D1 (SQLite) | relational, transactional |
| Auth | Cloudflare Access proves identity (Google or email PIN); Worker validates the JWT and checks the email against an allowlist in D1 | no password code; family list is managed in the app, not the dashboard |
| Frontend | Vite + Preact/React, served by Workers static assets | same deploy, small bundle |
| PWA | `manifest.webmanifest` + small service worker | installable, app-shell offline |
| Search | D1 FTS5 on file names | enough for family-sized data |
| Cleanup | Cron Trigger purges trash after 30 days | no Queues needed at this scale |

Dropped from the earlier plan: Queues, Vectorize/Workers AI content search, quotas, rate limiting. Add only if a real need shows up.

## PWA specifics
- **Installable**: manifest with icons, `display: standalone`, HTTPS (free on Workers).
- **Service worker**: cache the app shell only. Caching file listings or blobs offline is later and optional. API responses are never served stale.
- **Web Share Target**: lets the phone's Share sheet send photos/files straight into the app (works on Android Chrome; iOS Safari does not support it, so iOS uses the in-app picker).
- **Upload from phone**: `<input type=file multiple accept="image/*,video/*">` for camera roll. Uploads run in the page; a service-worker background sync is not reliable on iOS, so large uploads need the app open. Show progress and allow resume.
- **Auth caveat**: Access redirects to a login page, which can confuse a PWA shell. Verify an installed PWA keeps its Access session on iOS and Android during milestone 2.

## Key design points
- **Uploads**: bodies through a Worker are limited to ~100 MB, so use R2 multipart; the browser sends parts via the Worker. Small files use one PUT.
- **Immutable blobs**: R2 keys are `blobs/<uuid>`. Names, folders and moves live only in D1, so rename/move is instant and a version is just an extra blob row.
- **Schema** (`migrations/0001`): `users(id, email, name, role)`, `nodes(id, parent_id, owner_id, name, kind, size, mime, blob_key, trashed_at, created_at, updated_at)`, `shares(node_id, user_id | link_token, role, expires_at)`.
- **Permissions**: simple model. Each user has a private root plus a shared "Family" root visible to all. Per-node shares to a specific person or by link (`/s/<token>`, no login) on top.
- **Download/preview**: Worker streams from R2 with Range support (needed for video seeking). Thumbnails for images are generated in the browser at upload time and stored as a second blob, so no server-side image pipeline.

## Milestones (each ends with a runnable check)
1. **Skeleton** (done). `npm run dev`, `curl /api/health`.
2. **Users + auth** (done, untested against real Cloudflare): `migrations/0001_users.sql`, Access JWT check in `src/auth.ts`, `GET /api/me`, CI deploy workflow. Only `ADMIN_EMAIL` is auto-created; everyone else must be added by an admin. Still to confirm after first deploy: the PWA keeps its Access session on iOS/Android.
3. **Files API** (done, tested locally): folders, single-PUT upload (max 100 MB), list, download with Range, rename, move, trash/restore, trash list. `migrations/0002_nodes.sql`, `src/files.ts`. Spaces: each node is owned by one person or by the shared Family space (`owner_id` null); children inherit the owner and nothing moves between spaces. Duplicate names in a folder are rejected (409). `npm test` starts a real local Worker and exercises the routes. Per-person and link shares are milestone 6.
4. **Web UI + PWA shell**: file browser, drag-drop and picker upload, image/pdf/video preview, manifest, service worker. Check: Playwright smoke test; Lighthouse installable.
5. **Large uploads**: multipart with progress and resume. Check: 500 MB file round-trips.
6. **Sharing**: Family root, per-person shares, link shares, Share Target. Check: link works logged out; expired/revoked link 404s.
7. **Admin page + search + versions**: admin-only page (add/remove family emails, storage used, backup status), FTS5 name search, restore previous version, trash purge cron.
8. **Backup + deploy hardening**: nightly copy to second bucket, billing alert, Access exemption for `/s/*` only. Check: delete a blob from primary, restore from backup.

## Decisions
- **Backup**: nightly Cron copies new blobs (`blobs.backed_up_at is null`, batched per run) from `cloud-files` to `cloud-backup`. Same Cloudflare account, so this protects against bugs and bad deletes, not account loss. Deletes in primary do not delete from backup until a later manual prune.
- **Uploads**: resumable R2 multipart with progress; on iPhone the app must stay open until done.
- **Originals kept as-is**, HEIC included. No transcoding. Thumbnails are generated in the browser at upload; if the browser cannot decode a format (HEIC on non-Safari) show a generic icon and offer download.
- **Link sharing**: download-only (no upload links in v1), 128-bit random token stored hashed, revocable from the share dialog, default expiry 7 days with "never" as an option. Only `/s/*` bypasses Access; the Worker serves nothing else unauthenticated.
- **Admin**: first admin is set by an `ADMIN_EMAIL` var; admins add/remove emails and roles in an in-app page. Access is set to allow any authenticated identity and the Worker enforces the allowlist, so unknown emails get 403. Tradeoff: strangers can request a PIN email but get nothing.
- **Cost guardrail**: storage total shown on the admin page; a Cloudflare billing alert is set once in the dashboard.

## Deploy (nothing run from your computer)
- GitHub Actions: on push to `main`, `wrangler d1 migrations apply` then `wrangler deploy`. Pull requests run typecheck only.
- Needs three GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Workers, D1, R2 edit) and `CLOUDFLARE_ACCOUNT_ID`, plus `ADMIN_EMAIL` (the first admin's email, kept out of the repo).
- CI creates the D1 database and R2 bucket if missing and substitutes the real D1 id for `REPLACE_DB_ID` before migrating and deploying (nothing secret is committed).
- Custom domain `cloud.brocksville.com` via `routes` with `custom_domain: true` in `wrangler.jsonc` (requires `brocksville.com` on Cloudflare DNS).
- One-time dashboard clicks (no CLI): create the API token, create the Access application for `cloud.brocksville.com` with a bypass for `/s/*`, set the billing alert.
