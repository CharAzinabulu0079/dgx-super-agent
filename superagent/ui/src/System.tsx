/** System: Health · Models · Backup · Update · Cleanup — buttons for everything that repeats. */
import { useEffect, useState } from 'react'
import { api, fmtSize, upload, type BackupInfo, type CleanupItem, type HealthReport, type PresetView, type ProviderView } from './api.ts'
import { CodeBlock } from './Markdown.tsx'

export type SystemTab = 'health' | 'models' | 'backup' | 'update' | 'cleanup'
const TABS: Array<[SystemTab, string]> = [['health', 'Health'], ['models', 'Models'], ['backup', 'Backup'], ['update', 'Update'], ['cleanup', 'Cleanup']]
const ROLES = ['chief', 'planner', 'worker', 'reviewer', 'escalation']

export function SystemPanel({ initial = 'health', onClose, onError }: { initial?: SystemTab; onClose: () => void; onError: (e: string) => void }) {
  const [tab, setTab] = useState<SystemTab>(initial)
  return (
    <div className="modal" role="dialog" data-testid="system" onClick={onClose}>
      <div className="modal-body wide" onClick={e => e.stopPropagation()}>
        <header>
          <strong>System</strong>
          <div className="seg">{TABS.map(([t, l]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} data-testid={`sys-${t}`}>{l}</button>)}</div>
          <span className="spacer" /><button className="icon" onClick={onClose} data-testid="close-system">✕</button>
        </header>
        <div className="modal-content">
          {tab === 'health' && <Health onError={onError} go={setTab} />}
          {tab === 'models' && <Models onError={onError} />}
          {tab === 'backup' && <Backups onError={onError} />}
          {tab === 'update' && <Update onError={onError} />}
          {tab === 'cleanup' && <Cleanup onError={onError} />}
        </div>
      </div>
    </div>
  )
}

const ICON = { ok: '✓', warn: '!', fail: '✕' } as const

function Health({ onError, go }: { onError: (e: string) => void; go: (t: SystemTab) => void }) {
  const [r, setR] = useState<HealthReport | null>(null)
  const [busy, setBusy] = useState(false)
  const run = (deep = false) => {
    setBusy(true)
    ;(deep ? api<HealthReport>('POST', '/api/system/health', { deep: true }) : api<HealthReport>('GET', '/api/system/health')).then(setR, e => onError(String(e))).finally(() => setBusy(false))
  }
  useEffect(() => run(), [])
  const groups = [...new Set((r?.checks ?? []).map(c => c.group))]
  return (
    <div data-testid="health">
      <div className="row">
        {r && <span className={`overall ${r.overall}`} data-testid="health-overall">{r.overall === 'green' ? 'All good' : r.overall === 'yellow' ? 'Works, with warnings' : 'Not ready'}</span>}
        <span className="spacer" />
        <button disabled={busy} onClick={() => run()} data-testid="health-run">{busy ? 'Checking…' : 'Check again'}</button>
        <button disabled={busy} onClick={() => run(true)} title="Sends one tiny request to each configured model" data-testid="health-deep">Test models (uses a few tokens)</button>
      </div>
      {groups.map(g => (
        <section key={g} className="health-group">
          <h4>{g}</h4>
          <ul className="checks">{r!.checks.filter(c => c.group === g).map(c => (
            <li key={c.id} className={`check ${c.status}`} data-testid={`check-${c.id}`}>
              <span className="check-icon">{ICON[c.status]}</span>
              <div className="grow"><strong>{c.title}</strong> <span className="muted">{c.detail}</span>
                {c.fix && c.status !== 'ok' && (/^(sa |pnpm |npx |git |chmod )/.test(c.fix)
                  ? <CodeBlock lang="bash" code={c.fix.replace(/^sa /, 'pnpm sa ')} />
                  : <div className="fix">→ {c.fix}{/Cleanup/.test(c.fix) && <button className="small" onClick={() => go('cleanup')}>Open Cleanup</button>}{/Models/.test(c.fix) && <button className="small" onClick={() => go('models')}>Open Models</button>}</div>)}
              </div>
            </li>
          ))}</ul>
        </section>
      ))}
    </div>
  )
}

