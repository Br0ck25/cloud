import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { Item, Version } from "./api";
import { size } from "./format";
import { makeThumb } from "./thumb";

const date = (s: number) => new Date(s * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A file's history: save a new version (the old content is kept), download or restore an earlier one. */
export function VersionsSheet({ item, changed, close }: { item: Item; changed: () => void; close: () => void }) {
  const [data, setData] = useState<{ current: { size: number; content_at: number }; items: Version[] } | null>(null);
  const [note, setNote] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const load = () => api.versions(item.id).then(setData, (e) => setNote(e.message));
  useEffect(() => { load(); }, []);

  async function add(file: File) {
    setPct(0); setNote("");
    try {
      const saved = await api.uploadVersion(item.id, file, setPct);
      const jpeg = await makeThumb(file);
      if (jpeg) await api.putThumb(saved.id, jpeg);
      setNote("New version saved");
    } catch (e) { setNote((e as Error).message); }
    setPct(null); load(); changed();
  }
  const restore = (v: Version) => api.restoreVersion(item.id, v.id).then(() => { setNote("Version restored"); load(); changed(); }, (e) => setNote(e.message));

  return (
    <div class="modal" onClick={close}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Versions of "{item.name}"</h2>
        <label class="btn primary">Upload new version<input type="file" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) add(f); e.currentTarget.value = ""; }} /></label>
        {pct !== null && <progress value={pct} max={1} />}
        <ul class="list picker">
          {data && <li><span class="main"><span class="stack"><span class="name">Current</span><span class="meta">{date(data.current.content_at)} · {size(data.current.size)}</span></span></span></li>}
          {data?.items.map((v) => (
            <li key={v.id}>
              <span class="main"><span class="stack"><span class="name">{date(v.content_at)}</span><span class="meta">{size(v.size)}</span></span></span>
              <a class="btn" aria-label="Download this version" href={api.versionUrl(item.id, v.id)}>↓</a>
              <button class="btn" onClick={() => restore(v)}>Restore</button>
            </li>
          ))}
          {data && !data.items.length && <li class="empty">No earlier versions yet. Upload a new version to keep today's content as history.</li>}
        </ul>
        {note && <p class="meta wrap" role="status">{note}</p>}
        <div class="row"><button class="btn" onClick={close}>Done</button></div>
      </div>
    </div>
  );
}
