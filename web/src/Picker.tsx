import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { Item } from "./api";

/** Sheet for choosing a destination folder. `shared` limits it to one space (your files or Family), since moved items cannot cross; leave it out to browse both. */
export function Picker({ title, action, shared, start, hide, ok, close }: {
  title: string; action: string; shared?: boolean; start?: number; hide?: number[]; ok: (folder: number | undefined) => void; close: () => void;
}) {
  const [at, setAt] = useState(start);
  const [data, setData] = useState<{ parent: Item | null; items: Item[] }>({ parent: null, items: [] });
  useEffect(() => { api.list(at).then(setData, () => {}); }, [at]);
  const folders = data.items.filter((i) => i.kind === "folder" && (shared === undefined || (i.shared === 1) === shared) && !hide?.includes(i.id));
  const canUp = data.parent !== null && !(shared === true && data.parent.parent_id === null); // Family's own top level is the floor for shared items
  return (
    <div class="modal" onClick={close}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div class="crumb">
          {canUp && <button class="btn" aria-label="Up one level" onClick={() => setAt(data.parent!.parent_id ?? undefined)}>←</button>}
          <b>{at === undefined ? "My files" : data.parent?.name ?? ""}</b>
        </div>
        <ul class="list picker">
          {folders.map((f) => <li key={f.id}><a class="main" onClick={() => setAt(f.id)}><span class="tile">📁</span><span class="name">{f.name}</span></a></li>)}
          {!folders.length && <li class="empty">No folders here</li>}
        </ul>
        <div class="row"><button class="btn" onClick={close}>Cancel</button><button class="btn primary" disabled={shared === true && at === undefined} onClick={() => { ok(at); close(); }}>{action}</button></div>
      </div>
    </div>
  );
}
