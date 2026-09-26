/** System: Health · Models · Backup · Update · Cleanup — buttons for everything that repeats. */
import { useEffect, useState } from 'react'
import { api, fmtSize, upload, type BackupInfo, type CleanupItem, type HealthReport, type PresetView, type ProviderView } from './api.ts'
import { CodeBlock } from './Markdown.tsx'
import { t, tx } from './i18n.ts'

export type SystemTab = 'health' | 'models' | 'backup' | 'update' | 'cleanup'
const TABS: Array<[SystemTab, string]> = [['health', 'Health'], ['models', 'Models'], ['backup', 'Backup'], ['update', 'Update'], ['cleanup', 'Cleanup']]
const ROLES = ['chief', 'planner', 'worker', 'reviewer', 'escalation']

export function SystemPanel({ initial = 'health', onClose, onError }: { initial?: SystemTab; onClose: () => void; onError: (e: string) => void }) {
  const [tab, setTab] = useState<SystemTab>(initial)
  return (
    <div className="modal" role="dialog" data-testid="system" onClick={onClose}>
      <div className="modal-body wide" onClick={e => e.stopPropagation()}>
        <header>
          <strong>{t('System')}</strong>
          <div className="seg">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`sys-${k}`}>{t(l)}</button>)}</div>
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
        {r && <span className={`overall ${r.overall}`} data-testid="health-overall">{r.overall === 'green' ? t('All good') : r.overall === 'yellow' ? t('Works, with warnings') : t('Not ready')}</span>}
        <span className="spacer" />
        <button disabled={busy} onClick={() => run()} data-testid="health-run">{busy ? t('Checking…') : t('Check again')}</button>
        <button disabled={busy} onClick={() => run(true)} title={t('Sends one tiny request to each configured model')} data-testid="health-deep">{t('Test models (uses a few tokens)')}</button>
      </div>
      {groups.map(g => (
        <section key={g} className="health-group">
          <h4>{t(g)}</h4>
          <ul className="checks">{r!.checks.filter(c => c.group === g).map(c => (
            <li key={c.id} className={`check ${c.status}`} data-testid={`check-${c.id}`}>
              <span className="check-icon">{ICON[c.status]}</span>
              <div className="grow"><strong>{tx(c.title)}</strong> <span className="muted">{tx(c.detail)}</span>
                {c.fix && c.status !== 'ok' && (/^(sa |pnpm |npx |git |chmod )/.test(c.fix)
                  ? <CodeBlock lang="bash" code={c.fix.replace(/^sa /, 'pnpm sa ')} />
                  : <div className="fix">→ {tx(c.fix)}{/Cleanup/.test(c.fix) && <button className="small" onClick={() => go('cleanup')}>{t('Open Cleanup')}</button>}{/Models/.test(c.fix) && <button className="small" onClick={() => go('models')}>{t('Open Models')}</button>}</div>)}
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
      <h4>{t('Presets')} <span className="muted">{t('— one click switches Chief, Planner, Workers, Reviewer and Escalation')}</span></h4>
      <div className="preset-cards">{presets.map(p => (
        <div key={p.id} className={`preset-card ${p.active ? 'active' : ''}`} data-testid={`preset-${p.id}`}>
          <div className="row"><strong>{t(p.name)}</strong>{p.active && <span className="state passed">{t('active')}</span>}</div>
          <div className="muted">{t(p.description)}</div>
          <div className="mono small-text">{ROLES.filter(r => p.models[r]).map(r => `${t(r)}: ${p.models[r]}`).join(' · ') || '—'}</div>
          {p.problems.length > 0 && <div className="warn-text">{p.problems.map(x => t(x)).join('; ')}</div>}
          <button className="primary" disabled={!p.available || p.active} onClick={() => apply(p.id)} data-testid={`apply-${p.id}`}>{p.active ? t('In use') : t('Use')}</button>
        </div>
      ))}</div>
      <button onClick={() => setEditing(true)} data-testid="edit-presets">{t('Edit presets')}</button>
      {editing && <PresetEditor presets={presets} models={models} onClose={() => setEditing(false)} onSaved={r => { setPresets(r); setEditing(false) }} onError={onError} />}

      <h4>{t('Model servers')}</h4>
      <ul className="file-list">{providers.map(p => (
        <li key={p.name} data-testid={`provider-${p.name}`}>
          <div className="file-main"><strong>{p.name}</strong>{p.isLocalDefault && <span className="badge">{t('local default')}</span>} <span className="muted">{p.api} · {p.baseURL} · {p.models.join(', ')} · {p.hasKey ? t('key saved') : t('no key')}</span></div>
          <button className="small danger" onClick={() => { if (confirm(t('Remove {name}?', { name: p.name }))) api('POST', `/api/system/providers/${p.name}/delete`, {}).then(load, e => onError(String(e))) }}>{t('Remove')}</button>
        </li>
      ))}</ul>
      {providers.length === 0 && <p className="muted">{t('No model server yet. Add your DGX\'s OpenAI-compatible server (vLLM, SGLang, Ollama, LM Studio…) or an API provider.')}</p>}
      {adding ? <ProviderWizard onDone={() => { setAdding(false); load() }} onError={onError} /> : <button className="primary" onClick={() => setAdding(true)} data-testid="add-provider">{t('＋ Add model server')}</button>}
    </div>
  )
}

/** Common providers: one click fills protocol, address and a name (models are suggestions; edit freely). */
const TEMPLATES: Array<{ id: string; label: string; api: string; baseURL: string; models: string[]; keyUrl?: string }> = [
  { id: 'local', label: 'Local server (vLLM / llama.cpp / Ollama)', api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1', models: [] },
  { id: 'deepseek-api', label: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openai', label: 'OpenAI', api: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', models: [], keyUrl: 'https://openrouter.ai/keys' },
  { id: 'bailian', label: 'Alibaba Bailian (Qwen)', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen3-coder-plus'] },
  { id: 'moonshot', label: 'Moonshot (Kimi)', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', models: [] },
  { id: 'zhipu', label: 'Zhipu (GLM)', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4.5-air'] },
  { id: 'siliconflow', label: 'SiliconFlow', api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', models: [] },
  { id: 'volcengine', label: 'Volcengine Ark (Doubao)', api: 'openai-completions', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: [] },
]
/** Names the server keeps for DSH's own routes. */
const RESERVED = ['local-default', 'deepseek', 'deepseek-official']
/** Any typed name → a valid provider id (lowercase, digits, dashes; never a reserved one). */
export function providerId(raw: string): string {
  const id = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'provider'
  return RESERVED.includes(id) ? `${id}-api` : /^[a-z0-9]/.test(id) ? id : `p-${id}`
}

function ProviderWizard({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const [tpl, setTpl] = useState('local')
  const [f, setF] = useState({ name: 'dgx-local', api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1', apiKey: '' })
  const [probe, setProbe] = useState<{ ok: boolean; kind: string; detail: string; models: string[]; latencyMs: number } | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState('')
  const [tests, setTests] = useState<Record<string, string>>({})
  const [local, setLocal] = useState(true)
  const [busy, setBusy] = useState(false)
  // Errors are shown here, inside the wizard, not only in the page banner.
  const [err, setErr] = useState<string | null>(null)
  const fail = (e: unknown) => { const m = tx(String((e as Error)?.message ?? e).replace(/^Error: /, '')); setErr(m); onError(m) }
  const conn = { api: f.api, baseURL: f.baseURL, apiKey: f.apiKey || undefined }
  const pickTemplate = (id: string) => {
    const x = TEMPLATES.find(y => y.id === id)!
    setTpl(id); setProbe(null); setErr(null); setTests({})
    setF({ ...f, name: id === 'local' ? 'dgx-local' : x.id, api: x.api, baseURL: x.baseURL })
    setPicked(x.models.slice(0, 1)); setLocal(id === 'local')
  }
  const doProbe = () => {
    setBusy(true); setErr(null)
    api<NonNullable<typeof probe>>('POST', '/api/system/providers/probe', conn).then(p => { setProbe(p); if (p.ok && !picked.length) setPicked(p.models.slice(0, 1)) }, fail).finally(() => setBusy(false))
  }
  const test = (m: string) => api<{ ok: boolean; detail: string }>('POST', '/api/system/providers/test', { ...conn, model: m }).then(r => setTests(x => ({ ...x, [m]: `${r.ok ? '✓' : '✕'} ${tx(r.detail)}` })), fail)
  const addManual = () => { const m = manual.trim(); if (m && !picked.includes(m)) setPicked(p => [...p, m]); setManual('') }
  const save = () => {
    setBusy(true); setErr(null)
    api('POST', '/api/system/providers', { ...conn, name: providerId(f.name), apiKey: f.apiKey, models: picked, makeLocalDefault: local }).then(onDone, fail).finally(() => setBusy(false))
  }
  const listed = probe?.ok ? probe.models : []
  const shown = listed.filter(m => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 200)
  const suggestions = TEMPLATES.find(x => x.id === tpl)?.models ?? []
  const choices = [...new Set([...picked, ...shown, ...(listed.length ? [] : suggestions)])]
  const keyUrl = TEMPLATES.find(x => x.id === tpl)?.keyUrl
  return (
    <div className="card wizard" data-testid="provider-wizard">
      <div className="provider-templates">{TEMPLATES.map(x => <button key={x.id} className={`small ${tpl === x.id ? 'on' : ''}`} onClick={() => pickTemplate(x.id)} data-testid={`tpl-${x.id}`}>{t(x.label)}</button>)}</div>
      <div className="field"><div className="field-label">{t('Name')}</div><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} data-testid="prov-name" />
        {providerId(f.name) !== f.name && <div className="muted">{t('saved as {id}', { id: providerId(f.name) })}</div>}</div>
      <div className="field"><div className="field-label">{t('Protocol')}</div>
        <select value={f.api} onChange={e => setF({ ...f, api: e.target.value })}><option value="openai-completions">{t('OpenAI-compatible')}</option><option value="anthropic-messages">{t('Anthropic-compatible')}</option></select></div>
      <div className="field"><div className="field-label">{t('Base URL')}</div><input className="mono" value={f.baseURL} onChange={e => { setF({ ...f, baseURL: e.target.value }); setProbe(null) }} data-testid="prov-url" /></div>
      <div className="field"><div className="field-label">{t('API key')}</div><div>
        <input type="password" autoComplete="off" placeholder={t('(none for most local servers)')} value={f.apiKey} onChange={e => { setF({ ...f, apiKey: e.target.value }); setProbe(null) }} data-testid="prov-key" />
        {keyUrl && <div className="muted">{t('Get a key: ')}<a href={keyUrl} target="_blank" rel="noreferrer">{keyUrl}</a></div>}</div></div>
      <div className="row"><button className="primary" disabled={busy} onClick={doProbe} data-testid="prov-probe">{busy ? t('Connecting…') : t('Connect')}</button>
        {probe && <span className={probe.ok ? 'ok-text' : 'error-text'} data-testid="prov-result">{probe.ok ? '✓' : '✕'} {tx(probe.detail)}{probe.ok ? ` (${probe.latencyMs} ms)` : ''}</span>}</div>
      {probe && !probe.ok && probe.kind !== 'unauthorized' && <p className="muted">{t('No model list from this address — you can still type the model name below, test it and save.')}</p>}
      <div className="field"><div className="field-label">{t('Models to use')}</div><div>
        {listed.length > 12 && <input placeholder={t('search {n} models…', { n: listed.length })} value={filter} onChange={e => setFilter(e.target.value)} data-testid="prov-filter" />}
        <ul className="gate-list model-pick">{choices.map(m => (
          <li key={m}><label><input type="checkbox" checked={picked.includes(m)} onChange={() => setPicked(p => p.includes(m) ? p.filter(x => x !== m) : [...p, m])} data-testid={`prov-model-${m}`} /> <code>{m}</code></label>
            <button className="small" onClick={() => test(m)}>{t('Test (1 token)')}</button> <span className="muted">{tests[m]}</span></li>
        ))}</ul>
        <div className="row"><input className="grow mono" placeholder={t('or type a model name, e.g. deepseek-chat')} value={manual} onChange={e => setManual(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addManual() }} data-testid="prov-manual" /><button className="small" onClick={addManual} disabled={!manual.trim()}>{t('Add')}</button></div>
      </div></div>
      <label><input type="checkbox" checked={local} onChange={e => setLocal(e.target.checked)} /> {t('Make it the <local default> (used by the “All local” preset)').split(/[<>]/).map((x, i) => (i === 1 ? <strong key={i}>{x}</strong> : x))}</label>
      {err && <div className="warn-box" data-testid="prov-error">{err}</div>}
      <div className="row-end"><button onClick={onDone}>{t('Cancel')}</button><button className="primary" disabled={busy || !picked.length} title={picked.length ? '' : t('pick or type at least one model')} onClick={save} data-testid="prov-save">{t('Save')}</button></div>
    </div>
  )
}

function PresetEditor({ presets, models, onClose, onSaved, onError }: { presets: PresetView[]; models: string[]; onClose: () => void; onSaved: (p: PresetView[]) => void; onError: (e: string) => void }) {
  const [draft, setDraft] = useState(presets.map(p => ({ id: p.id, name: p.name, description: p.description, models: { ...p.models } })))
  const set = (i: number, role: string, v: string) => setDraft(d => d.map((p, j) => (j === i ? { ...p, models: { ...p.models, [role]: v } } : p)))
  return (
    <div className="card wizard" data-testid="preset-editor">
      <table className="tasks"><thead><tr><th>{t('Role')}</th>{draft.map(p => <th key={p.id}>{t(p.name)}</th>)}</tr></thead>
        <tbody>{ROLES.map(role => (
          <tr key={role}><td>{t(role)}</td>{draft.map((p, i) => (
            <td key={p.id}><select value={p.models[role] ?? ''} onChange={e => set(i, role, e.target.value)} data-testid={`pe-${p.id}-${role}`}>
              <option value="">—</option>{[...new Set([...models, p.models[role] ?? ''])].filter(Boolean).map(m => <option key={m} value={m}>{m}</option>)}
            </select></td>
          ))}</tr>
        ))}</tbody>
      </table>
      <div className="row-end"><button onClick={onClose}>{t('Cancel')}</button>
        <button className="primary" onClick={() => api<{ presets: PresetView[] }>('POST', '/api/system/presets', { presets: draft }).then(r => onSaved(r.presets), e => onError(String(e)))} data-testid="presets-save">{t('Save presets')}</button></div>
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
        <div className="row"><input className="grow" placeholder={t('label (optional)')} value={label} onChange={e => setLabel(e.target.value)} />
          <button className="primary" disabled={busy} onClick={() => act(api('POST', '/api/system/backups', { label: label || 'manual', includeSecrets: secrets, includeSessions: sessions }))} data-testid="backup-create">{busy ? t('Working…') : t('Back up now')}</button></div>
        <label><input type="checkbox" checked={secrets} onChange={e => setSecrets(e.target.checked)} /> {t('include secrets (API keys, agent token) — keep that file private')}</label>
        <label><input type="checkbox" checked={sessions} onChange={e => setSessions(e.target.checked)} /> {t('include DSH sessions (Chief/Worker history; can be large)')}</label>
        <label className="upload-inline">{t('Restore from a file…')}<input type="file" accept=".tar.gz,.tgz,application/gzip" onChange={e => { const f = e.target.files?.[0]; if (f) act(upload('/api/system/backups/upload', new File([f], f.name, { type: 'application/gzip' }))) }} /></label>
      </div>
      {note && <div className="ok-box">{note}</div>}
      <ul className="file-list">{list.map(b => (
        <li key={b.id} data-testid={`backup-${b.manifest.label}`}>
          <div className="file-main"><strong>{b.manifest.label}</strong> <span className="muted">{new Date(b.manifest.createdAt).toLocaleString()} · {fmtSize(b.size)} · v{b.manifest.appVersion ?? '?'}{b.manifest.includes.secrets ? t(' · with secrets') : ''}</span></div>
          <div className="file-actions">
            <a className="button" href={b.url} data-testid="backup-download">{t('Download')}</a>
            <button disabled={busy} onClick={() => { if (confirm(t('Restore “{label}” from {at}? Your current state is backed up first.', { label: b.manifest.label, at: new Date(b.manifest.createdAt).toLocaleString() }))) { setBusy(true); api<{ preRestore: string; backups: BackupInfo[] }>('POST', `/api/system/backups/${b.id}/restore`, {}).then(r => { setList(r.backups); setNote(t('Restored. The previous state was saved as {id}.', { id: r.preRestore })) }, e => onError(String(e))).finally(() => setBusy(false)) } }} data-testid="backup-restore">{t('Restore')}</button>
            <button className="danger" disabled={busy} onClick={() => { if (confirm(t('Delete this backup?'))) act(api('POST', `/api/system/backups/${b.id}/delete`, {})) }}>{t('Delete')}</button>
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
  const [waiting, setWaiting] = useState<{ ref: string; since: string; busy?: string } | null>(null)
  const load = () => {
    api<UpdateState>('GET', '/api/system/update').then(setS, e => onError(String(e)))
    api<{ waiting?: typeof waiting }>('GET', '/api/system/update/waiting').then(r => setWaiting(r.waiting ?? null), () => {})
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (s?.job?.status !== 'running' && !waiting) return
    const timer = setTimeout(load, s?.job?.status === 'running' ? 1000 : 3000)
    return () => clearTimeout(timer)
  }, [s, waiting])
  const startUpdate = (ref: string) => api<{ job?: UpdateState['job']; waiting?: typeof waiting }>('POST', '/api/system/update', { ref, whenIdle: true })
    .then(r => { setWaiting(r.waiting ?? null); load() }, e => onError(String(e)))
  if (!s) return <p className="muted">{t('Loading…')}</p>
  const restart = () => api('POST', '/api/system/restart', {}).then(() => onError(t('Restarting… the page reconnects in a few seconds.')), e => onError(String(e)))
  return (
    <div data-testid="update">
      <p>{t('Running')} <strong>v{s.running?.appVersion ?? '?'}</strong> <span className="muted">({s.running?.commit ?? t('unknown commit')})</span>{s.state?.current && <>{t(' · release ')}<code>{s.state.current}</code></>}</p>
      {!s.managed ? <div className="warn-box" data-testid="update-unmanaged">{s.hint}<CodeBlock lang="bash" code={'pnpm sa install --dir ~/superagent\n~/superagent/current/superagent/cli/src/main.ts service install --dir ~/superagent'} /></div> : <>
        <div className="row">
          <button onClick={() => api<{ available: typeof avail }>('POST', '/api/system/update/check', {}).then(r => setAvail(r.available), e => onError(String(e)))} data-testid="update-check">{t('Check for updates')}</button>
          {s.state?.previous && <button onClick={() => { if (confirm(t('Go back to {v}?', { v: s.state!.previous }))) api('POST', '/api/system/update/rollback', {}).then(load, e => onError(String(e))) }} data-testid="update-rollback">{t('Roll back to {v}', { v: s.state.previous })}</button>}
          {s.supervised && <button onClick={restart} data-testid="restart">{t('Restart SuperAgent')}</button>}
        </div>
        {s.job && <div className={s.job.status === 'failed' ? 'warn-box' : 'ok-box'} data-testid="update-job">{s.job.target}: {s.job.status === 'running' ? `${s.job.step}…` : s.job.status === 'switched' ? (s.supervised ? t('installed — restarting') : t('installed — restart SuperAgent to use it')) : t('failed: {e}', { e: s.job.error })}</div>}
        {waiting && <div className="ok-box" data-testid="update-waiting">{t('Waiting to update to {ref}: the task in progress finishes first, no new task starts; queued work resumes after the update.', { ref: waiting.ref })}{waiting.busy && <div className="muted">{t('now: {b}', { b: waiting.busy })}</div>}
          <div className="row"><button className="small" onClick={() => api('POST', '/api/system/update/waiting/cancel', {}).then(() => { setWaiting(null); load() }, e => onError(String(e)))} data-testid="update-waiting-cancel">{t('Cancel waiting')}</button></div></div>}
        {avail && <ul className="file-list">{avail.map(a => (
          <li key={a.ref}><div className="file-main"><strong>{a.ref}</strong> <span className="muted">{a.commit.slice(0, 7)}</span>{a.newer && <span className="badge">{t('new')}</span>}</div>
            <button className="primary" disabled={!a.newer || s.job?.status === 'running'} onClick={() => { if (confirm(t('Update to {ref}? It is built next to the running version, your state is backed up, and it switches back automatically if the new version fails its start-up check.', { ref: a.ref }))) startUpdate(a.ref) }}>{t('Update')}</button></li>
        ))}</ul>}
        {!!s.state?.history.length && <details><summary>{t('History')}</summary><ul className="events">{[...s.state.history].reverse().map((h, i) => <li key={i}><time>{new Date(h.at).toLocaleString()}</time> {t(h.action)} {h.from ? `${h.from} → ` : ''}{h.to} <span className="muted">{h.note}</span></li>)}</ul></details>}
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
      <p className="muted">{t('Nothing that running work, open tasks or pending learning still need is removed.')}</p>
      <ul className="gate-list">{items.map(i => (
        <li key={i.kind} data-testid={`clean-${i.kind}`}><label><input type="checkbox" disabled={!i.count} checked={sel.has(i.kind)} onChange={() => setSel(s => { const n = new Set(s); if (n.has(i.kind)) n.delete(i.kind); else n.add(i.kind); return n })} /> <strong>{t(i.label)}</strong> — {i.count}{i.bytes ? ` · ${fmtSize(i.bytes)}` : ''}</label><div className="muted">{tx(i.detail)}</div></li>
      ))}</ul>
      {done && <div className="ok-box">{done}</div>}
      <div className="row-end"><button className="primary" disabled={!sel.size} onClick={() => api<{ done: CleanupItem[]; items: CleanupItem[] }>('POST', '/api/system/cleanup', { kinds: [...sel] }).then(r => { setDone(t('Cleaned: {list}', { list: r.done.map(d => `${t(d.label)} (${d.count})`).join(', ') || t('nothing') })); setItems(r.items); setSel(new Set()) }, e => onError(String(e)))} data-testid="clean-apply">{t('Clean selected')}</button></div>
    </div>
  )
}
