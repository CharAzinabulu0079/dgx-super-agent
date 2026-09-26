/** Confirm → run → live output for a human-run command on the server (project root). */
import { useEffect, useRef, useState } from 'react'
import { api, type CommandRecord } from './api.ts'

export function RunSheet({ projectId, command, onClose }: { projectId: string; command: string; onClose: () => void }) {
  const [text, setText] = useState(command)
  const [check, setCheck] = useState<{ allowWithoutConfirm: boolean; category?: string; rule?: string } | null>(null)
  const [ack, setAck] = useState(false)
  const [running, setRunning] = useState<CommandRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setAck(false)
    const t = setTimeout(() => { api<typeof check>('POST', `/api/projects/${projectId}/commands/check`, { command: text }).then(setCheck, e => setError(String(e))) }, 250)
    return () => clearTimeout(t)
  }, [text])
  const start = () => api<CommandRecord>('POST', `/api/projects/${projectId}/commands`, { command: text, confirmDanger: ack }).then(setRunning, e => setError(String(e)))
  return (
    <div className="modal" role="dialog" data-testid="run-sheet" onClick={onClose}>
      <div className="modal-body" onClick={e => e.stopPropagation()}>
        <header><strong>{running ? 'Command' : 'Run this command?'}</strong><span className="spacer" /><button className="icon" onClick={onClose} data-testid="run-close">✕</button></header>
        <div className="modal-content">
          {running ? <CommandOutput projectId={projectId} record={running} /> : <>
            <p className="muted">Runs with bash in the project directory on the server, as you. Review it — commands written by agents can be wrong or manipulated.</p>
            <textarea className="mono" rows={Math.min(8, text.split('\n').length + 1)} value={text} onChange={e => setText(e.target.value)} data-testid="run-command" />
            {check && !check.allowWithoutConfirm && (
              <label className="danger-box" data-testid="run-danger">
                <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="run-ack" />
                <span><strong>Flagged: {check.category}</strong> — {check.rule}. I understand and want to run it anyway.</span>
              </label>
            )}
            {error && <p className="error-text">{error}</p>}
            <div className="row-end">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!check || !text.trim() || (!check.allowWithoutConfirm && !ack)} onClick={start} data-testid="run-confirm">▷ Run</button>
            </div>
          </>}
        </div>
      </div>
    </div>
  )
}

export function CommandOutput({ projectId, record }: { projectId: string; record: CommandRecord }) {
  const [r, setR] = useState(record)
  const [out, setOut] = useState('')
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const g = await api<{ record: CommandRecord; output: string }>('GET', `/api/projects/${projectId}/commands/${record.id}`)
        if (stop) return
        setR(g.record)
        setOut(g.output)
        if (g.record.status === 'running') setTimeout(tick, 700)
      } catch (gone) {
        void gone
      }
    }
    void tick()
    return () => { stop = true }
  }, [record.id])
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight }, [out])
  return (
    <div className="cmd" data-testid="command-output">
      <div className="cmd-head">
        <code className="mono">$ {r.command}</code>
        <span className={`state ${r.status === 'exited' && r.exitCode === 0 ? 'passed' : r.status === 'running' ? 'running' : 'failed'}`} data-testid="command-status">
          {r.status === 'running' ? 'running' : r.status === 'exited' ? `exit ${r.exitCode}` : r.status}
        </span>
        {r.status === 'running' && <button className="small" onClick={() => api('POST', `/api/projects/${projectId}/commands/${r.id}/stop`, {})} data-testid="command-stop">■ Stop</button>}
      </div>
      <pre ref={pre} className="terminal">{out || (r.status === 'running' ? '…' : '(no output)')}</pre>
    </div>
  )
}
