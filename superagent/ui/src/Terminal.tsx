/** Run commands in the project on the server (from any device) and see past runs. */
import { useEffect, useState, type FormEvent } from 'react'
import { api, type CommandRecord } from './api.ts'
import { CommandOutput, RunSheet } from './Run.tsx'
import { t } from './i18n.ts'

export function TerminalPanel({ projectId, root, refreshKey, onError }: { projectId: string; root: string; refreshKey: number; onError: (e: string) => void }) {
  const [cmd, setCmd] = useState('')
  const [sheet, setSheet] = useState<string | null>(null)
  const [history, setHistory] = useState<CommandRecord[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { api<CommandRecord[]>('GET', `/api/projects/${projectId}/commands`).then(h => { setHistory(h); if (!open && h[0]) setOpen(h[0].id) }, e => onError(String(e))) }, [projectId, refreshKey])
  const submit = (e: FormEvent) => { e.preventDefault(); if (cmd.trim()) setSheet(cmd.trim()) }
  return (
    <section className="card" data-testid="terminal">
      <h3>{t('Terminal')} <span className="muted">— {root}</span></h3>
      <form className="term-input" onSubmit={submit}>
        <span className="prompt">$</span>
        <input className="mono" placeholder="npm test, git status, ls -la …" value={cmd} onChange={e => setCmd(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="term-input" />
        <button type="submit" className="primary" disabled={!cmd.trim()} data-testid="term-run">▷</button>
      </form>
      <ul className="cmd-list">
        {history.map(h => (
          <li key={h.id}>
            <button className="link mono" onClick={() => setOpen(open === h.id ? null : h.id)}>
              <span className={`dot ${h.status === 'running' ? 'run' : h.status === 'exited' && h.exitCode === 0 ? 'ok' : 'bad'}`} />$ {h.command}
            </button>
            <span className="muted"> {new Date(h.startedAt).toLocaleTimeString()}{h.flagged ? t(' · flagged') : ''}</span>
            {open === h.id && <CommandOutput projectId={projectId} record={h} />}
          </li>
        ))}
      </ul>
      {sheet && <RunSheet projectId={projectId} command={sheet} onClose={() => { setSheet(null); setCmd(''); api<CommandRecord[]>('GET', `/api/projects/${projectId}/commands`).then(h => { setHistory(h); if (h[0]) setOpen(h[0].id) }, () => {}) }} />}
    </section>
  )
}
