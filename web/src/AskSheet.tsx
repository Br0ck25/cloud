import { useEffect, useRef, useState } from "preact/hooks";

export type Ask = { title: string; value: string; ok: (v: string) => void };

/** A small sheet that asks for one line of text. */
export function AskSheet({ ask, close }: { ask: Ask; close: () => void }) {
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
