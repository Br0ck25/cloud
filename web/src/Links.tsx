import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { LinkRow } from "./api";
import { icon } from "./format";
import { link, status } from "./ShareSheet";

/** Every public link on items you can see: who made it, when it ends, copy it again, or switch it off. */
export function Links({ me }: { me: string }) {
  const [rows, setRows] = useState<LinkRow[] | null>(null);
  const [note, setNote] = useState("");
  const load = () => api.allShares().then(setRows, (e) => setNote(e.message));
  useEffect(() => { load(); }, []);
  const copy = (r: LinkRow) => navigator.clipboard.writeText(link(r)).then(() => setNote("Link copied"), () => setNote(link(r)));
  const revoke = (r: LinkRow) => api.revokeShare(r.id).then(() => { setNote("Link revoked"); load(); }, (e) => setNote(e.message));
  if (!rows) return note ? <p class="error">{note}</p> : null;
  return (
    <>
      {note && <p class="notice" role="status" onClick={() => setNote("")}>{note}</p>}
      <ul class="list links">
        {rows.map((r) => (
          <li key={r.id}>
            <span class="main">
              <span class="tile">{icon(r)}</span>
              <span class="stack"><span class="name">{r.name}</span><span class="meta wrap">{status(r)} · {r.made_by === me ? "by you" : `by ${r.made_by}`}</span></span>
            </span>
            <button class="btn" onClick={() => copy(r)}>Copy</button>
            <button class="btn" onClick={() => revoke(r)}>Revoke</button>
          </li>
        ))}
        {!rows.length && <li class="empty">No links yet. Open an item's ⋮ menu and choose Share link.</li>}
      </ul>
    </>
  );
}
