# Plan: Google Drive replacement on Cloudflare

## Assumptions (change any of these and the plan shifts)
- Start single-tenant (one person or small team), not a public multi-tenant SaaS.
- v1 = file storage, folders, sharing, search, web UI. Real-time docs/sheets editing is out of scope.
- Auth via Cloudflare Access (SSO/email OTP) in front of the app; public share links bypass it.

## Stack
| Need | Choice | Why |
|---|---|---|
| API | Worker (plain `fetch` router, add Hono only if routing gets painful) | one deployable |
| File bytes | R2 | cheap, no egress fees |
| Metadata (tree, shares, versions) | D1 (SQLite) | relational, transactional |
| Search | D1 FTS5 on names first; content search later via Queues + Workers AI/Vectorize | start cheap |
| Background work | Queues (thumbnails, indexing, trash purge via Cron Trigger) | later milestones |
| Frontend | Vite + React (or Svelte) served via Workers static assets | same deploy |
| Auth | Cloudflare Access JWT validated in Worker; `users` keyed by email | no password code |

## Key design points
- **Uploads**: files over ~100 MB can't pass through a Worker body. Use R2 multipart upload, with the browser sending parts through the Worker (or presigned S3-compat URLs direct to R2). Small files: single PUT.
- **Files are immutable objects in R2**, keyed by `blobs/<uuid>`. Names, folders and moves are D1-only, so rename/move is instant and versions are just extra blob rows.
- **Schema** (migrations/0001): `users`, `nodes(id, parent_id, owner_id, name, kind[file|folder], size, mime, blob_key, trashed_at, created_at, updated_at)`, `versions`, `shares(node_id, grantee|link_token, role, expires_at)`.
- **Download**: Worker streams from R2 with Range support; share links use `/s/<token>`.
- **Quotas/permissions**: checked in the Worker on every node operation; no client trust.

## Milestones (each ends with a runnable check)
1. **Skeleton** (done): Worker + R2 + D1 bindings, `/api/health`. Check: `npm run dev`, `curl /api/health`.
2. **Schema + auth**: migration 0001, Access JWT middleware, `GET /api/me`. Check: request without JWT → 401.
3. **Files API**: create folder, upload (single PUT), list, download (Range), rename, move, delete to trash. Check: scripted curl round-trip, byte-for-byte compare.
4. **Large uploads**: multipart + resume. Check: 500 MB file round-trips.
5. **Web UI**: file browser, drag-drop upload, preview (image/pdf/video). Check: Playwright smoke test.
6. **Sharing**: link shares with role and expiry, user shares. Check: link works logged out; expired link 404s.
7. **Search + trash + versions**: FTS5 name search, 30-day trash purge cron, restore previous version.
8. **Hardening/deploy**: custom domain, Access policy, backups (D1 time travel + R2 lifecycle), rate limits.

## Open product questions (defaults in bold)
- Users: **single-tenant, a handful of users** vs. open signup?
- Do you want in-browser document editing later (Office/Collabora/own editor)? **Not in v1.**
- Desktop/mobile sync clients? **Not in v1; web only (WebDAV could be a cheap later add).**
