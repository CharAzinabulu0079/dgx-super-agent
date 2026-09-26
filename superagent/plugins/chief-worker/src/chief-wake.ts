/**
 * Chief auto-wake (Directive §4.C): event → durable wake → coalesced delivery to a
 * persistent Chief DSH session.
 *
 *   events.jsonl ──(WakeMonitor: cursor + classifyEvent)──► wakes/<id>.json (pending)
 *   pending wakes ──(ChiefDriver: coalesce, rate-limit, retry)──► ChiefChannel.deliver()
 *
 * Both sides persist their state in the store, so a restart neither loses pending
 * wakes nor re-enqueues processed events (wake ids are derived from the event seq).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { now, type ChiefMessage, type ModelRef, type SuperAgentEvent } from '@superagent/contracts'
import { loadModelRoutes, modelPatch } from './dsh-executor.ts'
import type { StateStore } from '@superagent/project-state'
import { classifyEvent, DEFAULT_WAKE_POLICY, type WakePolicyOptions, type WakePriority, type WakeReason } from '@superagent/loop-policy'
import { runDshStreaming } from './dsh-process.ts'

export type WakeStatus = 'pending' | 'delivered' | 'failed'

export interface ChiefWakeRecord {
  readonly id: string
  readonly projectId: string
  readonly reason: WakeReason
  readonly priority: WakePriority
  readonly summary: string
  readonly eventSeq: number
  readonly eventType: string
  readonly taskId?: string
  readonly goalId?: string
  readonly status: WakeStatus
  readonly createdAt: string
  readonly deliveries: number
  readonly lastError?: string
  readonly deliveredAt?: string
  readonly nextAttemptAt?: string
}

export interface ChiefDigest {
  readonly projectId: string
  readonly wakes: readonly ChiefWakeRecord[]
  readonly text: string
}

/** Where a digest goes. The production channel is a DSH Chief session. */
export interface ChiefChannel {
  readonly name: string
  deliver(digest: ChiefDigest, signal: AbortSignal): Promise<{ sessionId?: string; reply?: string }>
  /** Human chat into the same Chief session (optional; the UI's Chief panel). */
  chat?(projectId: string, text: string, signal: AbortSignal, context?: string): Promise<{ sessionId?: string; reply?: string }>
  busy?(projectId: string): boolean
}

const CURSOR = 'wake-cursor'

/** Tails a project's event log and turns wake-worthy events into durable wake records. */
export class WakeMonitor {
  private readonly store: StateStore
  private readonly policy: WakePolicyOptions
  constructor(store: StateStore, policy: WakePolicyOptions = DEFAULT_WAKE_POLICY) {
    this.store = store
    this.policy = policy
  }

  /**
   * Process events after the persisted cursor.
   * @returns the wake records created in this pass.
   */
  scan(projectId: string): ChiefWakeRecord[] {
    const cursor = this.store.getMeta<{ seq: number }>(projectId, CURSOR)?.seq ?? 0
    const events = this.store.tailEvents(projectId, cursor, Number.MAX_SAFE_INTEGER)
    const created: ChiefWakeRecord[] = []
    let last = cursor
    for (const e of events) {
      last = e.seq
      if (e.type === 'chief/wake') continue // the engine's own notifications are not re-classified
      const d = classifyEvent(e, this.policy)
      if (!d) continue
      const id = `wake-${e.seq}`
      if (this.store.getRecord(projectId, 'wakes', id)) continue // idempotent across restarts
      const record: ChiefWakeRecord = {
        id, projectId, reason: d.reason, priority: d.priority, summary: d.summary, eventSeq: e.seq, eventType: e.type,
        taskId: e.taskId, goalId: e.goalId, status: 'pending', createdAt: now(), deliveries: 0,
      }
      this.store.putRecord('wakes', record)
      created.push(record)
    }
    if (last !== cursor) this.store.setMeta(projectId, CURSOR, { seq: last })
    return created
  }

  pending(projectId: string): ChiefWakeRecord[] {
    return this.store.listRecords<ChiefWakeRecord>(projectId, 'wakes').filter(w => w.status === 'pending')
  }
}

export interface ChiefDriverOptions {
  readonly store: StateStore
  readonly channel: ChiefChannel
  readonly monitor?: WakeMonitor
  /** Minimum time between deliveries per project (coalescing window). */
  readonly minIntervalMs?: number
  /** Low-priority-only batches wait this long before delivery. */
  readonly lowPriorityDelayMs?: number
  readonly maxDeliveries?: number
  readonly backoffMs?: number
  /** Builds the status part of the digest (e.g. Chief.statusReport). */
  readonly statusReport?: (projectId: string) => string
}

/** Coalesces pending wakes into one Chief turn per project, with rate limiting and retry. */
export class ChiefDriver {
  private readonly o: Required<Omit<ChiefDriverOptions, 'statusReport'>> & Pick<ChiefDriverOptions, 'statusReport'>
  private timer?: NodeJS.Timeout
  private busy = new Set<string>()
  private readonly abort = new AbortController()

