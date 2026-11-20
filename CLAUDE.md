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
- `migrations/` D1 SQL migrations (numbered, append-only)
- `docs/PLAN.md` plan

## Commands
- `npm run dev` local Worker with local R2/D1
- `npm run typecheck` regenerates binding types, then runs tsc
- Bindings live in `wrangler.jsonc`; rerun typecheck after editing it
