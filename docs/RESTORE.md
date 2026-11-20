# Backup and restore

## What is protected, and where

| Thing | Where it lives | Backup |
|---|---|---|
| File bytes, thumbnails, old versions | R2 bucket `cloud-files` | Copied to R2 bucket `cloud-backup` every night (03:47 UTC) |
| Names, folders, sharing, family list | D1 database `cloud` | D1 Time Travel (automatic, last 30 days on a paid plan, less on free) **and** a nightly dump `db/YYYY-MM-DD.json.gz` in `cloud-backup` (last 14 kept) |

How the backup behaves:

- **Copied once.** Stored objects are never overwritten (random keys), so each is copied once. First run: up to 300 objects per night; open **Admin > Back up now** a few times until "waiting" reaches 0.
- **Re-checked every night.** Each run re-checks 200 earlier copies (oldest check first). A copy that went missing or has the wrong size is copied again and the admin is warned. A whole library is re-checked over a few weeks.
- **Deleted items.** When something is purged from the trash (30 days after deleting it), its backup copy stays another **30 days**, then is removed. So a deleted file can be recovered from the app for 30 days, and from the backup bucket for 30 days after that. A copy of a file that still exists is never removed.
- **The admin is warned** with a red banner on the home screen if the backup has not run for 36 hours, had problems, or had to re-copy missing objects. Only admins see it.
- **Not covered:** objects over 4 GiB (shown as "too large to copy" on the Backup card), and the loss of the Cloudflare account itself (see "Off-site copy").

## 1. Files went missing from `cloud-files` (bug or bad delete)

Copy the backup objects back. Missing ones are restored; existing ones are left alone (`copy`, never `sync`).

```bash
# one-time: create R2 API credentials in the Cloudflare dashboard (R2 > Manage API tokens), then
rclone config   # type s3, provider Cloudflare, endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com, name: r2
rclone copy r2:cloud-backup/blobs  r2:cloud-files/blobs  --progress
rclone copy r2:cloud-backup/thumbs r2:cloud-files/thumbs --progress
```

A single object: `npx wrangler r2 object get cloud-backup/blobs/<key> --remote --file out.bin`, then `npx wrangler r2 object put cloud-files/blobs/<key> --remote --file out.bin`.

## 2. The database is damaged or wrong

Preferred: **D1 Time Travel**, to a moment before the damage.

```bash
npx wrangler d1 time-travel info cloud
npx wrangler d1 time-travel restore cloud --timestamp=<time before the damage, e.g. 2026-11-20T03:00:00Z>
```

If Time Travel is not enough (too old, or the database is gone), rebuild from the nightly dump:

```bash
npx wrangler r2 object get cloud-backup/db/2026-11-20.json.gz --remote --file dump.json.gz
node scripts/restore-db.mjs dump.json.gz > restore.sql
npx wrangler d1 execute DB --remote --file restore.sql
```

`restore.sql` first empties `users`, `nodes`, `versions` and `shares`, then re-inserts everything from the dump. Anything created after that dump is not in it (its files are still in the buckets). On a brand-new database run migrations first: `npx wrangler d1 migrations apply DB --remote`.

Rehearsed in `src/files.test.ts` ("the database can be rebuilt from the dump"): the rebuilt tables are identical to the originals.

## 3. Restore drill (do this once, about 10 minutes)

The automated tests prove the logic locally; this proves it on your real account. Use a throwaway file.

1. Upload `drill.txt` in the app. Open **Admin > Back up now**; wait until it says nothing is waiting and "failed" is 0 (or no problems banner).
2. Check the copy exists: `npx wrangler r2 object list cloud-backup --remote` should list the same number of `blobs/` objects as `cloud-files`.
3. Delete `drill.txt` in the app, then delete it again from the Trash view's source: simplest is to simulate loss by deleting its object from the main bucket: find the key in the Cloudflare dashboard (R2 > cloud-files) and delete it.
4. Restore it: `rclone copy r2:cloud-backup/blobs r2:cloud-files/blobs` (see section 1). Open the file in the app: it should download again.
5. Database part: `npx wrangler r2 object get cloud-backup/db/<today>.json.gz --remote --file dump.json.gz`, then `node scripts/restore-db.mjs dump.json.gz | head` and check that it lists your users and files. **Do not run it against the live database** unless you mean to.
6. Delete `drill.txt` from the app when done.

## 4. Rebuilding from scratch (account lost, or a fresh Cloudflare account)

The code is in GitHub. These are the things that are **not** in the code. Recreate them in this order:

1. **Domain:** `brocksville.com` must be on Cloudflare DNS (the Worker attaches `cloud.brocksville.com` as a custom domain on deploy).
2. **Zero Trust:** team name `brock-family` (Free plan, 50 seats), login method **One-time PIN**.
3. **Access application 1 ("Family Cloud"):** self-hosted, domain `cloud.brocksville.com`, no path, policy **Allow > Everyone**. Copy its **Application Audience (AUD) tag** and put it in `wrangler.jsonc` (`ACCESS_AUD`); it changes whenever the application is recreated. If the team name differs, change `TEAM_DOMAIN` too.
4. **Access application 2 ("share links"):** domain `cloud.brocksville.com`, path `s/*`, policy **Bypass > Everyone**. Without it public links ask for a login.
5. **API token:** Account > Workers Scripts: Edit, D1: Edit, Workers R2 Storage: Edit; Zone > Workers Routes: Edit and DNS: Edit for `brocksville.com`.
6. **GitHub secrets** (repo > Settings > Secrets and variables > Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_EMAIL` (the first admin).
7. Push to `main`. CI creates the D1 database and both R2 buckets (`cloud-files`, `cloud-backup`), applies migrations and deploys.
8. Restore the data: section 2 (database), then section 1 (files), from wherever your copy is.
9. **Billing alert:** Cloudflare dashboard > Notifications > Add > Billing / usage alert. Storage is kept twice, plus old versions and 30 more days of copies of deleted items.
10. Everyone on iPhone: delete the home-screen icon and add it again.

## 5. Off-site copy (recommended every few months)

```bash
rclone copy r2:cloud-backup /path/on/an/external/disk --progress
```

This is the only protection against losing the Cloudflare account. An automatic copy to another provider is possible but not built.
