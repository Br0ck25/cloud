export type Confirm = { title: string; message: string; action: string; ok: () => void };

/** "Are you sure?" for things that cannot be undone. */
export function ConfirmSheet({ confirm, close }: { confirm: Confirm; close: () => void }) {
  return (
    <div class="modal" onClick={close}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{confirm.title}</h2>
        <p class="meta wrap">{confirm.message}</p>
        <div class="row">
          <button class="btn" onClick={close}>Cancel</button>
          <button class="btn danger" onClick={() => { confirm.ok(); close(); }}>{confirm.action}</button>
        </div>
      </div>
    </div>
  );
}
