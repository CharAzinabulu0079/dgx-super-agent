/** What one Worker attempt actually did: its prompt and DSH tool calls, results and text. */
import { useEffect, useState } from 'react'
import { api, fmtModel, type TranscriptStep, type Worker } from './api.ts'

export function TranscriptDrawer({ projectId, workerId, onClose, onError }: { projectId: string; workerId: string; onClose: () => void; onError: (e: string) => void }) {
  const [t, setT] = useState<{ worker: Worker; prompt: string | null; steps: TranscriptStep[]; truncated: boolean; stderr: string | null } | null>(null)
  useEffect(() => { api<typeof t>('GET', `/api/projects/${projectId}/workers/${workerId}/transcript`).then(setT, e => onError(String(e))) }, [projectId, workerId])
  const results = new Map((t?.steps ?? []).filter(s => s.type === 'tool_result').map(s => [s.callId, s]))
  return (
    <div className="modal" role="dialog" data-testid="transcript" onClick={onClose}>
      <div className="modal-body wide" onClick={e => e.stopPropagation()}>
        <header>
          <strong>Worker {workerId}</strong>
          {t && <span className="muted">attempt {t.worker.attempt} · {fmtModel(t.worker.model)} · {t.worker.status}</span>}
          <span className="spacer" />
          <button onClick={onClose} data-testid="close-transcript">✕</button>
        </header>
        <div className="modal-content transcript">
          {!t ? <p className="muted">Loading…</p> : <>
            {t.prompt && <details><summary>Prompt the Worker received</summary><pre>{t.prompt}</pre></details>}
            {t.steps.length === 0 && <p className="muted">No DSH events recorded for this Worker (scripted or not started).</p>}
            {t.truncated && <p className="muted">Showing the last 2000 steps.</p>}
            <ol className="steps">
              {t.steps.filter(s => s.type !== 'tool_result').map((s, i) => s.type === 'tool_call' ? (
                <li key={i} className="step tool" data-testid="step-tool">
                  <div>⚙ <strong>{s.tool}</strong> <code>{summarize(s.input)}</code> {results.get(s.callId)?.status && <span className="muted">· {results.get(s.callId)!.status}</span>}</div>
                  <details><summary>input / result</summary><pre>{JSON.stringify(s.input, null, 2)}</pre>{results.get(s.callId)?.result && <pre className="result">{results.get(s.callId)!.result}</pre>}</details>
                </li>
              ) : (
                <li key={i} className="step text" data-testid="step-text"><pre>{s.text}</pre></li>
              ))}
            </ol>
            {t.stderr && <details><summary>stderr</summary><pre>{t.stderr}</pre></details>}
          </>}
        </div>
      </div>
    </div>
  )
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? Object.values(o)[0]
  return String(v ?? '').slice(0, 120)
}
