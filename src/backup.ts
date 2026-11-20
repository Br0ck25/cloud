// Nightly copy of every stored object to a second bucket, plus a compressed dump of the database tables.
// Objects are never overwritten (keys are random ids), so "copied once" is enough. A copy outlives its original by PRUNE_DAYS, then it is removed.
// Each run also re-checks a batch of earlier copies and re-copies any that went missing.
const MAX_COPY = 300; // objects per run; more wait for the next run (or "Back up now")
const MAX_BYTES = 2 * 1024 ** 3;
const TOO_BIG = 4 * 1024 ** 3; // one R2 put is limited to 5 GiB
const BUDGET_MS = 25_000;
const KEEP_DUMPS = 14;
const PRUNE_DAYS = 30; // a backup copy is removed this long after its original is gone
const VERIFY_BATCH = 200; // earlier copies re-checked per run, oldest check first
const STALE_HOURS = 36;
const TABLES = ["users", "nodes", "versions", "shares"] as const;

const REFERENCED = "select blob_key k from nodes where blob_key is not null union select thumb_key from nodes where thumb_key is not null union select blob_key from versions union select thumb_key from versions where thumb_key is not null";

export type BackupStatus = { ran_at: number | null; files: number; bytes: number; waiting: number; kept_after_delete: number; failed: number; too_big: number; repaired: number };

export async function backupStatus(env: Env): Promise<BackupStatus> {
  const done = await env.DB.prepare("select count(*) c, coalesce(sum(size), 0) b from backed_up").first<{ c: number; b: number }>();
  const waiting = await env.DB.prepare(`select count(*) c from (${REFERENCED}) where k not in (select key from backed_up)`).first<{ c: number }>();
  const kept = await env.DB.prepare(`select count(*) c from backed_up where key not in (${REFERENCED})`).first<{ c: number }>();
  const run = await env.DB.prepare("select ran_at, failed, too_big, repaired from backup_status where id = 1").first<{ ran_at: number; failed: number; too_big: number; repaired: number }>();
  return { ran_at: run?.ran_at ?? null, files: done!.c, bytes: done!.b, waiting: waiting!.c, kept_after_delete: kept!.c, failed: run?.failed ?? 0, too_big: run?.too_big ?? 0, repaired: run?.repaired ?? 0 };
}

/** A sentence for the admin when the backup needs attention, otherwise null. */
export function warningFor(run: { ran_at: number; failed: number; repaired: number } | null, now = Date.now() / 1000): string | null {
  if (!run) return "The backup has not run yet.";
  if (now - run.ran_at > STALE_HOURS * 3600) return "The last backup was more than a day and a half ago.";
  if (run.failed > 0) return `${run.failed} problem${run.failed === 1 ? "" : "s"} in the last backup run.`;
  if (run.repaired > 0) return `${run.repaired} backup ${run.repaired === 1 ? "copy had" : "copies had"} gone missing and ${run.repaired === 1 ? "was" : "were"} copied again.`;
  return null;
}

export async function backupWarning(env: Env) {
  return warningFor(await env.DB.prepare("select ran_at, failed, repaired from backup_status where id = 1").first<{ ran_at: number; failed: number; repaired: number }>());
}

const inList = (keys: string[]) => `(${keys.map(() => "?").join(",")})`;
function* batches<T>(all: T[], size = 50) { for (let i = 0; i < all.length; i += size) yield all.slice(i, i + size); } // D1 allows 100 bound values per statement

/** Re-checks the least recently checked copies. A missing or wrong-sized copy is forgotten, so the copy step re-copies it; returns how many live ones had to be. */
async function verifyBatch(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(`select b.key, b.size, b.key in (${REFERENCED}) as live from backed_up b order by b.checked_at is not null, b.checked_at limit ?`).bind(VERIFY_BATCH).all<{ key: string; size: number; live: number }>();
  const good: string[] = [];
  let repaired = 0;
  for (const r of results) {
    try {
      const head = await env.BACKUP.head(r.key);
      if (head && head.size === r.size) { good.push(r.key); continue; }
      await env.DB.prepare("delete from backed_up where key = ?").bind(r.key).run();
      if (r.live) repaired++; // a missing copy of something already deleted is nothing to repair
    } catch (e) { if (/subrequest/i.test(String(e))) break; }
  }
  for (const part of batches(good)) await env.DB.prepare(`update backed_up set checked_at = unixepoch() where key in ${inList(part)}`).bind(...part).run();
  return repaired;
}

