# Cloud — a Google Drive replacement on Cloudflare

Read `docs/PLAN.md` for architecture and milestones.

## Working rules
1. Think before coding. State assumptions. If two readings would change what the user sees, say so or ask.
2. Simplicity first. Minimum code that solves the problem. No unrequested features, no single-use abstractions, no configurability nobody asked for.
3. Surgical changes. Touch only what the task needs; match existing style; every changed line traces to the request.
4. Goal-driven. Turn each task into a check you can run (test, curl, typecheck) and loop until it passes. Never skip or loosen a test to get green.
5. Ask only about product decisions; decide technical choices yourself and say what you chose.
6. No source file over 2,000 lines. Split by job first.
7. One implementation per job: look for an existing helper before writing one; no new library when the platform already does it.

## Layout
- `src/index.ts` Worker entry and routing
- `src/auth.ts` Access JWT check and `requireUser` (use it in every authenticated route)
- `src/files.ts` files API (`handleFiles`): list, upload, download, rename/move, trash
- `web/` the PWA (Preact + Vite): `src/App.tsx` screens, `src/api.ts` all server calls, `src/thumb.ts` browser thumbnails, `src/BackupSheet.tsx` phone photo backup, `src/Viewer.tsx` swipeable preview, `src/style.css` theme tokens (all colors live only there; read `docs/DESIGN.md` before touching any UI), `public/` manifest, service worker, icons
- `src/uploads.ts` large resumable uploads (multipart), used for files over 8 MiB
- `src/admin.ts` admin API (admins only: family list, access, storage use)
- `src/versions.ts` new versions, history, restore (max 10 kept per file)
- `src/cleanup.ts` nightly cron: purge old trash and abandoned uploads
- `src/backup.ts` nightly copy to the backup bucket + database dump; `scripts/restore-db.mjs` rebuilds the database from a dump (`docs/RESTORE.md`)
- `src/shares.ts` manage public links (signed in); `src/public.ts` the public `/s/<token>` pages (no sign-in, no scripts)
- `migrations/` D1 SQL migrations (numbered, append-only)
- `docs/PLAN.md` plan

## Commands
- `npm run dev` builds the UI, then runs the Worker with local R2/D1 (rebuild after UI edits)
- `npm run build` builds `web/` into `dist/` (gitignored; CI builds before deploy)
- `npm test` builds the UI, then runs all tests (`node --test`; API tests start a local Worker)
- Local login: put `DEV_EMAIL=you@example.com` and `ADMIN_EMAIL=you@example.com` in `.dev.vars` (gitignored), run `wrangler d1 migrations apply DB --local`
- `npm run typecheck` regenerates binding types, then runs tsc
- Bindings live in `wrangler.jsonc`; rerun typecheck after editing it
