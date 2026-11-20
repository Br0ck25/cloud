import { useEffect, useRef } from "preact/hooks";
import * as api from "./api";
import type { Item } from "./api";

const SWIPE = 50; // sideways pixels that count as a swipe

/** Full-screen preview that moves through `items` (the previewable files of the current list) by swipe, arrow keys or the ‹ › buttons. */
export function Viewer({ items, current, onChange, close }: { items: Item[]; current: Item; onChange: (i: Item) => void; close: () => void }) {
  const at = items.findIndex((i) => i.id === current.id);
  const go = (step: number) => { const next = items[at + step]; if (at >= 0 && next) onChange(next); };

  const latest = useRef({ go, close });
  latest.current = { go, close };
  useEffect(() => { // registered once; always calls the newest handlers, so no key press can fall into a gap between renders
    const onKey = (e: KeyboardEvent) => { if (e.key === "ArrowLeft") latest.current.go(-1); else if (e.key === "ArrowRight") latest.current.go(1); else if (e.key === "Escape") latest.current.close(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { // fetch the neighbouring photos ahead of time so the next one appears at once
    for (const step of [-1, 1]) { const n = items[at + step]; if (n?.mime?.startsWith("image/")) new Image().src = api.fileUrl(n.id); }
  }, [current.id]);

  const start = useRef<{ x: number; y: number } | null>(null);
  // Swiping on a video, audio or PDF would fight its own controls, so only photos react; those use the buttons.
  const onStart = (e: TouchEvent) => {
    const t = e.touches[0];
    start.current = e.touches.length === 1 && !/^(VIDEO|AUDIO|IFRAME)$/.test((e.target as HTMLElement).tagName) ? { x: t.clientX, y: t.clientY } : null;
  };
  const onEnd = (e: TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1); // a mostly sideways move; left = next
  };

  const src = api.fileUrl(current.id);
  return (
    <div class="modal" onClick={close}>
      <div class="view" onClick={(e) => e.stopPropagation()} onTouchStart={onStart} onTouchEnd={onEnd}>
        <div class="vbar">
          <b>{current.name}</b>
          {at >= 0 && items.length > 1 && <span class="meta">{at + 1} / {items.length}</span>}
          <a class="btn" href={api.fileUrl(current.id, true)}>Download</a>
          <button class="btn" onClick={close}>Close</button>
        </div>
        <div class="stage">
          {at > 0 && <button class="nav prev" aria-label="Previous" onClick={() => go(-1)}>‹</button>}
          {current.mime?.startsWith("image/") ? <img key={current.id} src={src} alt={current.name} />
            : current.mime?.startsWith("video/") ? <video key={current.id} src={src} controls autoplay />
            : current.mime?.startsWith("audio/") ? <audio key={current.id} src={src} controls autoplay />
            : <iframe key={current.id} src={src} title={current.name} />}
          {at >= 0 && at < items.length - 1 && <button class="nav next" aria-label="Next" onClick={() => go(1)}>›</button>}
        </div>
      </div>
    </div>
  );
}
