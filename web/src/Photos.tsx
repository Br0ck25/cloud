import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { Item } from "./api";
import { Viewer } from "./Viewer";

const month = (i: Item) => new Date((i.taken_at ?? i.updated_at) * 1000).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/** Every photo and video you can see, newest first by the date taken, grouped by month, loading more as you scroll. */
export function Photos() {
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined); // undefined: nothing loaded yet; null: that was the last page
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Item | null>(null);
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

  if (error) return <p class="error">{error}</p>;
  const groups: { label: string; photos: Item[] }[] = [];
  for (const i of items) {
    const label = month(i);
    if (groups[groups.length - 1]?.label === label) groups[groups.length - 1].photos.push(i); else groups.push({ label, photos: [i] });
  }
  return (
    <>
      {groups.map((g) => (
        <section key={g.label}>
          <h2 class="month">{g.label}</h2>
          <div class="grid">
            {g.photos.map((i) => (
              <div class="cell" key={i.id}>
                <a class="thumb" aria-label={i.name} onClick={() => setOpen(i)}>
                  {i.thumb ? <img src={api.thumbUrl(i.id, i.updated_at)} alt="" loading="lazy" /> : <span class="glyph">{i.mime?.startsWith("video/") ? "🎬" : "🖼️"}</span>}
                  {i.mime?.startsWith("video/") && <span class="badge">▶</span>}
                </a>
              </div>
            ))}
          </div>
        </section>
      ))}
      {next === null && !items.length && <p class="empty">No photos yet. Use Back up photos on the home screen, or upload some.</p>}
      <div ref={end} class="end">{next !== null && "Loading…"}</div>
      {open && <Viewer items={items} current={open} onChange={setOpen} close={() => setOpen(null)} showFolder />}
    </>
  );
}
