import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { Item } from "./api";
import { makeThumb } from "./thumb";
import { Picker } from "./Picker";

const icon = (i: Item) => (i.kind === "folder" ? "📁" : i.mime?.startsWith("image/") ? "🖼️" : i.mime?.startsWith("video/") ? "🎬" : i.mime?.startsWith("audio/") ? "🎵" : "📄");
const size = (n: number | null) => (n == null ? "" : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(1)} GB`);
const when = (s: number) => new Date(s * 1000).toLocaleDateString();
const canPreview = (i: Item) => /^(image\/(?!svg)|video\/|audio\/|application\/pdf$)/.test(i.mime ?? "");

type Upload = { name: string; pct: number; file: File; error?: string };
type Ask = { title: string; value: string; ok: (v: string) => void };

function AskSheet({ ask, close }: { ask: Ask; close: () => void }) {
  const [v, setV] = useState(ask.value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return (
    <div class="modal" onClick={close}>
      <form class="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (v.trim()) ask.ok(v.trim()); close(); }}>
        <h2>{ask.title}</h2>
        <input ref={input} value={v} onInput={(e) => setV(e.currentTarget.value)} />
        <div class="row"><button type="button" class="btn" onClick={close}>Cancel</button><button class="btn primary">Save</button></div>
      </form>
    </div>
  );
}

const Tile = ({ i }: { i: Item }) => <span class="tile">{i.thumb ? <img src={api.thumbUrl(i.id)} alt="" loading="lazy" /> : icon(i)}</span>;

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const inTrash = hash === "#/trash";
  const folder = /^#\/f\/(\d+)$/.exec(hash)?.[1];
  const folderId = folder ? Number(folder) : undefined;

  const [email, setEmail] = useState("");
  const [parent, setParent] = useState<Item | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  const [drag, setDrag] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [moving, setMoving] = useState<Item | null>(null);

  const load = () =>
    (inTrash ? api.trashed().then((r) => ({ parent: null, items: r.items })) : api.list(folderId))
      .then((r) => { setParent(r.parent); setItems(r.items); setError(""); })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); }, [hash]);
  useEffect(() => { api.me().then((m) => setEmail(m.email), () => {}); }, []);

  const act = (p: Promise<unknown>) => p.then(load, (e) => setError(e.message));

  async function addFiles(files: File[]) {
    const awake = await navigator.wakeLock?.request("screen").catch(() => null); // keeps a phone from suspending the upload
    for (const f of files) {
      const set = (u: Partial<Upload>) => setUploads((all) => all.map((x) => (x.name === f.name ? { ...x, ...u } : x)));
      setUploads((all) => [...all.filter((x) => x.name !== f.name), { name: f.name, pct: 0, file: f }]);
      try {
        const saved = await api.upload(f, folderId, (p) => set({ pct: p }));
        setUploads((all) => all.filter((x) => x.name !== f.name));
        await load();
        const jpeg = await makeThumb(f);
        if (jpeg && (await api.putThumb(saved.id, jpeg)).ok) await load();
      } catch (e) { set({ error: (e as Error).message }); }
    }
    awake?.release();
  }

  const back = parent ? (parent.parent_id ? `#/f/${parent.parent_id}` : "#/") : "#/";

  return (
    <div class={drag ? "page drag" : "page"}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (!inTrash) addFiles([...(e.dataTransfer?.files ?? [])]); }}>
      <header>
        <h1>{inTrash ? <a href="#/">←</a> : parent ? <a href={back}>←</a> : null} {inTrash ? "Trash" : parent ? parent.name : "Family Cloud"}</h1>
        <span class="who">{email}</span>
      </header>

      {!inTrash && (
        <div class="bar">
          <label class="btn primary">Upload<input type="file" multiple hidden onChange={(e) => { addFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ""; }} /></label>
          <button class="btn" onClick={() => setAsk({ title: "New folder", value: "", ok: (n) => act(api.mkdir(n, folderId)) })}>New folder</button>
          <a class="btn" href="#/trash">Trash</a>
        </div>
      )}

      {error && <p class="error">{error} <button class="btn" onClick={() => load()}>Retry</button> <button class="btn" onClick={() => location.reload()}>Reload</button></p>}
      {uploads.map((u) => (
        <div class="upload" key={u.name}>
          <span>{u.name}</span>
          {u.error ? <><span class="error">{u.error}</span><button class="btn" onClick={() => addFiles([u.file])}>Retry</button><button class="btn" aria-label="Dismiss" onClick={() => setUploads((all) => all.filter((x) => x !== u))}>✕</button></>
            : <><progress value={u.pct} max={1} /><span class="meta">{Math.floor(u.pct * 100)}%</span></>}
        </div>
      ))}

      <ul class="list">
        {items.map((i) => {
          const locked = i.shared === 1 && i.parent_id === null;
          return (
            <li key={i.id}>
              {inTrash ? <span class="main"><Tile i={i} /><span class="name">{i.name}</span></span> : (
                <a class="main" href={i.kind === "folder" ? `#/f/${i.id}` : undefined}
                  onClick={i.kind === "file" ? (e) => { e.preventDefault(); canPreview(i) ? setOpen(i) : (location.href = api.fileUrl(i.id, true)); } : undefined}>
                  <Tile i={i} /><span class="name">{i.name}</span>
                </a>
              )}
              <span class="meta">{locked ? "Shared" : `${size(i.size)} ${when(i.updated_at)}`}</span>
              {inTrash ? <button class="btn" onClick={() => act(api.restore(i.id))}>Restore</button> : !locked && (
                <details class="more"><summary aria-label="Actions">⋮</summary>
                  <div class="menu" onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
                    <button onClick={() => setAsk({ title: "Rename", value: i.name, ok: (n) => act(api.rename(i.id, n)) })}>Rename</button>
                    <button onClick={() => setMoving(i)}>Move</button>
                    {i.kind === "file" && <a href={api.fileUrl(i.id, true)}>Download</a>}
                    <button onClick={() => act(api.trash(i.id))}>Delete</button>
                  </div>
                </details>
              )}
            </li>
          );
        })}
        {!items.length && !error && <li class="empty">{inTrash ? "Trash is empty." : "Nothing here yet. Upload a file or drop it on this page."}</li>}
      </ul>

      {moving && <Picker title={`Move "${moving.name}"`} action="Move here" shared={moving.shared === 1} start={moving.parent_id ?? undefined} hide={moving.id}
        ok={(to) => act(api.move(moving.id, to ?? null))} close={() => setMoving(null)} />}
      {ask && <AskSheet ask={ask} close={() => setAsk(null)} />}

      {open && (
        <div class="modal" onClick={() => setOpen(null)}>
          <div class="view" onClick={(e) => e.stopPropagation()}>
            <div class="vbar"><b>{open.name}</b><a class="btn" href={api.fileUrl(open.id, true)}>Download</a><button class="btn" onClick={() => setOpen(null)}>Close</button></div>
            {open.mime?.startsWith("image/") ? <img src={api.fileUrl(open.id)} alt={open.name} />
              : open.mime?.startsWith("video/") ? <video src={api.fileUrl(open.id)} controls autoplay />
              : open.mime?.startsWith("audio/") ? <audio src={api.fileUrl(open.id)} controls autoplay />
              : <iframe src={api.fileUrl(open.id)} title={open.name} />}
          </div>
        </div>
      )}
    </div>
  );
}
