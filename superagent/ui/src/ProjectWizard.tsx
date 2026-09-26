/** Add a project: pick a folder on the server → scan → review the proposed checks → create. */
import { useEffect, useState } from 'react'
import { api, type ProjectScan } from './api.ts'

type Dirs = { path: string; parent?: string; home: string; entries: Array<{ name: string; path: string; git: boolean }> }

export function ProjectWizard({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (id: string) => void; onError: (e: string) => void }) {
  const [root, setRoot] = useState('')
  const [dirs, setDirs] = useState<Dirs | null>(null)
  const [scan, setScan] = useState<ProjectScan | null>(null)
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const browse = (path?: string) => api<Dirs>('GET', `/api/system/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`).then(setDirs, e => onError(String(e)))
  useEffect(() => { void browse() }, [])
  const doScan = (r = root) => {
    if (!r.trim()) return
    setBusy(true)
    api<ProjectScan>('POST', '/api/system/scan', { root: r.trim() }).then(s => {
      setScan(s); setRoot(s.root); setName(s.name); setChosen(new Set(s.gates.filter(g => g.recommended).map(g => g.spec.id)))
    }, e => onError(String(e))).finally(() => setBusy(false))
  }
  const gitInit = () => { setBusy(true); api<ProjectScan>('POST', '/api/system/scan/git-init', { root }).then(setScan, e => onError(String(e))).finally(() => setBusy(false)) }
  const create = () => {
    if (!scan) return
    setBusy(true)
    api<{ id: string }>('POST', '/api/projects', { name, root: scan.root, defaultGates: scan.gates.filter(g => chosen.has(g.spec.id)).map(g => g.spec) })
      .then(p => { onCreated(p.id); onClose() }, e => onError(String(e))).finally(() => setBusy(false))
  }
  const toggle = (id: string) => setChosen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div className="modal" role="dialog" data-testid="project-wizard" onClick={onClose}>
      <div className="modal-body" onClick={e => e.stopPropagation()}>
        <header><strong>Add a project</strong><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></header>
        <div className="modal-content settings">
          <div className="field"><div className="field-label">Folder on the server</div>
            <div className="row">
              <input className="grow mono" placeholder="/home/you/code/my-app" value={root} onChange={e => { setRoot(e.target.value); setScan(null) }} onKeyDown={e => { if (e.key === 'Enter') doScan() }} data-testid="new-project-root" />
              <button className="primary" disabled={busy || !root.trim()} onClick={() => doScan()} data-testid="scan-project">Scan</button>
            </div>
          </div>
          {!scan && dirs && (
            <div className="picker" data-testid="dir-picker">
              <div className="picker-head"><code>{dirs.path}</code>{dirs.parent && <button className="small" onClick={() => browse(dirs.parent)}>↑ up</button>}<button className="small" onClick={() => browse(dirs.home)}>~</button></div>
              <ul>{dirs.entries.map(d => (
                <li key={d.path}>
                  <button className="link" onClick={() => browse(d.path)}>📁 {d.name}</button>{d.git && <span className="badge">git</span>}
                  <button className="small" onClick={() => { setRoot(d.path); doScan(d.path) }} data-testid={`pick-${d.name}`}>Use</button>
                </li>
              ))}</ul>
            </div>
          )}
          {scan && <>
            {scan.warnings.map(w => <div key={w} className="warn-box">⚠ {w}{/not a git repository/.test(w) && <button className="small" onClick={gitInit} disabled={busy} data-testid="git-init">Initialize git</button>}</div>)}
            <div className="field"><div className="field-label">Name</div><input value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} data-testid="new-project-name" /></div>
            <div className="field"><div className="field-label">Found</div>
              <div className="muted">
                {scan.languages.slice(0, 4).map(l => `${l.name} (${l.files})`).join(', ') || 'no source files'}
                {scan.packageManager && ` · ${scan.packageManager}`}
                {scan.git.isRepo && ` · git ${scan.git.branch ?? ''}${scan.git.dirty ? ` (${scan.git.dirty} uncommitted)` : ''}`}
                {scan.architecture.declared && ' · declared architecture'}
                {scan.browser.reason && ` · ${scan.browser.reason}`}
              </div>
            </div>
            <div className="field"><div className="field-label">Checks that decide “done”</div>
              <ul className="gate-list" data-testid="proposed-gates">{scan.gates.map(g => (
                <li key={g.spec.id}>
                  <label><input type="checkbox" checked={chosen.has(g.spec.id)} onChange={() => toggle(g.spec.id)} data-testid={`gate-${g.spec.id}`} /> <strong>{g.spec.id}</strong> {g.spec.command && <code>{g.spec.command}</code>}</label>
                  <div className="muted">{g.reason}{g.recommended ? '' : ' (optional)'}</div>
                </li>
              ))}</ul>
            </div>
            <div className="row-end">
              <button onClick={() => setScan(null)}>Back</button>
              <button className="primary" disabled={busy || !name || !scan.git.isRepo || !!scan.registeredAs} onClick={create} data-testid="add-project">Create project</button>
            </div>
          </>}
        </div>
      </div>
    </div>
  )
}