  constructor(options: ChiefDriverOptions) {
    this.o = {
      monitor: new WakeMonitor(options.store), minIntervalMs: 60_000, lowPriorityDelayMs: 10 * 60_000, maxDeliveries: 3, backoffMs: 30_000,
      ...options,
    }
  }

  /** One pass over every project: scan events, deliver due digests. */
  async tick(nowMs = Date.now()): Promise<ChiefDigest[]> {
    const delivered: ChiefDigest[] = []
    for (const p of this.o.store.listProjects()) {
      this.o.monitor.scan(p.id)
      const d = await this.deliverProject(p.id, nowMs)
      if (d) delivered.push(d)
    }
    return delivered
  }

  private async deliverProject(projectId: string, nowMs: number): Promise<ChiefDigest | undefined> {
    if (this.busy.has(projectId)) return undefined
    const due = this.o.monitor.pending(projectId).filter(w => !w.nextAttemptAt || Date.parse(w.nextAttemptAt) <= nowMs)
    if (!due.length) return undefined
    const lastAt = this.o.store.getMeta<{ at: string }>(projectId, 'chief-last-delivery')?.at
    if (lastAt && nowMs - Date.parse(lastAt) < this.o.minIntervalMs) return undefined
    const urgent = due.some(w => w.priority !== 'low')
    if (!urgent && nowMs - Math.min(...due.map(w => Date.parse(w.createdAt))) < this.o.lowPriorityDelayMs) return undefined

    const digest = buildDigest(projectId, due, this.o.statusReport?.(projectId))
    this.busy.add(projectId)
    try {
      const result = await this.o.channel.deliver(digest, this.abort.signal)
      const at = now()
      for (const w of due) this.o.store.putRecord('wakes', { ...w, status: 'delivered', deliveredAt: at, deliveries: w.deliveries + 1 })
      this.o.store.setMeta(projectId, 'chief-last-delivery', { at, wakes: due.length, sessionId: result.sessionId })
      this.o.store.emitTyped('chief/wake', projectId, { reason: 'delivered', delivered: due.map(w => w.id), channel: this.o.channel.name, sessionId: result.sessionId ?? null })
      return digest
    } catch (error) {
      for (const w of due) {
        const deliveries = w.deliveries + 1
        this.o.store.putRecord('wakes', {
          ...w, deliveries, lastError: String((error as Error).message ?? error),
          status: deliveries >= this.o.maxDeliveries ? 'failed' : 'pending',
          nextAttemptAt: new Date(nowMs + this.o.backoffMs * 2 ** (deliveries - 1)).toISOString(),
        })
      }
      this.o.store.emitTyped('chief/wake', projectId, { reason: 'delivery-failed', error: String(error) })
      return undefined
    } finally {
      this.busy.delete(projectId)
    }
  }

  start(intervalMs = 2_000): void {
    const loop = (): void => {
      this.timer = setTimeout(() => { void this.tick().catch(() => {}).finally(loop) }, intervalMs)
    }
    loop()
  }

  stop(): void {
    clearTimeout(this.timer)
    this.abort.abort()
  }
}

export function buildDigest(projectId: string, wakes: readonly ChiefWakeRecord[], status?: string): ChiefDigest {
  const order: Record<WakePriority, number> = { high: 0, normal: 1, low: 2 }
  const sorted = [...wakes].sort((a, b) => order[a.priority] - order[b.priority] || a.eventSeq - b.eventSeq)
  const text = [
    `SuperAgent Chief wake — project ${projectId}. ${wakes.length} event(s) need your attention (routine progress is omitted).`,
    ...sorted.map(w => `- [${w.priority}] ${w.reason}${w.taskId ? ` (task ${w.taskId})` : ''}: ${w.summary}`),
    '',
    status ? `Current state:\n${status}` : '',
    '',
    'Decide the next step with your superagent_* tools (status, architecture, add tasks by registry gate id, run goals).',
    'You cannot resolve Human Gates; summarize what the human must decide and why.',
  ].filter(l => l !== undefined).join('\n')
  return { projectId, wakes: sorted, text }
}

export interface DshChiefChannelOptions {
  readonly stateHome: string
  readonly apiUrl: string
  readonly agentToken: string
  /** Default `superagent-chief-cli` when set up, else `headless`. */
  readonly profile?: string
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  readonly store: StateStore
  /** Chief model per project (policy role `chief`); mapped to DSH via model-routes. */
  readonly model?: (projectId: string) => ModelRef | undefined
}

let messageSeq = 0

/** Append one entry to the project's Chief conversation (UI chat view) and announce it. */
export function appendChiefMessage(store: StateStore, projectId: string, role: ChiefMessage['role'], text: string, tool?: string): ChiefMessage {
  const msg: ChiefMessage = { id: `m-${Date.now()}-${String(messageSeq++ % 1e6).padStart(6, '0')}`, projectId, role, text: text.slice(0, 20_000), tool, at: now() }
  store.putRecord('chief-chat', msg)
  store.emitTyped('chief/message', projectId, { messageId: msg.id, role, text: text.slice(0, 300), tool: tool ?? null })
  return msg
}

