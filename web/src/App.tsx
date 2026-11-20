import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { Item } from "./api";
import { makeThumb } from "./thumb";
import { Picker } from "./Picker";
import { ShareSheet } from "./ShareSheet";
import { clearInbox, readInbox } from "./inbox";
import { Admin } from "./Admin";
import { AskSheet } from "./AskSheet";
import type { Ask } from "./AskSheet";
import { size } from "./format";

const icon = (i: Item) => (i.kind === "folder" ? "📁" : i.mime?.startsWith("image/") ? "🖼️" : i.mime?.startsWith("video/") ? "🎬" : i.mime?.startsWith("audio/") ? "🎵" : "📄");
const when = (s: number) => new Date(s * 1000).toLocaleDateString();
const canPreview = (i: Item) => /^(image\/(?!svg)|video\/|audio\/|application\/pdf$)/.test(i.mime ?? "");

type Upload = { name: string; pct: number; file: File; dest?: number; error?: string };
const folderOf = (hash: string) => { const m = /^#\/f\/(\d+)$/.exec(hash); return m ? Number(m[1]) : undefined; };
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
  const inAdmin = hash === "#/admin";
  const folderId = folderOf(hash);

  const [me, setMe] = useState<{ id: number; email: string; role: string } | null>(null);
  const [parent, setParent] = useState<Item | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  const [drag, setDrag] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [moving, setMoving] = useState<Item | null>(null);
  const [sharing, setSharing] = useState<Item | null>(null);
  const [inbox, setInbox] = useState<File[] | null>(null); // files shared into the app from the phone's Share sheet
  const saving = useRef(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Item[] | null>(null); // search results, or null when not searching
  const [tick, setTick] = useState(0); // bumped after changes so open search results refresh

  const latest = useRef(0);
  // Reads the address at call time and ignores out-of-date answers, so a load that finishes after you moved elsewhere cannot overwrite the screen.
  const load = () => {
    const n = ++latest.current;
    const h = location.hash;
    if (h === "#/admin") return Promise.resolve();
    return (h === "#/trash" ? api.trashed().then((r) => ({ parent: null, items: r.items })) : api.list(folderOf(h)))
      .then((r) => { if (n === latest.current) { setParent(r.parent); setItems(r.items); setError(""); } })
      .catch((e) => { if (n === latest.current) setError(e.message); });
  };
  useEffect(() => { load(); }, [hash]);
  useEffect(() => {
    if (hash === "#/share") readInbox().then((f) => (f.length ? setInbox(f) : (location.hash = "#/")), () => (location.hash = "#/"));
  }, [hash]);
  useEffect(() => { api.me().then(setMe, () => {}); }, []);

  useEffect(() => { setQuery(""); }, [hash]);
  useEffect(() => {
    if (!query.trim()) return setFound(null);
    const t = setTimeout(() => api.search(query.trim()).then(setFound, (e) => setError(e.message)), 250);
    return () => clearTimeout(t);
  }, [query, tick]);

  const act = (p: Promise<unknown>) => p.then(() => { load(); setTick((t) => t + 1); }, (e) => setError(e.message));

  async function addFiles(files: File[], dest = folderId) {
    const awake = await navigator.wakeLock?.request("screen").catch(() => null); // keeps a phone from suspending the upload
    for (const f of files) {
      const set = (u: Partial<Upload>) => setUploads((all) => all.map((x) => (x.name === f.name ? { ...x, ...u } : x)));
      setUploads((all) => [...all.filter((x) => x.name !== f.name), { name: f.name, pct: 0, file: f, dest }]);
      try {
        const saved = await api.upload(f, dest, (p) => set({ pct: p }));
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
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (!inTrash && !inAdmin) addFiles([...(e.dataTransfer?.files ?? [])]); }}>
      <header>
        <h1>{inTrash || inAdmin ? <a href="#/">←</a> : parent ? <a href={back}>←</a> : null} {inTrash ? "Trash" : inAdmin ? "Admin" : parent ? parent.name : "Family Cloud"}</h1>
        <details class="account">
          <summary class="who">{me?.email || "Account"}</summary>
          <div class="menu" onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
            {me?.role === "admin" && <a href="#/admin">Admin</a>}
            <a href="/cdn-cgi/access/logout">Sign out</a>
          </div>
        </details>
      </header>

      {inAdmin && me && <Admin me={me.id} ask={setAsk} />}

      {!inTrash && !inAdmin && (
        <div class="bar">
          <label class="btn primary">Upload<input type="file" multiple hidden onChange={(e) => { addFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ""; }} /></label>
          <button class="btn" onClick={() => setAsk({ title: "New folder", value: "", ok: (n) => act(api.mkdir(n, folderId)) })}>New folder</button>
          <a class="btn" href="#/trash">Trash</a>
        </div>
      )}

      {!inTrash && !inAdmin && <input class="search" type="search" placeholder="Search files and folders" aria-label="Search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />}

      {error && <p class="error">{error} <button class="btn" onClick={() => load()}>Retry</button> <button class="btn" onClick={() => location.reload()}>Reload</button></p>}
      {uploads.map((u) => (
        <div class="upload" key={u.name}>
          <span>{u.name}</span>
          {u.error ? <><span class="error">{u.error}</span><button class="btn" onClick={() => addFiles([u.file], u.dest)}>Retry</button><button class="btn" aria-label="Dismiss" onClick={() => setUploads((all) => all.filter((x) => x !== u))}>✕</button></>
            : <><progress value={u.pct} max={1} /><span class="meta">{Math.floor(u.pct * 100)}%</span></>}
        </div>
      ))}

      {!inAdmin && <ul class="list">
        {(found ?? items).map((i) => {
          const locked = i.shared === 1 && i.parent_id === null;
          return (
            <li key={i.id}>
              {inTrash ? <span class="main"><Tile i={i} /><span class="name">{i.name}</span></span> : (
                <a class="main" href={i.kind === "folder" ? `#/f/${i.id}` : undefined}
                  onClick={i.kind === "file" ? (e) => { e.preventDefault(); canPreview(i) ? setOpen(i) : (location.href = api.fileUrl(i.id, true)); } : undefined}>
                  <Tile i={i} /><span class="name">{i.name}</span>
                </a>
              )}
              <span class="meta">{found ? `in ${i.folder ?? "My files"}` : locked ? "Shared" : `${size(i.size)} ${when(i.updated_at)}`}</span>
              {inTrash ? <button class="btn" onClick={() => act(api.restore(i.id))}>Restore</button> : !locked && (
                <details class="more"><summary aria-label="Actions">⋮</summary>
                  <div class="menu" onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
                    <button onClick={() => setAsk({ title: "Rename", value: i.name, ok: (n) => act(api.rename(i.id, n)) })}>Rename</button>
                    <button onClick={() => setMoving(i)}>Move</button>
                    <button onClick={() => setSharing(i)}>Share link</button>
                    {i.kind === "file" && <a href={api.fileUrl(i.id, true)}>Download</a>}
                    <button onClick={() => act(api.trash(i.id))}>Delete</button>
                  </div>
                </details>
              )}
            </li>
          );
        })}
        {!(found ?? items).length && !error && <li class="empty">{found ? `No matches for "${query.trim()}"` : inTrash ? "Trash is empty." : "Nothing here yet. Upload a file or drop it on this page."}</li>}
      </ul>}

      {moving && <Picker title={`Move "${moving.name}"`} action="Move here" shared={moving.shared === 1} start={moving.parent_id ?? undefined} hide={moving.id}
        ok={(to) => act(api.move(moving.id, to ?? null))} close={() => setMoving(null)} />}
      {inbox && <Picker title={`Save ${inbox.length} shared ${inbox.length === 1 ? "file" : "files"}`} action="Save here"
        ok={(to) => { saving.current = true; location.hash = to ? `#/f/${to}` : "#/"; addFiles(inbox, to).then(clearInbox); }}
        close={() => { setInbox(null); if (!saving.current) { clearInbox(); if (location.hash === "#/share") location.hash = "#/"; } saving.current = false; }} />}
      {sharing && <ShareSheet item={sharing} close={() => setSharing(null)} />}
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
