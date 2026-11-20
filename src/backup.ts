// Nightly copy of every stored object to a second bucket, plus a compressed dump of the database tables.
// Objects are never overwritten (keys are random ids), so "copied once" is enough. Backups are kept even after the original is deleted.
const MAX_COPY = 300; // objects per run; more wait for the next run (or "Back up now")
const MAX_BYTES = 2 * 1024 ** 3;
const TOO_BIG = 4 * 1024 ** 3; // one R2 put is limited to 5 GiB
const BUDGET_MS = 25_000;
const KEEP_DUMPS = 14;
const TABLES = ["users", "nodes", "versions", "shares"] as const;

const REFERENCED = "select blob_key k from nodes where blob_key is not null union select thumb_key from nodes where thumb_key is not null union select blob_key from versions union select thumb_key from versions where thumb_key is not null";

export type BackupStatus = { ran_at: number | null; files: number; bytes: number; waiting: number; kept_after_delete: number; failed: number; too_big: number };

export async function backupStatus(env: Env): Promise<BackupStatus> {
  const done = await env.DB.prepare("select count(*) c, coalesce(sum(size), 0) b from backed_up").first<{ c: number; b: number }>();
  const waiting = await env.DB.prepare(`select count(*) c from (${REFERENCED}) where k not in (select key from backed_up)`).first<{ c: number }>();
  const kept = await env.DB.prepare(`select count(*) c from backed_up where key not in (${REFERENCED})`).first<{ c: number }>();
  const run = await env.DB.prepare("select ran_at, failed, too_big from backup_status where id = 1").first<{ ran_at: number; failed: number; too_big: number }>();
  return { ran_at: run?.ran_at ?? null, files: done!.c, bytes: done!.b, waiting: waiting!.c, kept_after_delete: kept!.c, failed: run?.failed ?? 0, too_big: run?.too_big ?? 0 };
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
  let copied = 0, bytes = 0, failed = 0, tooBig = 0;
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
  try { await dumpDatabase(env); } catch (e) { failed++; console.error("database dump failed", e); }
  await env.DB.prepare("insert into backup_status (id, ran_at, failed, too_big) values (1, unixepoch(), ?, ?) on conflict (id) do update set ran_at = excluded.ran_at, failed = excluded.failed, too_big = excluded.too_big").bind(failed, tooBig).run();
  return backupStatus(env);
}
