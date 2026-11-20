import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { Item } from "./api";
import { makeThumb } from "./thumb";
import { Picker } from "./Picker";
import { ShareSheet } from "./ShareSheet";
import { VersionsSheet } from "./VersionsSheet";
import { Viewer } from "./Viewer";
import { BackupSheet } from "./BackupSheet";
import { clearInbox, readInbox } from "./inbox";
import { SelectBar } from "./SelectBar";
import { ConfirmSheet } from "./ConfirmSheet";
import type { Confirm } from "./ConfirmSheet";
import { download, emptyTrash, moveAll, purgeAll, report, restoreAll, trashAll } from "./bulk";
import { longPress, useSelection } from "./selection";
import { Admin } from "./Admin";
import { Photos } from "./Photos";
import { AskSheet } from "./AskSheet";
import type { Ask } from "./AskSheet";
import { size } from "./format";

const icon = (i: Item) => (i.kind === "folder" ? "📁" : i.mime?.startsWith("image/") ? "🖼️" : i.mime?.startsWith("video/") ? "🎬" : i.mime?.startsWith("audio/") ? "🎵" : "📄");
const when = (s: number) => new Date(s * 1000).toLocaleDateString();
const isMedia = (i: Item) => /^(image\/(?!svg)|video\/)/.test(i.mime ?? "");
type Sort = "name" | "new" | "old" | "big";
const SORTS: [Sort, string][] = [["name", "Name"], ["new", "Newest first"], ["old", "Oldest first"], ["big", "Largest first"]];
const byName = (a: Item, b: Item) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }); // IMG_2 before IMG_10
const taken = (i: Item) => i.taken_at ?? i.updated_at;
/** Folders first (by name), then files in the chosen order. */
const sorted = (items: Item[], by: Sort) => [...items].sort((a, b) => {
  if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
  if (a.kind === "folder" || by === "name") return byName(a, b);
  return (by === "new" ? taken(b) - taken(a) : by === "old" ? taken(a) - taken(b) : (b.size ?? 0) - (a.size ?? 0)) || byName(a, b);
});
const canPreview = (i: Item) => /^(image\/(?!svg)|video\/|audio\/|application\/pdf$)/.test(i.mime ?? "");

