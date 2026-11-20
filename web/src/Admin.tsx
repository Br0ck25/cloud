import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { Backup, Person } from "./api";
import type { Ask } from "./AskSheet";
import { size } from "./format";

/** Admin screen: who can sign in, and how much storage each person uses. */
export function Admin({ me, ask, backedUp }: { me: number; ask: (a: Ask) => void; backedUp: () => void }) {
  const [data, setData] = useState<{ users: Person[]; family_bytes: number; total_bytes: number; backup: Backup } | null>(null);
  const [busy, setBusy] = useState(false);
  const [handing, setHanding] = useState<Person | null>(null); // a removed person whose files are being handed over
  const [target, setTarget] = useState("family");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const load = () => api.admin().then(setData, (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = (p: Promise<unknown>) => p.then(load, (e) => setError(e.message));
  const runBackup = () => { setBusy(true); setError(""); api.backupNow().then(() => { load(); backedUp(); }, (e) => setError(e.message)).finally(() => setBusy(false)); };
  const go = () => handing && api.handOver(handing.id, target === "family" ? "family" : Number(target)).then(
    (r) => { setHanding(null); setMsg(r.folder ? `Moved ${r.moved} ${r.moved === 1 ? "item" : "items"} into "${r.folder}".` : "They have no files to hand over."); load(); },
    (e) => setMsg(e.message));
  if (error) return <p class="error">{error}</p>;
  if (!data) return null;
  const b = data.backup;
  return (
    <>
      {msg && !handing && <p class="notice" role="status" onClick={() => setMsg("")}>{msg}</p>}
      <div class="bar"><button class="btn primary" onClick={() => ask({ title: "Add a family member (email)", value: "", ok: (e) => act(api.addPerson(e)) })}>Add person</button></div>
      <ul class="list">
        <li><span class="main"><span class="tile">💾</span><span class="name">Total storage</span></span><span class="meta">{size(data.total_bytes)}</span></li>
        <li><span class="main"><span class="tile">👪</span><span class="name">Family folder</span></span><span class="meta">{size(data.family_bytes)}</span></li>
        <li>
          <span class="main"><span class="tile">🛟</span>
            <span class="stack">
              <span class="name">Backup</span>
              <span class="meta wrap">
                {b.ran_at ? `Last run ${new Date(b.ran_at * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Not run yet"}
                {` · ${b.files} files (${size(b.bytes)}) copied`}
                {b.waiting - b.too_big > 0 ? ` · ${b.waiting - b.too_big} waiting` : ""}
                {b.kept_after_delete ? ` · ${b.kept_after_delete} kept after deletion` : ""}
                {b.too_big ? ` · ${b.too_big} too large to copy` : ""}
                {b.repaired ? ` · ${b.repaired} re-copied after going missing` : ""}
              </span>
              {b.failed > 0 && <span class="error meta wrap">{b.failed} problems in the last run</span>}
            </span>
          </span>
          <button class="btn" disabled={busy} onClick={runBackup}>{busy ? "Working…" : "Back up now"}</button>
        </li>
        {data.users.map((u) => (
          <li key={u.id} class={u.active ? "" : "off"}>
            <span class="main"><span class="tile">👤</span><span class="name">{u.email}</span></span>
            <span class="meta">{u.active ? (u.role === "admin" ? "Admin · " : "") + size(u.bytes) : "No access"}</span>
            {u.id !== me && (
              <details class="more"><summary aria-label="Actions">⋮</summary>
                <div class="menu" onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
                  {u.active ? <button onClick={() => act(api.editPerson(u.id, { active: false }))}>Remove access</button> : <button onClick={() => act(api.editPerson(u.id, { active: true }))}>Restore access</button>}
                  {!u.active && u.bytes > 0 && <button onClick={() => { setMsg(""); setTarget(String(me)); setHanding(u); }}>Hand over files…</button>}
                  {u.active ? <button onClick={() => act(api.editPerson(u.id, { role: u.role === "admin" ? "member" : "admin" }))}>{u.role === "admin" ? "Make member" : "Make admin"}</button> : null}
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
      {handing && (
        <div class="modal" onClick={() => setHanding(null)}>
          <div class="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Hand over files</h2>
            <p class="meta wrap">Everything {handing.email} owns ({size(handing.bytes)}) goes into a new folder called "Files from {handing.email}".</p>
            <select aria-label="Hand over to" value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
              {data.users.filter((u) => u.active).map((u) => <option key={u.id} value={String(u.id)}>{u.id === me ? "Me" : u.email}</option>)}
              <option value="family">The Family folder (everyone)</option>
            </select>
            {msg && <p class="error meta wrap">{msg}</p>}
            <div class="row"><button class="btn" onClick={() => setHanding(null)}>Cancel</button><button class="btn primary" onClick={go}>Hand over</button></div>
          </div>
        </div>
      )}
    </>
  );
}