function toolLine(tool: string, input: Record<string, unknown>): string {
  const pick = input.path ?? input.file_path ?? input.command ?? input.project ?? input.objective ?? input.title ?? ''
  return `${tool}${pick ? ` ${String(pick).slice(0, 160)}` : ''}`
}

/**
 * The persistent per-project Chief DSH session (`--session-id` resume). Autonomous wake
 * digests and human chat messages are serialized per project (one DSH process per
 * session at a time) and both land in one transcript the UI shows as a conversation.
 */
export class DshChiefChannel implements ChiefChannel {
  readonly name = 'dsh-chief'
  private readonly o: DshChiefChannelOptions
  private readonly locks = new Map<string, Promise<unknown>>()
  constructor(options: DshChiefChannelOptions) {
    this.o = options
  }

  async deliver(digest: ChiefDigest, signal: AbortSignal): Promise<{ sessionId?: string; reply?: string }> {
    appendChiefMessage(this.o.store, digest.projectId, 'wake', digest.text)
    return this.turn(digest.projectId, digest.text, signal)
  }

  async chat(projectId: string, text: string, signal: AbortSignal, context?: string): Promise<{ sessionId?: string; reply?: string }> {
    appendChiefMessage(this.o.store, projectId, 'human', text)
    const prompt = [`[Message from the human in the SuperAgent UI — project ${projectId}]`, text, context ? `\n(Current state, for reference)\n${context.slice(0, 4_000)}` : ''].join('\n')
    try {
      return await this.turn(projectId, prompt, signal)
    } catch (error) {
      appendChiefMessage(this.o.store, projectId, 'error', String((error as Error).message ?? error))
      throw error
    }
  }

  /** Whether a turn is running (or queued) for the project. */
  busy(projectId: string): boolean {
    return this.locks.has(projectId)
  }

  private turn(projectId: string, text: string, signal: AbortSignal): Promise<{ sessionId?: string; reply?: string }> {
    const previous = this.locks.get(projectId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => this.runTurn(projectId, text, signal))
    const tracked = run.finally(() => { if (this.locks.get(projectId) === tracked) this.locks.delete(projectId) })
    this.locks.set(projectId, tracked)
    return run
  }

  private async runTurn(projectId: string, text: string, signal: AbortSignal): Promise<{ sessionId?: string; reply?: string }> {
    const store = this.o.store
    const project = store.requireProject(projectId)
    const prior = store.getMeta<{ sessionId?: string }>(projectId, 'chief-session')?.sessionId
    const args = ['--profile', this.o.profile ?? 'superagent-chief-cli']
    const model = this.o.model?.(projectId)
    const patch = model ? modelPatch(model, loadModelRoutes(this.o.stateHome)) : undefined
    if (patch) {
      const dir = join(this.o.stateHome, 'runtime', 'chief')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${projectId}.model.yml`), patch)
      args.push('--patch', join(dir, `${projectId}.model.yml`))
    }
    args.push('--json', ...(prior ? ['--session-id', prior] : []), text)
    let sessionId: string | undefined
    let reply = ''
    let lastText = ''
    const r = await runDshStreaming({
      args, cwd: project.root, signal, timeoutMs: this.o.timeoutMs ?? 10 * 60_000, keepCredentials: true,
      env: {
        DSH_HOME: join(this.o.stateHome, 'dsh-home'), SUPERAGENT_ROLE: 'chief', SUPERAGENT_API_URL: this.o.apiUrl,
        SUPERAGENT_AGENT_TOKEN: this.o.agentToken, SUPERAGENT_HOME: this.o.stateHome, ...this.o.env,
      },
      onEvent: e => {
        if (e.type === 'session' && typeof e.sessionId === 'string') sessionId = e.sessionId
        else if (e.type === 'tool_call' && typeof e.tool === 'string') appendChiefMessage(store, projectId, 'tool', toolLine(e.tool, (e.input ?? {}) as Record<string, unknown>), e.tool)
        else if (e.type === 'text' && typeof e.text === 'string' && e.text.trim()) {
          lastText = e.text
          appendChiefMessage(store, projectId, 'chief', e.text)
        } else if (e.type === 'final' && typeof e.text === 'string') {
          reply = e.text || lastText
          if (e.text.trim() && e.text.trim() !== lastText.trim()) appendChiefMessage(store, projectId, 'chief', e.text)
        }
      },
    })
    if (r.exitCode !== 0) throw new Error(`Chief session exited ${r.exitCode}${r.timedOut ? ' (timeout)' : ''}: ${r.stderrTail.slice(-300)}`)
    if (sessionId) store.setMeta(projectId, 'chief-session', { sessionId, updatedAt: now() })
    return { sessionId, reply }
  }
}

export type { SuperAgentEvent }