type Upload = { name: string; pct: number; file: File; dest?: number; error?: string };
const folderOf = (hash: string) => { const m = /^#\/f\/(\d+)$/.exec(hash); return m ? Number(m[1]) : undefined; };
const Tile = ({ i }: { i: Item }) => <span class="tile">{i.thumb ? <img src={api.thumbUrl(i.id, i.updated_at)} alt="" loading="lazy" /> : icon(i)}</span>;

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
  const inPhotos = hash === "#/photos";
  const folderId = folderOf(hash);

  const [me, setMe] = useState<{ id: number; email: string; role: string; backup_warning?: string | null } | null>(null);
  const [parent, setParent] = useState<Item | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  const [drag, setDrag] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [moving, setMoving] = useState<Item[] | null>(null); // items being moved (one from the menu, or all the picked ones)
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [note, setNote] = useState(""); // result of a bulk action that partly failed
  const selection = useSelection();
  const { sel } = selection;
  const [sharing, setSharing] = useState<Item | null>(null);
  const [versioning, setVersioning] = useState<Item | null>(null);
  const [backing, setBacking] = useState<File[] | null>(null); // photos picked for "Back up photos"
  const [inbox, setInbox] = useState<File[] | null>(null); // files shared into the app from the phone's Share sheet
  const saving = useRef(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Item[] | null>(null); // search results, or null when not searching
  const [tick, setTick] = useState(0); // bumped after changes so open search results refresh
  const [view, setView] = useState<"grid" | "list" | null>(() => { try { const v = localStorage.getItem("view"); return v === "grid" || v === "list" ? v : null; } catch { return null; } }); // null = automatic
  const chooseView = (v: "grid" | "list") => { setView(v); try { localStorage.setItem("view", v); } catch {} };
  const [sort, setSort] = useState<Sort>(() => { try { const v = localStorage.getItem("sort"); return SORTS.some(([k]) => k === v) ? (v as Sort) : "name"; } catch { return "name"; } });
  const chooseSort = (v: Sort) => { setSort(v); try { localStorage.setItem("sort", v); } catch {} };

  const latest = useRef(0);
  // Reads the address at call time and ignores out-of-date answers, so a load that finishes after you moved elsewhere cannot overwrite the screen.
  const load = () => {
    const n = ++latest.current;
    const h = location.hash;
    if (h === "#/admin" || h === "#/photos") return Promise.resolve();
    return (h === "#/trash" ? api.trashed().then((r) => ({ parent: null, items: r.items })) : api.list(folderOf(h)))
      .then((r) => { if (n === latest.current) { setParent(r.parent); setItems(r.items); setError(""); } })
      .catch((e) => { if (n === latest.current) setError(e.message); });
  };
  useEffect(() => { load(); }, [hash]);
  useEffect(() => {
    if (hash === "#/share") readInbox().then((f) => (f.length ? setInbox(f) : (location.hash = "#/")), () => (location.hash = "#/"));
  }, [hash]);
  useEffect(() => { api.me().then(setMe, () => {}); }, []);

  useEffect(() => { setQuery(""); selection.clear(); setNote(""); }, [hash]);
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
        const saved = await api.uploadAvoidingClash(f, dest, (p) => set({ pct: p }));
        setUploads((all) => all.filter((x) => x.name !== f.name));
        await load();
        const jpeg = await makeThumb(f);
        if (jpeg && (await api.putThumb(saved.id, jpeg)).ok) await load();
      } catch (e) { set({ error: (e as Error).message }); }
    }
    awake?.release();
  }

  const rows = found ?? (inTrash ? items : sorted(items, sort)); // search keeps the server's order; the trash is newest-deleted first
  const files = rows.filter((i) => i.kind === "file");
  // Automatic: a folder that is mostly photos and videos opens as a grid; the toggle next to the search box overrides it (and is remembered on this device).
  const grid = !inTrash && !inAdmin && !inPhotos && !found && (view ? view === "grid" : files.length > 0 && files.filter(isMedia).length >= files.length * 0.6);
  const selectable = (i: Item) => !(i.shared === 1 && i.parent_id === null); // the Family folder itself cannot be changed
  const chosen = rows.filter((i) => sel?.has(i.id));
  const ids = chosen.map((i) => i.id);
  const sameSpace = chosen.every((i) => (i.shared === 1) === (chosen[0].shared === 1)); // items cannot move between your files and Family
  const bulk = async (run: Promise<string[]>, verb: string) => { const failed = await run; selection.clear(); setNote(report(failed, verb)); load(); setTick((t) => t + 1); };
  // While picking, a tap ticks the item; otherwise it opens the folder or file.
  const pick = (i: Item) => (e: Event) => {
    if (sel) { e.preventDefault(); if (selectable(i)) selection.toggle(i.id); } else if (i.kind === "file") { e.preventDefault(); openItem(i); }
  };
  const holdToPick = (i: Item) => (selectable(i) && !inTrash ? longPress(() => selection.start(i.id)) : {});
  const openItem = (i: Item) => (canPreview(i) ? setOpen(i) : (location.href = api.fileUrl(i.id, true)));
  const actions = (i: Item) => (
    <details class="more"><summary aria-label="Actions">⋮</summary>
      <div class="menu" onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
        <button onClick={() => setAsk({ title: "Rename", value: i.name, ok: (n) => act(api.rename(i.id, n)) })}>Rename</button>
        <button onClick={() => setMoving([i])}>Move</button>
        <button onClick={() => setSharing(i)}>Share link</button>
        {i.kind === "file" && <button onClick={() => setVersioning(i)}>Versions</button>}
        {i.kind === "file" ? <a href={api.fileUrl(i.id, true)}>Download</a> : <button onClick={async () => setNote(await download([i]))}>Download as zip</button>}
        <button onClick={() => act(api.trash(i.id))}>Delete</button>
      </div>
    </details>
  );

  const back = parent ? (parent.parent_id ? `#/f/${parent.parent_id}` : "#/") : "#/";

  return (
    <div class={drag ? "page drag" : "page"}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (!inTrash && !inAdmin && !inPhotos) addFiles([...(e.dataTransfer?.files ?? [])]); }}>
      <header>
        <h1>{inTrash || inAdmin || inPhotos ? <a href="#/">←</a> : parent ? <a href={back}>←</a> : null} {inTrash ? "Trash" : inAdmin ? "Admin" : inPhotos ? "Photos" : parent ? parent.name : "Family Cloud"}</h1>
        <details class="account">
          <summary class="who">{me?.email || "Account"}</summary>
          <div class="menu" onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
            {me?.role === "admin" && <a href="#/admin">Admin</a>}
            <a href="/cdn-cgi/access/logout">Sign out</a>
          </div>
        </details>
      </header>

      {me?.backup_warning && !inAdmin && !inPhotos && <a class="notice" href="#/admin">⚠ {me.backup_warning} Open Admin to check the backup.</a>}

      {inAdmin && me && <Admin me={me.id} ask={setAsk} backedUp={() => api.me().then(setMe, () => {})} />}

      {inPhotos && <Photos />}

      {sel && (
        <SelectBar count={chosen.length} total={rows.filter(selectable).length} onAll={() => selection.all(rows.filter(selectable).map((i) => i.id))} onClear={selection.clear}
          actions={inTrash
            ? [{ label: "Restore", onClick: () => bulk(restoreAll(ids), "restored") },
               { label: "Delete forever", danger: true, onClick: () => setConfirm({ title: `Delete ${ids.length} ${ids.length === 1 ? "item" : "items"} forever?`, message: "They cannot be recovered from the app afterwards.", action: "Delete forever", ok: () => bulk(purgeAll(ids), "deleted") }) }]
            : [{ label: "Download", onClick: async () => setNote(await download(chosen)) },
               { label: "Move", disabled: !sameSpace, onClick: () => setMoving(chosen) },
               { label: "Delete", danger: true, onClick: () => bulk(trashAll(ids), "deleted") }]} />
      )}

      {inTrash && !sel && (
        <div class="bar">
          <button class="btn" disabled={!items.length} onClick={() => selection.start()}>Select</button>
          <button class="btn danger" disabled={!items.length} onClick={() => setConfirm({ title: "Empty the trash?", message: `Everything in the trash (${items.length} ${items.length === 1 ? "item" : "items"}) is deleted for good and cannot be recovered from the app.`, action: "Empty trash", ok: () => bulk(emptyTrash(), "deleted") })}>Empty trash</button>
        </div>
      )}

      {!inTrash && !inAdmin && !inPhotos && !sel && (
        <div class="bar">
          <label class="btn primary">Upload<input type="file" multiple hidden onChange={(e) => { addFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ""; }} /></label>
          {!folderId && <label class="btn">Back up photos<input type="file" multiple accept="image/*,video/*" hidden onChange={(e) => { const f = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ""; if (f.length) setBacking(f); }} /></label>}
          <button class="btn" onClick={() => setAsk({ title: "New folder", value: "", ok: (n) => act(api.mkdir(n, folderId)) })}>New folder</button>
          <a class="btn" href="#/photos">Photos</a>
          <a class="btn" href="#/trash">Trash</a>
        </div>
      )}

      {!inTrash && !inAdmin && !inPhotos && !sel && (
        <>
          <div class="searchrow">
            <input class="search" type="search" placeholder="Search files and folders" aria-label="Search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          </div>
          {!found && rows.length > 0 && (
            <div class="tools">
              <select class="sort" aria-label="Sort by" value={sort} onChange={(e) => chooseSort(e.currentTarget.value as Sort)}>{SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
              <button class="btn sq" aria-label={grid ? "Show as a list" : "Show as a grid of pictures"} onClick={() => chooseView(grid ? "list" : "grid")}>{grid ? "☰" : "▦"}</button>
              <button class="btn" onClick={() => selection.start()}>Select</button>
            </div>
          )}
          {found && rows.length > 0 && <div class="tools"><span class="spacer" /><button class="btn" onClick={() => selection.start()}>Select</button></div>}
        </>
      )}

      {note && <p class="notice" role="status" onClick={() => setNote("")}>{note}</p>}
      {error && <p class="error">{error} <button class="btn" onClick={() => load()}>Retry</button> <button class="btn" onClick={() => location.reload()}>Reload</button></p>}
      {uploads.map((u) => (
        <div class="upload" key={u.name}>
          <span>{u.name}</span>
          {u.error ? <><span class="error">{u.error}</span><button class="btn" onClick={() => addFiles([u.file], u.dest)}>Retry</button><button class="btn" aria-label="Dismiss" onClick={() => setUploads((all) => all.filter((x) => x !== u))}>✕</button></>
            : <><progress value={u.pct} max={1} /><span class="meta">{Math.floor(u.pct * 100)}%</span></>}
        </div>
      ))}

      {grid && (
        <div class="grid">
          {rows.map((i) => (
            <div class={sel?.has(i.id) ? "cell picked" : "cell"} key={i.id}>
              <a class="thumb" aria-label={i.name} href={i.kind === "folder" ? `#/f/${i.id}` : undefined} onClick={pick(i)} {...holdToPick(i)}>
                {i.thumb ? <img src={api.thumbUrl(i.id, i.updated_at)} alt="" loading="lazy" /> : <span class="glyph">{icon(i)}</span>}
                {i.mime?.startsWith("video/") && <span class="badge">▶</span>}
                {!i.thumb && <span class="cap">{i.name}</span>}
              </a>
              {sel && selectable(i) && <span class="tick">{sel.has(i.id) ? "✓" : ""}</span>}
              {!sel && selectable(i) && <span class="over">{actions(i)}</span>}
            </div>
          ))}
        </div>
      )}
      {grid && !rows.length && !error && <p class="empty">Nothing here yet. Upload a file or drop it on this page.</p>}

      {!inAdmin && !inPhotos && !grid && <ul class="list">
        {rows.map((i) => {
          const locked = i.shared === 1 && i.parent_id === null;
          return (
            <li key={i.id} class={sel?.has(i.id) ? "picked" : ""}>
              {sel && <button class="check" aria-label={`Select ${i.name}`} aria-pressed={sel.has(i.id)} disabled={!selectable(i)} onClick={() => selection.toggle(i.id)}>{sel.has(i.id) ? "✓" : ""}</button>}
              {inTrash ? <span class="main" onClick={sel ? () => selection.toggle(i.id) : undefined}><Tile i={i} /><span class="name">{i.name}</span></span> : (
                <a class="main" href={i.kind === "folder" ? `#/f/${i.id}` : undefined} onClick={pick(i)} {...holdToPick(i)}>
                  <Tile i={i} /><span class="name">{i.name}</span>
                </a>
              )}
              <span class="meta">{found ? `in ${i.folder ?? "My files"}` : locked ? "Shared" : `${size(i.size)} ${when(i.updated_at)}`}</span>
              {!sel && (inTrash ? <button class="btn" onClick={() => act(api.restore(i.id))}>Restore</button> : !locked && actions(i))}
            </li>
          );
        })}
        {!rows.length && !error && <li class="empty">{found ? `No matches for "${query.trim()}"` : inTrash ? "Trash is empty." : "Nothing here yet. Upload a file or drop it on this page."}</li>}
      </ul>}

      {moving && <Picker title={moving.length === 1 ? `Move "${moving[0].name}"` : `Move ${moving.length} items`} action="Move here" shared={moving[0].shared === 1} start={moving[0].parent_id ?? undefined} hide={moving.map((i) => i.id)}
        ok={(to) => bulk(moveAll(moving.map((i) => i.id), to ?? null), "moved")} close={() => setMoving(null)} />}
      {confirm && <ConfirmSheet confirm={confirm} close={() => setConfirm(null)} />}
      {inbox && <Picker title={`Save ${inbox.length} shared ${inbox.length === 1 ? "file" : "files"}`} action="Save here"
        ok={(to) => { saving.current = true; location.hash = to ? `#/f/${to}` : "#/"; addFiles(inbox, to).then(clearInbox); }}
        close={() => { setInbox(null); if (!saving.current) { clearInbox(); if (location.hash === "#/share") location.hash = "#/"; } saving.current = false; }} />}
      {backing && <BackupSheet files={backing} changed={() => act(Promise.resolve())} close={() => setBacking(null)} />}
      {versioning && <VersionsSheet item={versioning} changed={() => act(Promise.resolve())} close={() => setVersioning(null)} />}
      {sharing && <ShareSheet item={sharing} close={() => setSharing(null)} />}
      {ask && <AskSheet ask={ask} close={() => setAsk(null)} />}

      {open && !inPhotos && <Viewer items={rows.filter((i) => i.kind === "file" && canPreview(i))} current={open} onChange={setOpen} close={() => setOpen(null)} />}
    </div>
  );
}
