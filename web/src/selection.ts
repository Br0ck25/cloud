import { useState } from "preact/hooks";

/** Which items are ticked. `sel` is null when not selecting at all. */
export function useSelection() {
  const [sel, setSel] = useState<Set<number> | null>(null);
  return {
    sel,
    start: (id?: number) => setSel(new Set(id === undefined ? [] : [id])),
    toggle: (id: number) => setSel((s) => { const n = new Set(s ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    all: (ids: number[]) => setSel(new Set(ids)),
    clear: () => setSel(null),
  };
}

// One finger is down at a time, so the timer and the "already fired" flag can be shared.
let timer = 0;
let fired = false;

/** Touch long-press (about half a second): runs `onLong`, and swallows the click that follows lifting the finger. Mouse users use the Select button. */
export const longPress = (onLong: () => void) => {
  const stop = () => clearTimeout(timer);
  return {
    onPointerDown: (e: PointerEvent) => {
      fired = false; // a long-press whose finger slid away never gets its click, so every new press starts clean
      if (e.pointerType === "mouse") return;
      clearTimeout(timer);
      timer = window.setTimeout(() => { fired = true; onLong(); }, 450);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop, // scrolling cancels the press
    onContextMenu: (e: Event) => e.preventDefault(), // the phone's own long-press menu would cover ours
    onClickCapture: (e: Event) => { if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); } },
  };
};
