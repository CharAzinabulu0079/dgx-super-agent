/**
 * Plain-language activity feed: turns loop events into one-line sentences a non-expert
 * can follow ("Worker attempt 2 started", "Checks passed", "Needs your decision").
 * Routine noise (every progress report, architecture refreshes) is skipped.
 */
import type { SuperAgentEvent } from '@superagent/contracts'

export interface ActivityLine {
  readonly seq: number
  readonly ts: string
  readonly taskId?: string
  readonly tone: 'info' | 'good' | 'bad' | 'attention'
  readonly text: string
}

const STATE_TEXT: Record<string, string> = {
  executing: 'is being worked on', verifying: 'is being checked', retrying: 'will be retried', passed: 'is done — all checks passed',
  failed: 'failed', human_gate: 'is waiting for your decision', stopped: 'was stopped',
}

export function narrate(e: SuperAgentEvent, titleOf: (taskId: string) => string | undefined = () => undefined): ActivityLine | undefined {
  const d = e.data as Record<string, any>
  const task = e.taskId ? `“${titleOf(e.taskId) ?? e.taskId}”` : 'The task'
  const line = (tone: ActivityLine['tone'], text: string): ActivityLine => ({ seq: e.seq, ts: e.ts, taskId: e.taskId, tone, text })
  switch (e.type) {
    case 'request/submitted': {
      const n = Array.isArray(d.tasks) ? d.tasks.length : 0
      return line('info', `Planned your request into ${n} task${n === 1 ? '' : 's'}${n ? `: ${d.tasks.join(' → ')}` : ''}${d.note ? ` (${d.note})` : ''}`)
    }
    case 'goal/created': return line('info', `New goal: ${d.objective}`)
    case 'goal/updated':
      if (d.error) return line('bad', `The run stopped unexpectedly: ${d.error}`)
      if (d.from === d.status) return undefined // bookkeeping (queue flags), not a transition
      if (d.status === 'complete') return line('good', 'Goal complete — every task passed its checks')
      if (d.status === 'blocked') return line('attention', `Paused for your decision: ${d.blocker ?? ''}`)
      if (d.status === 'failed') return line('bad', `Goal failed: ${d.blocker ?? ''}`)
      if (d.status === 'paused') return line('info', 'Goal paused')
      return undefined
    case 'task/created': return line('info', `Task added: ${task}`)
    case 'task/state': {
      const text = STATE_TEXT[String(d.to)]
      if (!text || d.to === 'verifying') return undefined
      return line(d.to === 'passed' ? 'good' : d.to === 'failed' ? 'bad' : d.to === 'human_gate' ? 'attention' : 'info', `${task} ${text}`)
    }
    case 'worker/started': return line('info', `Worker attempt ${d.attempt} started on ${task} (${d.model?.provider ?? '?'}/${d.model?.model ?? '?'})`)
    case 'worker/report': {
      const r = d.report ?? {}
      if (r.kind === 'blocker') return line('attention', `${task}: the Worker is blocked — ${r.blocker ?? r.current_state}`)
      if (r.kind === 'result') return line('info', `${task}: the Worker says ${r.verification_result === 'claimed_pass' ? 'it is done' : 'it could not finish'}${r.summary ? ` — ${r.summary}` : ''} (checks decide)`)
      return undefined
    }
    case 'receipt/created':
      return d.verdict === 'PASS'
        ? line('good', `${task}: independent checks passed (attempt ${d.attempt})`)
        : line('bad', `${task}: checks failed on attempt ${d.attempt} — ${String(d.reason ?? '').slice(0, 200)}`)
    case 'review/completed':
      return d.approve ? line('good', `${task}: the reviewer approved`) : line('attention', `${task}: the reviewer asked for changes — ${String(d.comments ?? '').slice(0, 200)}`)
    case 'loop/decision': {
      const dec = d.decision ?? {}
      if (dec.action === 'retry' && dec.switched) return line('info', `${task}: trying a different approach (${dec.strategy})`)
      return undefined
    }
    case 'human-gate/opened': return line('attention', `Needs your decision (${d.reason}): ${String(d.detail ?? '').slice(0, 240)}`)
    case 'human-gate/resolved': return line('info', `You ${d.decision} a decision${d.resolution ? `: ${d.resolution}` : ''}`)
    case 'file/shared': return line('good', `${d.from === 'worker' ? `${task}: the Worker` : d.from === 'chief' ? 'The Chief' : 'You'} shared a file: ${d.name}${d.note ? ` — ${d.note}` : ''}`)
    case 'learning/promoted': return line('good', `Learned something reusable: ${d.name ?? ''}`)
    default: return undefined
  }
}
