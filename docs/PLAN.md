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
4. **Web UI + PWA shell** (done, tested in a browser locally): Preact + Vite in `web/`, built to `dist/` and served by the Worker as static assets. Folder browsing (hash routes), upload with progress and drag-drop, preview (image/video/audio/pdf), rename, delete, trash/restore, installable manifest + icons, app-shell service worker. Theme: "Slate" light/dark (cool gray, white cards, blue accent `#2563eb`; tokens at the top of `web/src/style.css`). Thumbnails: made in the browser after upload (320px JPEG; video = a frame), stored as `thumbs/<uuid>` via `PUT /api/files/:id/thumb`; milestone 7's purge must delete `thumb_key` blobs too. Deferred: move-folder picker, photo grid view, Share Target (milestone 6). Still to confirm on real devices: installing from the phone keeps the Access login.
5. **Large uploads** (done, tested locally): files over 8 MiB go as R2 multipart in 8 MiB parts (`src/uploads.ts`, `migrations/0004_uploads.sql`). The server remembers finished parts per person+folder+name+size, so re-picking the same file after a failure or reload resumes it; each part retries 5 times with backoff, progress covers the whole file, and the screen wake lock keeps a phone from suspending the upload. Max 50 GB. Checked: 500 MiB round-trip with matching sha256, retry after a dropped part, resume after reload sending only missing parts. Not yet tested against real R2 and real Workers limits. Milestone 7's cron must also delete `uploads` rows older than 6 days (R2 aborts the matching multipart upload after 7).
6. **Sharing + moving** (in progress, deployed in steps):
   - 6a. (done, deployed) Move screen (`web/src/Picker.tsx`): move any file or folder into any folder at any depth, including inside Family. Items cannot cross between your files and Family. Done.
   - 6b. (done, tested locally; needs the Access bypass for `/s/*` before it works for logged-out people) Link shares: public download-only links for a file or folder at `/s/<token>`, with expiry (1 day / 7 days / 30 days / never) and revoke, managed from the item's menu. Links are server-rendered HTML (no JS, CSS inlined from the app build) so they need no Access login. The token is stored as-is (not hashed) so the share dialog can show the link again; the database is not publicly reachable.
   - 6c. (done, tested with a simulated Share-sheet POST in Chromium; not on a real Android phone) Share Target: send photos and files from the phone's Share sheet into the app (Android; iOS does not support it) and pick the destination folder (your files or Family) with the same Picker. The service worker parks shared files in the `share-inbox` cache; the app saves them to the chosen folder and clears the cache. Also: account menu with Sign out (`/cdn-cgi/access/logout`), and manifest `theme_color`/`background_color` now match the page background so iOS no longer paints a blue bar under the home indicator (re-add to Home Screen to pick it up).
   - Dropped from v1: per-person shares. Private files live in your own space; anything for everyone goes under Family (open to all members to read and edit; a member's folder under Family is not private).
7. **Admin, search, versions, cleanup** (in progress, deployed in steps):
   - 7a. (done) Admin page `#/admin` (admins only, from the account menu): add a family member by email, remove or restore their access (their files stay and still count), make admin or member, total/Family/per-person storage. `src/admin.ts`, `migrations/0006_user_active.sql`. Backup status joins this page in milestone 8.
   - 7b. (done) Search by file name: plain case-insensitive substring match, not FTS5 (FTS5 tables break D1 export and add triggers; revisit if it gets slow). Searches your files plus Family, skips the trash and anything inside trashed folders, max 50 results, each shows its folder.
   - 7c. Versions: upload a new version of a file, list versions, restore an older one (last 10 kept).
   - 7d. Nightly cron: purge trash older than 30 days (R2 blobs, thumbnails, versions, shares) and abandoned uploads older than 6 days.
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
