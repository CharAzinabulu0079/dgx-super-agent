/**
 * Worker transcript: what one Worker attempt actually did, reconstructed from the DSH
 * `--json` event log the executor keeps under `$SUPERAGENT_HOME/runtime/workers/<id>/`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TranscriptStep {
  readonly type: 'text' | 'tool_call' | 'tool_result' | 'final' | 'status'
  readonly callId?: string
  readonly tool?: string
  readonly input?: unknown
  readonly status?: string
  readonly result?: string
  readonly text?: string
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s)

export function workerTranscript(home: string, workerId: string, maxSteps = 2_000): { prompt: string | null; steps: TranscriptStep[]; truncated: boolean; stderr: string | null } {
  if (!/^[\w.-]+$/.test(workerId)) throw new Error(`invalid worker id ${workerId}`)
  const dir = join(home, 'runtime', 'workers', workerId)
  const read = (f: string): string | null => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null)
  const steps: TranscriptStep[] = []
  for (const line of (read('events.jsonl') ?? '').split('\n')) {
    if (!line.trim()) continue
    let e: Record<string, unknown>
    try {
      e = JSON.parse(line) as Record<string, unknown>
    } catch (partial) {
      void partial
      continue
    }
    if (e.type === 'tool_call') steps.push({ type: 'tool_call', callId: String(e.callId ?? ''), tool: String(e.tool ?? ''), input: e.input })
    else if (e.type === 'tool_result') steps.push({ type: 'tool_result', callId: String(e.callId ?? ''), status: String(e.status ?? ''), result: clip(typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? ''), 6_000) })
    else if (e.type === 'text' && typeof e.text === 'string' && e.text.trim()) steps.push({ type: 'text', text: clip(e.text, 20_000) })
    else if (e.type === 'final' && typeof e.text === 'string' && e.text.trim()) steps.push({ type: 'final', text: clip(e.text, 20_000) })
  }
  return { prompt: read('prompt.md'), steps: steps.slice(-maxSteps), truncated: steps.length > maxSteps, stderr: read('stderr.log') }
}
