import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { Item, Share } from "./api";

export const link = (s: Pick<Share, "token">) => `${location.origin}/s/${s.token}`;
export const status = (s: Pick<Share, "expires_at">) => (s.expires_at === null ? "Never expires" : s.expires_at * 1000 < Date.now() ? "Expired" : `Expires ${new Date(s.expires_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);

/** Create, copy and revoke public links for one item. */
export function ShareSheet({ item, close }: { item: Item; close: () => void }) {
  const [links, setLinks] = useState<Share[]>([]);
  const [days, setDays] = useState("7");
  const [note, setNote] = useState("");
  const load = () => api.shares(item.id).then(setLinks, (e) => setNote(e.message));
  useEffect(() => { load(); }, []);
  const copy = (s: Share) => navigator.clipboard.writeText(link(s)).then(() => setNote("Link copied"), () => setNote(link(s)));
  const create = () => api.createShare(item.id, days === "never" ? null : Number(days)).then((s) => { load(); copy(s); }, (e) => setNote(e.message));
  const revoke = (s: Share) => api.revokeShare(s.id).then(() => { setNote("Link revoked"); load(); }, (e) => setNote(e.message));
  return (
    <div class="modal" onClick={close}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Share "{item.name}"</h2>
        <p class="meta wrap">Anyone with a link can view and download this{item.kind === "folder" ? " folder and everything in it" : ""}, without signing in.</p>
        <ul class="list picker">
          {links.map((s) => (
            <li key={s.id}>
              <span class="main"><span class="name">{status(s)}</span></span>
              <button class="btn" onClick={() => copy(s)}>Copy</button>
              <button class="btn" onClick={() => revoke(s)}>Revoke</button>
            </li>
          ))}
          {!links.length && <li class="empty">No links yet</li>}
        </ul>
        <div class="row">
          <select value={days} onChange={(e) => setDays(e.currentTarget.value)} aria-label="Expires">
            <option value="1">Expires in 1 day</option><option value="7">Expires in 7 days</option><option value="30">Expires in 30 days</option><option value="never">Never expires</option>
          </select>
          <button class="btn primary" onClick={create}>New link</button>
        </div>
        {note && <p class="meta wrap" role="status">{note}</p>}
        <div class="row"><button class="btn" onClick={close}>Done</button></div>
      </div>
    </div>
  );
}
