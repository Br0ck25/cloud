const TRASH_DAYS = 30; // how long deleted items stay recoverable
const UPLOAD_DAYS = 6; // R2 aborts unfinished multipart uploads after 7 days
const BATCH = 50; // trashed items handled per night; more wait for the next run

type Keys = { blob_key: string | null; thumb_key: string | null };

// The item and everything inside it.
const SUBTREE = "with recursive sub(id) as (select id from nodes where id = ? union all select n.id from nodes n join sub on n.parent_id = sub.id)";

/** Permanently removes one trashed item and everything under it. Storage goes first: if the database step fails, the next run retries; the other order would orphan files. */
export async function purgeNode(env: Env, id: number) {
  const { results } = await env.DB.prepare(
    `${SUBTREE} select blob_key, thumb_key from nodes where id in (select id from sub) union all select blob_key, thumb_key from versions where node_id in (select id from sub)`,
  ).bind(id).all<Keys>();
  const keys = results.flatMap((r) => [r.blob_key, r.thumb_key]).filter((k): k is string => !!k);
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000)); // R2 deletes up to 1000 keys per call
  await env.DB.batch([
    env.DB.prepare(`${SUBTREE} delete from shares where node_id in (select id from sub)`).bind(id),
    env.DB.prepare(`${SUBTREE} delete from versions where node_id in (select id from sub)`).bind(id),
    env.DB.prepare(`${SUBTREE} delete from nodes where id in (select id from sub)`).bind(id),
  ]);
}

/** Nightly: empty the old trash and drop abandoned large uploads. */
export async function cleanup(env: Env, now = Math.floor(Date.now() / 1000)) {
  const old = await env.DB.prepare("select id from nodes where trashed_at < ? order by trashed_at limit ?").bind(now - TRASH_DAYS * 86400, BATCH).all<{ id: number }>();
  for (const { id } of old.results) {
    try { await purgeNode(env, id); } catch (e) { console.error("purge failed for", id, e); }
  }

  const stale = await env.DB.prepare("select id, blob_key, upload_id from uploads where created_at < ? limit ?").bind(now - UPLOAD_DAYS * 86400, BATCH).all<{ id: string; blob_key: string; upload_id: string }>();
  for (const u of stale.results) {
    await env.FILES.resumeMultipartUpload(u.blob_key, u.upload_id).abort().catch(() => {}); // already gone is fine
    await env.DB.batch([env.DB.prepare("delete from upload_parts where upload_id = ?").bind(u.id), env.DB.prepare("delete from uploads where id = ?").bind(u.id)]);
  }
}
