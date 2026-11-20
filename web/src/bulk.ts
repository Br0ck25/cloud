import * as api from "./api";

/** Runs one request per item, a few at a time. Returns the messages of the ones that failed. */
export async function each(ids: number[], run: (id: number) => Promise<unknown>, limit = 4): Promise<string[]> {
  const failed: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { await run(id); } catch (e) { failed.push((e as Error).message); }
    }
  }));
  return failed;
}

export const trashAll = (ids: number[]) => each(ids, api.trash);
export const restoreAll = (ids: number[]) => each(ids, api.restore);
export const moveAll = (ids: number[], to: number | null) => each(ids, (id) => api.move(id, to));

/** Delete forever, 100 at a time (what the server accepts per request). */
export async function purgeAll(ids: number[]): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    try { await api.purge(ids.slice(i, i + 100)); } catch (e) { failed.push((e as Error).message); }
  }
  return failed;
}

/** Empties the whole trash, however many items it holds. */
export async function emptyTrash(): Promise<string[]> {
  try {
    for (let r = await api.purge(); r.remaining > 0 && r.purged > 0; r = await api.purge());
    return [];
  } catch (e) { return [(e as Error).message]; }
}

/** A sentence about what went wrong, or "" when everything worked. */
export const report = (failed: string[], verb: string) =>
  failed.length ? `${failed.length} could not be ${verb}: ${[...new Set(failed)].slice(0, 2).join("; ")}` : "";