function Models({ onError }: { onError: (e: string) => void }) {
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [presets, setPresets] = useState<PresetView[]>([])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const load = () => {
    api<{ providers: ProviderView[] }>('GET', '/api/system/providers').then(r => setProviders(r.providers), e => onError(String(e)))
    api<{ presets: PresetView[] }>('GET', '/api/system/presets').then(r => setPresets(r.presets), e => onError(String(e)))
  }
  useEffect(load, [])
  const apply = (id: string) => api<{ presets: PresetView[] }>('POST', `/api/system/presets/${id}/apply`, {}).then(r => setPresets(r.presets), e => onError(String(e)))
  const models = ['local-default', ...providers.flatMap(p => p.models.map(m => `${p.name}/${m}`))]
  return (
    <div data-testid="models">
      <h4>Presets <span className="muted">— one click switches Chief, Planner, Workers, Reviewer and Escalation</span></h4>
      <div className="preset-cards">{presets.map(p => (
        <div key={p.id} className={`preset-card ${p.active ? 'active' : ''}`} data-testid={`preset-${p.id}`}>
          <div className="row"><strong>{p.name}</strong>{p.active && <span className="state passed">active</span>}</div>
          <div className="muted">{p.description}</div>
          <div className="mono small-text">{ROLES.filter(r => p.models[r]).map(r => `${r}: ${p.models[r]}`).join(' · ') || '—'}</div>
          {p.problems.length > 0 && <div className="warn-text">{p.problems.join('; ')}</div>}
          <button className="primary" disabled={!p.available || p.active} onClick={() => apply(p.id)} data-testid={`apply-${p.id}`}>{p.active ? 'In use' : 'Use'}</button>
        </div>
      ))}</div>
      <button onClick={() => setEditing(true)} data-testid="edit-presets">Edit presets</button>
      {editing && <PresetEditor presets={presets} models={models} onClose={() => setEditing(false)} onSaved={r => { setPresets(r); setEditing(false) }} onError={onError} />}

      <h4>Model servers</h4>
      <ul className="file-list">{providers.map(p => (
        <li key={p.name} data-testid={`provider-${p.name}`}>
          <div className="file-main"><strong>{p.name}</strong>{p.isLocalDefault && <span className="badge">local default</span>} <span className="muted">{p.api} · {p.baseURL} · {p.models.join(', ')} · {p.hasKey ? 'key saved' : 'no key'}</span></div>
          <button className="small danger" onClick={() => { if (confirm(`Remove ${p.name}?`)) api('POST', `/api/system/providers/${p.name}/delete`, {}).then(load, e => onError(String(e))) }}>Remove</button>
        </li>
      ))}</ul>
      {providers.length === 0 && <p className="muted">No model server yet. Add your DGX's OpenAI-compatible server (vLLM, SGLang, Ollama, LM Studio…) or an API provider.</p>}
      {adding ? <ProviderWizard onDone={() => { setAdding(false); load() }} onError={onError} /> : <button className="primary" onClick={() => setAdding(true)} data-testid="add-provider">＋ Add model server</button>}
    </div>
  )
}

function ProviderWizard({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const [f, setF] = useState({ name: 'dgx-local', api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1', apiKey: '' })
  const [probe, setProbe] = useState<{ ok: boolean; kind: string; detail: string; models: string[]; latencyMs: number } | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [tests, setTests] = useState<Record<string, string>>({})
  const [local, setLocal] = useState(true)
  const [busy, setBusy] = useState(false)
  const conn = { api: f.api, baseURL: f.baseURL, apiKey: f.apiKey || undefined }
  const doProbe = () => { setBusy(true); api<NonNullable<typeof probe>>('POST', '/api/system/providers/probe', conn).then(p => { setProbe(p); setPicked(p.models.slice(0, 1)) }, e => onError(String(e))).finally(() => setBusy(false)) }
  const test = (m: string) => api<{ ok: boolean; detail: string }>('POST', '/api/system/providers/test', { ...conn, model: m }).then(t => setTests(x => ({ ...x, [m]: `${t.ok ? '✓' : '✕'} ${t.detail}` })), e => onError(String(e)))
  const save = () => { setBusy(true); api('POST', '/api/system/providers', { ...conn, name: f.name, apiKey: f.apiKey, models: picked, makeLocalDefault: local }).then(onDone, e => onError(String(e))).finally(() => setBusy(false)) }
  return (
    <div className="card wizard" data-testid="provider-wizard">
      <div className="field"><div className="field-label">Name</div><input value={f.name} onChange={e => setF({ ...f, name: e.target.value.toLowerCase() })} data-testid="prov-name" /></div>
      <div className="field"><div className="field-label">Protocol</div>
        <select value={f.api} onChange={e => setF({ ...f, api: e.target.value })}><option value="openai-completions">OpenAI-compatible</option><option value="anthropic-messages">Anthropic-compatible</option></select></div>
      <div className="field"><div className="field-label">Base URL</div><input className="mono" value={f.baseURL} onChange={e => { setF({ ...f, baseURL: e.target.value }); setProbe(null) }} data-testid="prov-url" /></div>
      <div className="field"><div className="field-label">API key</div><input type="password" autoComplete="off" placeholder="(none for most local servers)" value={f.apiKey} onChange={e => { setF({ ...f, apiKey: e.target.value }); setProbe(null) }} data-testid="prov-key" /></div>
      <div className="row"><button className="primary" disabled={busy} onClick={doProbe} data-testid="prov-probe">{busy ? 'Connecting…' : 'Connect'}</button>
        {probe && <span className={probe.ok ? 'ok-text' : 'error-text'} data-testid="prov-result">{probe.ok ? '✓' : '✕'} {probe.detail}{probe.ok ? ` (${probe.latencyMs} ms)` : ''}</span>}</div>
      {probe?.ok && <>
        <div className="field"><div className="field-label">Models to use</div>
          <ul className="gate-list">{probe.models.slice(0, 50).map(m => (
            <li key={m}><label><input type="checkbox" checked={picked.includes(m)} onChange={() => setPicked(p => p.includes(m) ? p.filter(x => x !== m) : [...p, m])} data-testid={`prov-model-${m}`} /> <code>{m}</code></label>
              <button className="small" onClick={() => test(m)}>Test (1 token)</button> <span className="muted">{tests[m]}</span></li>
          ))}</ul>
        </div>
        <label><input type="checkbox" checked={local} onChange={e => setLocal(e.target.checked)} /> Make it the <strong>local default</strong> (used by the “All local” preset)</label>
        <div className="row-end"><button onClick={onDone}>Cancel</button><button className="primary" disabled={busy || !picked.length} onClick={save} data-testid="prov-save">Save</button></div>
      </>}
    </div>
  )
}

function PresetEditor({ presets, models, onClose, onSaved, onError }: { presets: PresetView[]; models: string[]; onClose: () => void; onSaved: (p: PresetView[]) => void; onError: (e: string) => void }) {
  const [draft, setDraft] = useState(presets.map(p => ({ id: p.id, name: p.name, description: p.description, models: { ...p.models } })))
  const set = (i: number, role: string, v: string) => setDraft(d => d.map((p, j) => (j === i ? { ...p, models: { ...p.models, [role]: v } } : p)))
  return (
    <div className="card wizard" data-testid="preset-editor">
      <table className="tasks"><thead><tr><th>Role</th>{draft.map(p => <th key={p.id}>{p.name}</th>)}</tr></thead>
        <tbody>{ROLES.map(role => (
          <tr key={role}><td>{role}</td>{draft.map((p, i) => (
            <td key={p.id}><select value={p.models[role] ?? ''} onChange={e => set(i, role, e.target.value)} data-testid={`pe-${p.id}-${role}`}>
              <option value="">—</option>{[...new Set([...models, p.models[role] ?? ''])].filter(Boolean).map(m => <option key={m} value={m}>{m}</option>)}
            </select></td>
          ))}</tr>
        ))}</tbody>
      </table>
      <div className="row-end"><button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => api<{ presets: PresetView[] }>('POST', '/api/system/presets', { presets: draft }).then(r => onSaved(r.presets), e => onError(String(e)))} data-testid="presets-save">Save presets</button></div>
    </div>
  )
}

function Backups({ onError }: { onError: (e: string) => void }) {
  const [list, setList] = useState<BackupInfo[]>([])
  const [label, setLabel] = useState('')
  const [secrets, setSecrets] = useState(false)
  const [sessions, setSessions] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const load = () => api<{ backups: BackupInfo[] }>('GET', '/api/system/backups').then(r => setList(r.backups), e => onError(String(e)))
  useEffect(() => { void load() }, [])
  const act = (p: Promise<{ backups: BackupInfo[] }>) => { setBusy(true); p.then(r => setList(r.backups), e => onError(String(e))).finally(() => setBusy(false)) }
  return (
    <div data-testid="backups">
      <div className="card wizard">
        <div className="row"><input className="grow" placeholder="label (optional)" value={label} onChange={e => setLabel(e.target.value)} />
          <button className="primary" disabled={busy} onClick={() => act(api('POST', '/api/system/backups', { label: label || 'manual', includeSecrets: secrets, includeSessions: sessions }))} data-testid="backup-create">{busy ? 'Working…' : 'Back up now'}</button></div>
        <label><input type="checkbox" checked={secrets} onChange={e => setSecrets(e.target.checked)} /> include secrets (API keys, agent token) — keep that file private</label>
        <label><input type="checkbox" checked={sessions} onChange={e => setSessions(e.target.checked)} /> include DSH sessions (Chief/Worker history; can be large)</label>
        <label className="upload-inline">Restore from a file…<input type="file" accept=".tar.gz,.tgz,application/gzip" onChange={e => { const f = e.target.files?.[0]; if (f) act(upload('/api/system/backups/upload', new File([f], f.name, { type: 'application/gzip' }))) }} /></label>
      </div>
      {note && <div className="ok-box">{note}</div>}
      <ul className="file-list">{list.map(b => (
        <li key={b.id} data-testid={`backup-${b.manifest.label}`}>
          <div className="file-main"><strong>{b.manifest.label}</strong> <span className="muted">{new Date(b.manifest.createdAt).toLocaleString()} · {fmtSize(b.size)} · v{b.manifest.appVersion ?? '?'}{b.manifest.includes.secrets ? ' · with secrets' : ''}</span></div>
          <div className="file-actions">
            <a className="button" href={b.url} data-testid="backup-download">Download</a>
            <button disabled={busy} onClick={() => { if (confirm(`Restore “${b.manifest.label}” from ${new Date(b.manifest.createdAt).toLocaleString()}? Your current state is backed up first.`)) { setBusy(true); api<{ preRestore: string; backups: BackupInfo[] }>('POST', `/api/system/backups/${b.id}/restore`, {}).then(r => { setList(r.backups); setNote(`Restored. The previous state was saved as ${r.preRestore}.`) }, e => onError(String(e))).finally(() => setBusy(false)) } }} data-testid="backup-restore">Restore</button>
            <button className="danger" disabled={busy} onClick={() => { if (confirm('Delete this backup?')) act(api('POST', `/api/system/backups/${b.id}/delete`, {})) }}>Delete</button>
          </div>
        </li>
      ))}</ul>
    </div>
  )
}

type UpdateState = {
  managed: boolean; supervised: boolean; hint?: string; running?: { appVersion?: string; commit?: string }
  state?: { current?: string; previous?: string; pendingVerify?: { id: string }; history: Array<{ at: string; action: string; from?: string; to?: string; note?: string }> }
  job?: { status: string; step: string; target: string; error?: string; release?: string }
}

function Update({ onError }: { onError: (e: string) => void }) {
  const [s, setS] = useState<UpdateState | null>(null)
  const [avail, setAvail] = useState<Array<{ ref: string; commit: string; newer: boolean }> | null>(null)
  const load = () => api<UpdateState>('GET', '/api/system/update').then(setS, e => onError(String(e)))
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (s?.job?.status !== 'running') return
    const t = setTimeout(load, 1000)
    return () => clearTimeout(t)
  }, [s])
  if (!s) return <p className="muted">Loading…</p>
  const restart = () => api('POST', '/api/system/restart', {}).then(() => onError('Restarting… the page reconnects in a few seconds.'), e => onError(String(e)))
  return (
    <div data-testid="update">
      <p>Running <strong>v{s.running?.appVersion ?? '?'}</strong> <span className="muted">({s.running?.commit ?? 'unknown commit'})</span>{s.state?.current && <> · release <code>{s.state.current}</code></>}</p>
      {!s.managed ? <div className="warn-box" data-testid="update-unmanaged">{s.hint}<CodeBlock lang="bash" code={'pnpm sa install --dir ~/superagent\n~/superagent/current/superagent/cli/src/main.ts service install --dir ~/superagent'} /></div> : <>
        <div className="row">
          <button onClick={() => api<{ available: typeof avail }>('POST', '/api/system/update/check', {}).then(r => setAvail(r.available), e => onError(String(e)))} data-testid="update-check">Check for updates</button>
          {s.state?.previous && <button onClick={() => { if (confirm(`Go back to ${s.state!.previous}?`)) api('POST', '/api/system/update/rollback', {}).then(load, e => onError(String(e))) }} data-testid="update-rollback">Roll back to {s.state.previous}</button>}
          {s.supervised && <button onClick={restart} data-testid="restart">Restart SuperAgent</button>}
        </div>
        {s.job && <div className={s.job.status === 'failed' ? 'warn-box' : 'ok-box'} data-testid="update-job">{s.job.target}: {s.job.status === 'running' ? `${s.job.step}…` : s.job.status === 'switched' ? (s.supervised ? 'installed — restarting' : 'installed — restart SuperAgent to use it') : `failed: ${s.job.error}`}</div>}
        {avail && <ul className="file-list">{avail.map(a => (
          <li key={a.ref}><div className="file-main"><strong>{a.ref}</strong> <span className="muted">{a.commit.slice(0, 7)}</span>{a.newer && <span className="badge">new</span>}</div>
            <button className="primary" disabled={!a.newer || s.job?.status === 'running'} onClick={() => { if (confirm(`Update to ${a.ref}? It is built next to the running version, your state is backed up, and it switches back automatically if the new version fails its start-up check.`)) api<{ job: UpdateState['job'] }>('POST', '/api/system/update', { ref: a.ref }).then(load, e => onError(String(e))) }}>Update</button></li>
        ))}</ul>}
        {!!s.state?.history.length && <details><summary>History</summary><ul className="events">{[...s.state.history].reverse().map((h, i) => <li key={i}><time>{new Date(h.at).toLocaleString()}</time> {h.action} {h.from ? `${h.from} → ` : ''}{h.to} <span className="muted">{h.note}</span></li>)}</ul></details>}
      </>}
    </div>
  )
}

function Cleanup({ onError }: { onError: (e: string) => void }) {
  const [items, setItems] = useState<CleanupItem[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [done, setDone] = useState<string | null>(null)
  const load = () => api<{ items: CleanupItem[] }>('GET', '/api/system/cleanup').then(r => { setItems(r.items); setSel(new Set(r.items.filter(i => i.count > 0 && i.kind !== 'old-backups').map(i => i.kind))) }, e => onError(String(e)))
  useEffect(() => { void load() }, [])
  return (
    <div data-testid="cleanup">
      <p className="muted">Nothing that running work, open tasks or pending learning still need is removed.</p>
      <ul className="gate-list">{items.map(i => (
        <li key={i.kind} data-testid={`clean-${i.kind}`}><label><input type="checkbox" disabled={!i.count} checked={sel.has(i.kind)} onChange={() => setSel(s => { const n = new Set(s); if (n.has(i.kind)) n.delete(i.kind); else n.add(i.kind); return n })} /> <strong>{i.label}</strong> — {i.count}{i.bytes ? ` · ${fmtSize(i.bytes)}` : ''}</label><div className="muted">{i.detail}</div></li>
      ))}</ul>
      {done && <div className="ok-box">{done}</div>}
      <div className="row-end"><button className="primary" disabled={!sel.size} onClick={() => api<{ done: CleanupItem[]; items: CleanupItem[] }>('POST', '/api/system/cleanup', { kinds: [...sel] }).then(r => { setDone(`Cleaned: ${r.done.map(d => `${d.label} (${d.count})`).join(', ') || 'nothing'}`); setItems(r.items); setSel(new Set()) }, e => onError(String(e)))} data-testid="clean-apply">Clean selected</button></div>
    </div>
  )
}
