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
| Auth | Cloudflare Access (free up to 50 users), email one-time PIN or Google login; Worker validates the JWT | no password code; adding a family member = adding an email to the policy |
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
2. **Schema + auth**: migration 0001, Access JWT middleware, `GET /api/me`, auto-create user row on first login. Check: no JWT → 401; valid → email returned. Also confirm the PWA/Access login behavior above.
3. **Files API**: create folder, single-PUT upload, list, download with Range, rename, move, trash/restore. Check: scripted curl round-trip, byte-for-byte compare.
4. **Web UI + PWA shell**: file browser, drag-drop and picker upload, image/pdf/video preview, manifest, service worker. Check: Playwright smoke test; Lighthouse installable.
5. **Large uploads**: multipart with progress and resume. Check: 500 MB file round-trips.
6. **Sharing**: Family root, per-person shares, link shares with expiry, Share Target. Check: link works logged out; expired link 404s.
7. **Search, versions, trash purge**: FTS5 name search, restore previous version, cron purge.
8. **Deploy**: custom domain, Access policy for family emails, D1 time-travel backups, optional periodic R2 export to a second bucket.

## Remaining questions (defaults in bold, I will proceed with these)
- Login method: **Google login plus email one-time PIN** (family members without Google can still get in).
- Per-user storage limits: **none**, just watch the R2 bill (first 10 GB free, then ~$0.015/GB-month).
- Does anyone need iPhone support? **Yes assumed; hence the in-app picker rather than relying on Share Target.**