/** Marks copies whose original is gone, and removes those gone for PRUNE_DAYS. Storage first, then the rows, so a failure is retried. */
async function prune(env: Env, now: number) {
  await env.DB.prepare(`update backed_up set gone_at = unixepoch() where gone_at is null and key not in (${REFERENCED})`).run();
  await env.DB.prepare(`update backed_up set gone_at = null where gone_at is not null and key in (${REFERENCED})`).run();
  const { results } = await env.DB.prepare(`select key from backed_up where gone_at < ? and key not in (${REFERENCED}) limit 500`).bind(now - PRUNE_DAYS * 86400).all<{ key: string }>();
  for (const part of batches(results.map((r) => r.key))) {
    await env.BACKUP.delete(part);
    await env.DB.prepare(`delete from backed_up where key in ${inList(part)}`).bind(...part).run();
  }
}

async function dumpDatabase(env: Env) {
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t] = (await env.DB.prepare(`select * from ${t}`).all()).results;
  const gz = new Blob([JSON.stringify({ version: 1, at: new Date().toISOString(), tables })]).stream().pipeThrough(new CompressionStream("gzip"));
  await env.BACKUP.put(`db/${new Date().toISOString().slice(0, 10)}.json.gz`, await new Response(gz).arrayBuffer());
  const old = (await env.BACKUP.list({ prefix: "db/" })).objects.map((o) => o.key).sort().slice(0, -KEEP_DUMPS);
  if (old.length) await env.BACKUP.delete(old);
}

/** One backup pass: copy what is missing (within a budget), save the database dump, record the outcome. */
export async function backup(env: Env): Promise<BackupStatus> {
  const start = Date.now();
  let copied = 0, bytes = 0, failed = 0, tooBig = 0, repaired = 0;
  try { repaired = await verifyBatch(env); } catch (e) { failed++; console.error("backup verify failed", e); }
  const { results } = await env.DB.prepare(`select k from (${REFERENCED}) where k not in (select key from backed_up) order by k limit ?`).bind(MAX_COPY + 100).all<{ k: string }>();
  for (const { k } of results) {
    if (copied >= MAX_COPY || bytes >= MAX_BYTES || Date.now() - start > BUDGET_MS) break;
    try {
      const obj = await env.FILES.get(k);
      if (!obj) { failed++; console.error("referenced object is missing from storage:", k); continue; }
      if (obj.size > TOO_BIG) { await obj.body.cancel(); tooBig++; continue; }
      await env.BACKUP.put(k, obj.body, { httpMetadata: obj.httpMetadata });
      await env.DB.prepare("insert or replace into backed_up (key, size, at) values (?, ?, unixepoch())").bind(k, obj.size).run();
      copied++; bytes += obj.size;
    } catch (e) {
      failed++; console.error("backup failed for", k, e);
      if (/subrequest/i.test(String(e))) break; // out of requests for this run; the rest waits
    }
  }
  try { await prune(env, Math.floor(start / 1000)); } catch (e) { failed++; console.error("backup prune failed", e); }
  try { await dumpDatabase(env); } catch (e) { failed++; console.error("database dump failed", e); }
  await env.DB.prepare("insert into backup_status (id, ran_at, failed, too_big, repaired) values (1, unixepoch(), ?, ?, ?) on conflict (id) do update set ran_at = excluded.ran_at, failed = excluded.failed, too_big = excluded.too_big, repaired = excluded.repaired").bind(failed, tooBig, repaired).run();
  return backupStatus(env);
}
