# Backup and restore

## What is protected, and where

| Thing | Where it lives | Backup |
|---|---|---|
| File bytes, thumbnails, old versions | R2 bucket `cloud-files` | Copied to R2 bucket `cloud-backup` every night (03:47 UTC) |
| Names, folders, sharing, family list | D1 database `cloud` | D1 Time Travel (automatic, last 30 days) **and** a nightly dump `db/YYYY-MM-DD.json.gz` in `cloud-backup` (last 14 kept) |

- Backups are **never deleted automatically**. When an item is purged from the trash, its backup copy stays (the admin page counts these as "kept after deletion"). Storage cost grows with it; prune by hand if it matters.
- Both buckets live in the same Cloudflare account. This protects against bugs, bad deletes and corrupted data. It does **not** protect against losing the account itself; for that, copy `cloud-backup` somewhere else now and then (see "Off-site copy").
- First run: the nightly job copies up to 300 objects per night. Open **Admin → Back up now** a few times until "waiting" reaches 0.
- Check **Admin** now and then: "Last run" should be within a day, "failed" should be 0.

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

If Time Travel is not enough (older than 30 days, or the database is gone), rebuild from the nightly dump:

```bash
npx wrangler r2 object get cloud-backup/db/2026-11-20.json.gz --remote --file dump.json.gz
node scripts/restore-db.mjs dump.json.gz > restore.sql
npx wrangler d1 execute DB --remote --file restore.sql
```

`restore.sql` first empties `users`, `nodes`, `versions` and `shares`, then re-inserts everything from the dump. Anything created after that dump is not in it (its files are still in the buckets). Run migrations first if the database is brand new: `npx wrangler d1 migrations apply DB --remote`.

Rehearsed in `src/files.test.ts` ("the database can be rebuilt from the dump"): the rebuilt tables are identical to the originals.

## 3. Off-site copy (recommended every few months)

```bash
rclone copy r2:cloud-backup /path/on/an/external/disk --progress
```

## One-time dashboard task: billing alert

Cloudflare dashboard > Notifications > Add > **Billing** (usage-based) alert for R2 storage. Storage is stored twice (files + backup) plus every old version and backup of deleted items, so watch it.
