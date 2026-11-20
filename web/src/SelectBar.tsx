type Action = { label: string; onClick: () => void; disabled?: boolean; danger?: boolean };

/** Sticky bar shown while picking items: count, Select all, and the actions that apply to the picked items. */
export function SelectBar({ count, total, onAll, onClear, actions }: { count: number; total: number; onAll: () => void; onClear: () => void; actions: Action[] }) {
  return (
    <div class="selbar" role="toolbar" aria-label="Selection">
      <button class="btn" aria-label="Cancel selection" onClick={onClear}>✕</button>
      <b>{count} selected</b>
      <button class="btn" disabled={count === total} onClick={onAll}>All</button>
      <span class="spacer" />
      {actions.map((a) => <button key={a.label} class={a.danger ? "btn danger" : "btn"} disabled={a.disabled || count === 0} onClick={a.onClick}>{a.label}</button>)}
    </div>
  );
}
