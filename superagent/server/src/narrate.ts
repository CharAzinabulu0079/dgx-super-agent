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

export type NarrateLang = 'en' | 'zh'
export const narrateLang = (v: string | null | undefined): NarrateLang => (v === 'zh' ? 'zh' : 'en')

const STATE_TEXT: Record<NarrateLang, Record<string, string>> = {
  en: {
    executing: 'is being worked on', verifying: 'is being checked', retrying: 'will be retried', passed: 'is done — all checks passed',
    failed: 'failed', human_gate: 'is waiting for your decision', stopped: 'was stopped',
  },
  zh: {
    executing: '正在进行', verifying: '正在检查', retrying: '将重试', passed: '已完成——所有检查都通过了',
    failed: '失败了', human_gate: '在等你决定', stopped: '已停止',
  },
}

const GATE_REASON_ZH: Record<string, string> = { 'repeated-failure': '多次失败', 'review-disagreement': '审查不通过', 'dangerous-action': '危险操作', integrity: '完整性问题' }

export function narrate(e: SuperAgentEvent, titleOf: (taskId: string) => string | undefined = () => undefined, lang: NarrateLang = 'en'): ActivityLine | undefined {
  const d = e.data as Record<string, any>
  const zh = lang === 'zh'
  const L = (en: string, cn: string): string => (zh ? cn : en)
  const task = e.taskId ? `“${titleOf(e.taskId) ?? e.taskId}”` : L('The task', '该任务')
  const line = (tone: ActivityLine['tone'], text: string): ActivityLine => ({ seq: e.seq, ts: e.ts, taskId: e.taskId, tone, text })
  switch (e.type) {
    case 'request/submitted': {
      const n = Array.isArray(d.tasks) ? d.tasks.length : 0
      return line('info', zh
        ? `已把你的需求规划成 ${n} 个任务${n ? `：${d.tasks.join(' → ')}` : ''}${d.note ? `（${d.note}）` : ''}`
        : `Planned your request into ${n} task${n === 1 ? '' : 's'}${n ? `: ${d.tasks.join(' → ')}` : ''}${d.note ? ` (${d.note})` : ''}`)
    }
    case 'goal/created': return line('info', L(`New goal: ${d.objective}`, `新目标：${d.objective}`))
    case 'goal/updated':
      if (d.error) return line('bad', L(`The run stopped unexpectedly: ${d.error}`, `运行意外停止：${d.error}`))
      if (d.from === d.status) return undefined // bookkeeping (queue flags), not a transition
      if (d.status === 'complete') return line('good', L('Goal complete — every task passed its checks', '目标完成——每个任务都通过了检查'))
      if (d.status === 'blocked') return line('attention', L(`Paused for your decision: ${d.blocker ?? ''}`, `暂停，等你决定：${d.blocker ?? ''}`))
      if (d.status === 'failed') return line('bad', L(`Goal failed: ${d.blocker ?? ''}`, `目标失败：${d.blocker ?? ''}`))
      if (d.status === 'paused') return line('info', L('Goal paused', '目标已暂停'))
      return undefined
    case 'task/created': return line('info', L(`Task added: ${task}`, `新增任务：${task}`))
    case 'task/state': {
      const text = STATE_TEXT[lang][String(d.to)]
      if (!text || d.to === 'verifying') return undefined
      return line(d.to === 'passed' ? 'good' : d.to === 'failed' ? 'bad' : d.to === 'human_gate' ? 'attention' : 'info', `${task}${zh ? '' : ' '}${text}`)
    }
    case 'worker/started': {
      const model = `${d.model?.provider ?? '?'}/${d.model?.model ?? '?'}`
      return line('info', L(`Worker attempt ${d.attempt} started on ${task} (${model})`, `Worker 开始第 ${d.attempt} 次尝试：${task}（${model}）`))
    }
    case 'worker/report': {
      const r = d.report ?? {}
      if (r.kind === 'blocker') return line('attention', L(`${task}: the Worker is blocked — ${r.blocker ?? r.current_state}`, `${task}：Worker 卡住了——${r.blocker ?? r.current_state}`))
      if (r.kind === 'result') {
        const done = r.verification_result === 'claimed_pass'
        return line('info', zh
          ? `${task}：Worker 说${done ? '做完了' : '没能完成'}${r.summary ? `——${r.summary}` : ''}（以检查结果为准）`
          : `${task}: the Worker says ${done ? 'it is done' : 'it could not finish'}${r.summary ? ` — ${r.summary}` : ''} (checks decide)`)
      }
      return undefined
    }
    case 'receipt/created':
      return d.verdict === 'PASS'
        ? line('good', L(`${task}: independent checks passed (attempt ${d.attempt})`, `${task}：独立检查通过（第 ${d.attempt} 次尝试）`))
        : line('bad', L(`${task}: checks failed on attempt ${d.attempt} — ${String(d.reason ?? '').slice(0, 200)}`, `${task}：第 ${d.attempt} 次尝试检查未通过——${String(d.reason ?? '').slice(0, 200)}`))
    case 'review/completed':
      return d.approve
        ? line('good', L(`${task}: the reviewer approved`, `${task}：Reviewer 批准了`))
        : line('attention', L(`${task}: the reviewer asked for changes — ${String(d.comments ?? '').slice(0, 200)}`, `${task}：Reviewer 要求修改——${String(d.comments ?? '').slice(0, 200)}`))
    case 'loop/decision': {
      const dec = d.decision ?? {}
      if (dec.action === 'retry' && dec.switched) return line('info', L(`${task}: trying a different approach (${dec.strategy})`, `${task}：换一种做法（${dec.strategy}）`))
      return undefined
    }
    case 'human-gate/opened': return line('attention', L(`Needs your decision (${d.reason}): ${String(d.detail ?? '').slice(0, 240)}`, `需要你决定（${GATE_REASON_ZH[d.reason] ?? d.reason}）：${String(d.detail ?? '').slice(0, 240)}`))
    case 'human-gate/resolved': return line('info', zh
      ? `你${d.decision === 'approved' ? '批准' : d.decision === 'rejected' ? '拒绝' : `处理（${d.decision}）`}了一项决定${d.resolution ? `：${d.resolution}` : ''}`
      : `You ${d.decision} a decision${d.resolution ? `: ${d.resolution}` : ''}`)
    case 'file/shared': {
      const who = d.from === 'worker' ? L(`${task}: the Worker`, `${task}：Worker `) : d.from === 'chief' ? L('The Chief', 'Chief ') : L('You', '你')
      return line('good', zh ? `${who}分享了文件：${d.name}${d.note ? `——${d.note}` : ''}` : `${who} shared a file: ${d.name}${d.note ? ` — ${d.note}` : ''}`)
    }
    case 'command/updated':
      if (d.status === 'running') return line(d.flagged ? 'attention' : 'info', zh
        ? `你运行了 \`${d.command}\`${d.flagged ? `（已标记：${d.flagged}；你已确认）` : ''}`
        : `You ran \`${d.command}\`${d.flagged ? ` (flagged: ${d.flagged}; you confirmed)` : ''}`)
      return line(d.status === 'exited' && d.exitCode === 0 ? 'good' : 'bad', zh
        ? `\`${d.command}\` ${d.status === 'exited' ? `已结束，退出码 ${d.exitCode}` : d.status}`
        : `\`${d.command}\` ${d.status === 'exited' ? `finished with exit ${d.exitCode}` : d.status}`)
    case 'learning/promoted': return line('good', L(`Learned something reusable: ${d.name ?? ''}`, `学到了可复用的经验：${d.name ?? ''}`))
    default: return undefined
  }
}
