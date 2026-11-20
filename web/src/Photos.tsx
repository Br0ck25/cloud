import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { Item } from "./api";
import { Viewer } from "./Viewer";
import { Picker } from "./Picker";
import { SelectBar } from "./SelectBar";
import { longPress, useSelection } from "./selection";
import { moveAll, report, trashAll } from "./bulk";

const month = (i: Item) => new Date((i.taken_at ?? i.updated_at) * 1000).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/** Every photo and video you can see, newest first by the date taken, grouped by month, loading more as you scroll. Photos can be picked to move or delete. */
export function Photos() {
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined); // undefined: nothing loaded yet; null: that was the last page
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<Item | null>(null);
  const [moving, setMoving] = useState<Item[] | null>(null);
  const selection = useSelection();
  const { sel } = selection;
  const busy = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  const more = async () => {
    if (busy.current || next === null) return;
    busy.current = true;
    try { const r = await api.photos(next); setItems((all) => [...all, ...r.items]); setNext(r.next); } catch (e) { setError((e as Error).message); }
    busy.current = false;
  };
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const watch = new IntersectionObserver((e) => { if (e[0].isIntersecting) more(); }, { rootMargin: "800px" }); // start loading well before the end is reached
    watch.observe(el);
    return () => watch.disconnect();
  }, [next, items.length]);

  const chosen = items.filter((i) => sel?.has(i.id));
  const ids = chosen.map((i) => i.id);
  const sameSpace = chosen.every((i) => (i.shared === 1) === (chosen[0].shared === 1)); // items cannot move between your files and Family
  const reload = () => { setItems([]); setNext(undefined); };
  const finish = (failed: string[], verb: string, removed?: number[]) => {
    selection.clear();
    setNote(report(failed, verb));
    if (removed && !failed.length) setItems((all) => all.filter((i) => !removed.includes(i.id))); else reload(); // after a partial failure, ask the server what is really there
  };

  if (error) return <p class="error">{error}</p>;
  const groups: { label: string; photos: Item[] }[] = [];
  for (const i of items) {
    const label = month(i);
    if (groups[groups.length - 1]?.label === label) groups[groups.length - 1].photos.push(i); else groups.push({ label, photos: [i] });
  }
  return (
    <>
      {sel
        ? <SelectBar count={chosen.length} total={items.length} onAll={() => selection.all(items.map((i) => i.id))} onClear={selection.clear}
            actions={[{ label: "Move", disabled: !sameSpace, onClick: () => setMoving(chosen) }, { label: "Delete", danger: true, onClick: async () => finish(await trashAll(ids), "deleted", ids) }]} />
        : items.length > 0 && <div class="bar"><button class="btn" onClick={() => selection.start()}>Select</button></div>}
      {note && <p class="notice" role="status" onClick={() => setNote("")}>{note}</p>}
      {groups.map((g) => (
        <section key={g.label}>
          <h2 class="month">{g.label}</h2>
          <div class="grid">
            {g.photos.map((i) => (
              <div class={sel?.has(i.id) ? "cell picked" : "cell"} key={i.id}>
                <a class="thumb" aria-label={i.name} onClick={() => (sel ? selection.toggle(i.id) : setOpen(i))} {...longPress(() => selection.start(i.id))}>
                  {i.thumb ? <img src={api.thumbUrl(i.id, i.updated_at)} alt="" loading="lazy" /> : <span class="glyph">{i.mime?.startsWith("video/") ? "🎬" : "🖼️"}</span>}
                  {i.mime?.startsWith("video/") && <span class="badge">▶</span>}
                </a>
                {sel && <span class="tick">{sel.has(i.id) ? "✓" : ""}</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
      {next === null && !items.length && <p class="empty">No photos yet. Use Back up photos on the home screen, or upload some.</p>}
      <div ref={end} class="end">{next !== null && "Loading…"}</div>
      {open && <Viewer items={items} current={open} onChange={setOpen} close={() => setOpen(null)} showFolder />}
      {moving && <Picker title={moving.length === 1 ? `Move "${moving[0].name}"` : `Move ${moving.length} photos`} action="Move here" shared={moving[0].shared === 1} hide={[]}
        ok={async (to) => finish(await moveAll(moving.map((i) => i.id), to ?? null), "moved")} close={() => setMoving(null)} />}
    </>
  );
}
