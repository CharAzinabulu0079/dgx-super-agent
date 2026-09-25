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
import { now, type ModelRef, type SuperAgentEvent } from '@superagent/contracts'
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
    const events = this.store.readEvents(projectId, cursor, Number.MAX_SAFE_INTEGER)
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

/** Delivers digests into a persistent per-project Chief DSH session (`--session-id` resume). */
export class DshChiefChannel implements ChiefChannel {
  readonly name = 'dsh-chief'
  private readonly o: DshChiefChannelOptions
  constructor(options: DshChiefChannelOptions) {
    this.o = options
  }

  async deliver(digest: ChiefDigest, signal: AbortSignal): Promise<{ sessionId?: string; reply?: string }> {
    const project = this.o.store.requireProject(digest.projectId)
    const prior = this.o.store.getMeta<{ sessionId?: string }>(digest.projectId, 'chief-session')?.sessionId
    const args = ['--profile', this.o.profile ?? 'superagent-chief-cli']
    const model = this.o.model?.(digest.projectId)
    const patch = model ? modelPatch(model, loadModelRoutes(this.o.stateHome)) : undefined
    if (patch) {
      const dir = join(this.o.stateHome, 'runtime', 'chief')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${digest.projectId}.model.yml`), patch)
      args.push('--patch', join(dir, `${digest.projectId}.model.yml`))
    }
    args.push('--json', ...(prior ? ['--session-id', prior] : []), digest.text)
    let sessionId: string | undefined
    let reply = ''
    const r = await runDshStreaming({
      args, cwd: project.root, signal, timeoutMs: this.o.timeoutMs ?? 10 * 60_000, keepCredentials: true,
      env: {
        DSH_HOME: join(this.o.stateHome, 'dsh-home'), SUPERAGENT_ROLE: 'chief', SUPERAGENT_API_URL: this.o.apiUrl,
        SUPERAGENT_AGENT_TOKEN: this.o.agentToken, SUPERAGENT_HOME: this.o.stateHome, ...this.o.env,
      },
      onEvent: e => {
        if (e.type === 'session' && typeof e.sessionId === 'string') sessionId = e.sessionId
        if (e.type === 'final' && typeof e.text === 'string') reply = e.text
      },
    })
    if (r.exitCode !== 0) throw new Error(`Chief session exited ${r.exitCode}: ${r.stderrTail.slice(-300)}`)
    if (sessionId) this.o.store.setMeta(digest.projectId, 'chief-session', { sessionId, updatedAt: now() })
    return { sessionId, reply }
  }
}

export type { SuperAgentEvent }
