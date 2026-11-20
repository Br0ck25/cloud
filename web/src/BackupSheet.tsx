import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import { makeThumb } from "./thumb";

const ROOT = "Camera backup"; // in My files; photos go in a subfolder per year
type Dest = { id: number; have: Set<string> }; // what that folder already holds, as "name|size"
const key = (name: string, size: number | null) => `${name.toLowerCase()}|${size}`;

/** Backs up the chosen photos and videos. Files already in the folder (same name and size) are skipped, so running it again only sends what is new. */
export function BackupSheet({ files, changed, close }: { files: File[]; changed: () => void; close: () => void }) {
  const [running, setRunning] = useState(true);
  const [counts, setCounts] = useState({ done: 0, skipped: 0 });
  const [failed, setFailed] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [pct, setPct] = useState(0);
  const stop = useRef(false);

  useEffect(() => {
    (async () => {
      const awake = await navigator.wakeLock?.request("screen").catch(() => null); // keeps a phone from suspending the upload
      const folders = new Map<string, Dest>();
      const find = async (name: string, parent?: number) => {
        const found = (await api.list(parent)).items.find((i) => i.kind === "folder" && i.name.toLowerCase() === name.toLowerCase());
        return found ?? (await api.mkdir(name, parent));
      };
      const destFor = async (year: string): Promise<Dest> => {
        let d = folders.get(year);
        if (!d) {
          const root = await find(ROOT);
          const folder = await find(year, root.id);
          d = { id: folder.id, have: new Set((await api.list(folder.id)).items.map((i) => key(i.name, i.size))) };
          folders.set(year, d);
        }
        return d;
      };
      let done = 0, skipped = 0;
      for (const f of files) {
        if (stop.current) break;
        try {
          const dest = await destFor(String(new Date(f.lastModified).getFullYear()));
          if (dest.have.has(key(f.name, f.size))) { skipped++; setCounts({ done, skipped }); continue; }
          setCurrent(f.name); setPct(0);
          const saved = await api.retry(() => api.upload(f, dest.id, setPct), 3);
          dest.have.add(key(f.name, f.size));
          done++; setCounts({ done, skipped });
          const jpeg = await makeThumb(f);
          if (jpeg) await api.putThumb(saved.id, jpeg);
        } catch (e) { setFailed((all) => [...all, `${f.name}: ${(e as Error).message}`]); }
      }
      awake?.release();
      setCurrent(""); setRunning(false); changed();
    })();
  }, []);

  const handled = counts.done + counts.skipped + failed.length;
  return (
    <div class="modal">
      <div class="sheet">
        <h2>{running ? "Backing up" : "Backup finished"} {files.length} {files.length === 1 ? "file" : "files"}</h2>
        <progress value={handled} max={files.length} />
        <p class="meta wrap">Uploaded {counts.done} · Already there {counts.skipped} · Failed {failed.length}</p>
        {running && current && <p class="meta wrap">Now: {current}{pct > 0 && pct < 1 ? ` (${Math.floor(pct * 100)}%)` : ""}</p>}
        {failed.slice(0, 5).map((m) => <p key={m} class="error meta wrap">{m}</p>)}
        {failed.length > 5 && <p class="meta wrap">…and {failed.length - 5} more</p>}
        {!running && failed.length > 0 && <p class="meta wrap">Pick the same files again to retry: finished ones are skipped.</p>}
        <div class="row">
          {running ? <button class="btn" onClick={() => { stop.current = true; }}>Stop after this file</button> : <button class="btn primary" onClick={close}>Done</button>}
        </div>
      </div>
    </div>
  );
}
