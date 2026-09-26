/**
 * File-backed SuperAgent state store (Freeze §0.1-7: state is externalized).
 *
 * Layout under `home` (default `$SUPERAGENT_HOME` or `~/.superagent`):
 *
 *   projects/<pid>/project.json
 *   projects/<pid>/{goals,tasks,workers,receipts,human-gates}/<id>.json
 *   projects/<pid>/events.jsonl           append-only; seq = 1-based line number
 *   projects/<pid>/reports/<wid>.jsonl    raw Worker reports (append-only)
 *
 * Records are replaced with write-temp-then-rename, so a crash leaves either the
 * old or the new version. Appends use O_APPEND single writes, so a Worker process
 * (DSH bundle tool) and the engine process can append to the same files.
 */
import { EventEmitter } from 'node:events'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
  openSync, readSync, closeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  now, newId,
  type BlockedAction, type Goal, type GoalId, type HumanGate, type HumanGateId, type Project, type ProjectId, type Receipt, type ReceiptId,
  type SuperAgentEvent, type SuperAgentEventType, type Task, type TaskId, type Worker, type WorkerId, type WorkerReport,
} from '@superagent/contracts'

/** A durable record exists but cannot be parsed: never treat it as absent (fail closed). */
export class StateCorruptError extends Error {
  readonly path: string
  constructor(path: string, cause: unknown) {
    super(`corrupted state record ${path}: ${String((cause as Error).message ?? cause)} — refusing to continue; restore or remove it deliberately`)
    this.path = path
    this.name = 'StateCorruptError'
  }
}

/** Held while a process runs a task's loop; prevents duplicate execution across processes. */
export interface TaskLease {
  readonly pid: number
  readonly acquiredAt: string
  readonly owner: string
}

export function defaultHome(): string {
  return resolve(process.env.SUPERAGENT_HOME ?? join(homedir(), '.superagent'))
}

type Collection = 'goals' | 'tasks' | 'workers' | 'receipts' | 'human-gates' | RecordCollection
/** Generic per-project record collections (putRecord/getRecord/listRecords). */
export type RecordCollection = 'wakes' | 'files' | 'chief-chat' | 'commands'

export type NewEvent = Omit<SuperAgentEvent, 'seq' | 'ts'> & { ts?: string }

/**
 * Version of the on-disk state layout. Bump it (with a migration) whenever a stored record
 * changes shape incompatibly; backups and updates refuse to move state to an older version.
 */
export const STATE_SCHEMA_VERSION = 1

export class StateStore {
  readonly home: string
  private readonly emitter = new EventEmitter()
  /** Per-project [byteOffset, lineCount] of events.jsonl already counted. */
  private readonly eventCursor = new Map<ProjectId, [number, number]>()

  constructor(home: string = defaultHome()) {
    this.home = resolve(home)
    mkdirSync(join(this.home, 'projects'), { recursive: true })
    this.emitter.setMaxListeners(0)
    // Record the on-disk format so backups/updates can tell which state layout they hold.
    const version = join(this.home, 'state-version.json')
    if (!existsSync(version)) writeFileSync(version, `${JSON.stringify({ schema: STATE_SCHEMA_VERSION })}\n`)
  }

  /** On-disk state format of this home (1 when unrecorded). */
  stateSchema(): number {
    try {
      return (JSON.parse(readFileSync(join(this.home, 'state-version.json'), 'utf8')) as { schema?: number }).schema ?? 1
    } catch (absent) {
      void absent
      return 1
    }
  }

  // ------------------------------------------------------------ primitives

  private projectDir(pid: ProjectId): string {
    if (!/^[\w.-]+$/.test(pid)) throw new Error(`invalid project id ${JSON.stringify(pid)}`)
    return join(this.home, 'projects', pid)
  }

  private recordPath(pid: ProjectId, collection: Collection, id: string): string {
    if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid ${collection} id ${JSON.stringify(id)}`)
    return join(this.projectDir(pid), collection, `${id}.json`)
  }

  private writeJson(path: string, value: unknown): void {
    mkdirSync(resolve(path, '..'), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(tmp, path)
  }

  private readJson<T>(path: string): T | undefined {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf8')
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new StateCorruptError(path, error)
    }
  }

  private list<T>(pid: ProjectId, collection: Collection): T[] {
    const dir = join(this.projectDir(pid), collection)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => this.readJson<T>(join(dir, f))!)
  }

  private put<T extends { id: string; projectId: ProjectId }>(collection: Collection, record: T): T {
    this.writeJson(this.recordPath(record.projectId, collection, record.id), record)
    return record
  }

  private patch<T extends { id: string; projectId: ProjectId }>(collection: Collection, pid: ProjectId, id: string, change: Partial<T>): T {
    const current = this.readJson<T>(this.recordPath(pid, collection, id))
    if (!current) throw new Error(`${collection}/${id} not found in project ${pid}`)
    const next = { ...current, ...change, id: current.id, projectId: current.projectId, updatedAt: now() } as T
    return this.put(collection, next)
  }

  // ------------------------------------------------------------ projects

  createProject(input: { name: string; root: string; id?: ProjectId; defaultGates?: Project['defaultGates']; protectedModules?: string[] }): Project {
    const root = resolve(input.root)
    const existing = this.findProjectByRoot(root)
    if (existing) return existing
    const id = input.id ?? slug(input.name)
    if (existsSync(join(this.projectDir(id), 'project.json'))) throw new Error(`project id ${id} already exists`)
    const project: Project = {
      id, name: input.name, root, createdAt: now(),
      defaultGates: input.defaultGates ?? [], protectedModules: input.protectedModules ?? [],
    }
    this.writeJson(join(this.projectDir(id), 'project.json'), project)
    this.appendEvent({ type: 'project/created', projectId: id, data: { name: project.name, root } })
    return project
  }

  updateProject(pid: ProjectId, change: Partial<Omit<Project, 'id' | 'createdAt'>>): Project {
    const current = this.requireProject(pid)
    const next: Project = { ...current, ...change, id: current.id, createdAt: current.createdAt }
    this.writeJson(join(this.projectDir(pid), 'project.json'), next)
    return next
  }

  getProject(pid: ProjectId): Project | undefined {
    return this.readJson<Project>(join(this.projectDir(pid), 'project.json'))
  }

  requireProject(pid: ProjectId): Project {
    const p = this.getProject(pid)
    if (!p) throw new Error(`project ${pid} not found`)
    return p
  }

  listProjects(): Project[] {
    const dir = join(this.home, 'projects')
    return readdirSync(dir)
      .map(id => this.readJson<Project>(join(dir, id, 'project.json')))
      .filter((p): p is Project => p !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  findProjectByRoot(root: string): Project | undefined {
    const abs = resolve(root)
    return this.listProjects().find(p => p.root === abs)
  }

  // ------------------------------------------------------------ goals

  createGoal(pid: ProjectId, objective: string): Goal {
    this.requireProject(pid)
    const t = now()
    const goal: Goal = { id: newId('goal'), projectId: pid, objective, status: 'active', taskIds: [], createdAt: t, updatedAt: t }
    this.put('goals', goal)
    this.appendEvent({ type: 'goal/created', projectId: pid, goalId: goal.id, data: { objective } })
    return goal
  }

  getGoal(pid: ProjectId, id: GoalId): Goal | undefined { return this.readJson(this.recordPath(pid, 'goals', id)) }
  listGoals(pid: ProjectId): Goal[] { return this.list(pid, 'goals') }

  updateGoal(pid: ProjectId, id: GoalId, change: Partial<Goal>): Goal {
    const from = this.getGoal(pid, id)?.status
    const goal = this.patch<Goal>('goals', pid, id, change)
    this.appendEvent({ type: 'goal/updated', projectId: pid, goalId: id, data: { from: from ?? null, status: goal.status, blocker: goal.blocker ?? null, runRequested: goal.runRequested ?? false } })
    return goal
  }

  /** The most recent non-terminal goal, else the most recent goal. */
  currentGoal(pid: ProjectId): Goal | undefined {
    const goals = this.listGoals(pid).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return goals.find(g => g.status === 'active' || g.status === 'blocked' || g.status === 'paused') ?? goals[0]
  }

  // ------------------------------------------------------------ tasks

  createTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'attempts'>): Task {
    const t = now()
    const record: Task = { ...task, id: newId('task'), state: 'pending', attempts: [], createdAt: t, updatedAt: t }
    this.put('tasks', record)
    const goal = this.getGoal(task.projectId, task.goalId)
    if (goal) this.patch<Goal>('goals', task.projectId, goal.id, { taskIds: [...goal.taskIds, record.id] })
    this.appendEvent({ type: 'task/created', projectId: task.projectId, goalId: task.goalId, taskId: record.id, data: { title: task.title, model: task.policy.model.worker } })
    return record
  }

  getTask(pid: ProjectId, id: TaskId): Task | undefined { return this.readJson(this.recordPath(pid, 'tasks', id)) }
  requireTask(pid: ProjectId, id: TaskId): Task {
    const t = this.getTask(pid, id)
    if (!t) throw new Error(`task ${id} not found in project ${pid}`)
    return t
  }
  listTasks(pid: ProjectId, goalId?: GoalId): Task[] {
    const tasks = this.list<Task>(pid, 'tasks')
    return goalId ? tasks.filter(t => t.goalId === goalId) : tasks
  }

  updateTask(pid: ProjectId, id: TaskId, change: Partial<Task>): Task {
    const before = this.requireTask(pid, id)
    const task = this.patch<Task>('tasks', pid, id, change)
    if (change.state !== undefined && change.state !== before.state) {
      this.appendEvent({ type: 'task/state', projectId: pid, goalId: task.goalId, taskId: id, data: { from: before.state, to: task.state } })
    }
    return task
  }

  // ------------------------------------------------------------ workers

  createWorker(worker: Omit<Worker, 'id' | 'startedAt' | 'status' | 'activeModules'>): Worker {
    const record: Worker = { ...worker, id: newId('wkr'), status: 'starting', startedAt: now(), activeModules: [] }
    this.put('workers', record)
    this.appendEvent({ type: 'worker/started', projectId: worker.projectId, taskId: worker.taskId, workerId: record.id, data: { attempt: worker.attempt, executor: worker.executor, model: worker.model } })
    return record
  }

  getWorker(pid: ProjectId, id: WorkerId): Worker | undefined {
    const w = this.readJson<Worker>(this.recordPath(pid, 'workers', id))
    if (!w) return undefined
    const reports = this.readReports(pid, id)
    const last = reports.at(-1)
    return last ? { ...w, lastReport: last, activeModules: last.changed_modules.length ? last.changed_modules : w.activeModules } : w
  }

  listWorkers(pid: ProjectId): Worker[] {
    return this.list<Worker>(pid, 'workers').map(w => this.getWorker(pid, w.id) ?? w)
  }

  updateWorker(pid: ProjectId, id: WorkerId, change: Partial<Worker>): Worker {
    const current = this.readJson<Worker>(this.recordPath(pid, 'workers', id))
    if (!current) throw new Error(`worker ${id} not found`)
    const next: Worker = { ...current, ...change, id, projectId: pid }
    this.put('workers', next)
    if (change.status === 'exited' || change.status === 'killed') {
      this.appendEvent({ type: 'worker/exited', projectId: pid, taskId: next.taskId, workerId: id, data: { status: change.status } })
    }
    return next
  }

  /**
   * Append a Worker report. Safe to call from the Worker's own process.
   * @returns the stored report (timestamped).
   */
  appendReport(pid: ProjectId, workerId: WorkerId, report: WorkerReport): WorkerReport {
    const stored: WorkerReport = { ...report, at: report.at ?? now() }
    const dir = join(this.projectDir(pid), 'reports')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${workerId}.jsonl`), `${JSON.stringify(stored)}\n`)
    this.appendEvent({ type: 'worker/report', projectId: pid, taskId: report.task_id, workerId, data: { report: stored } })
    return stored
  }

  /**
   * Record a tool call the pre-tool guard blocked. Written by the guard inside the
   * Worker's DSH process; kept outside the worktree (Worker sandbox cannot write it).
   */
  appendBlockedAction(pid: ProjectId, workerId: WorkerId, action: BlockedAction): void {
    const dir = join(this.projectDir(pid), 'blocked')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${workerId}.jsonl`), `${JSON.stringify(action)}\n`)
  }

  readBlockedActions(pid: ProjectId, workerId: WorkerId): BlockedAction[] {
    const file = join(this.projectDir(pid), 'blocked', `${workerId}.jsonl`)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as BlockedAction)
  }

  readReports(pid: ProjectId, workerId: WorkerId): WorkerReport[] {
    const file = join(this.projectDir(pid), 'reports', `${workerId}.jsonl`)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as WorkerReport)
  }

  // ------------------------------------------------------------ receipts

  createReceipt(receipt: Omit<Receipt, 'id' | 'createdAt'>): Receipt {
    const record: Receipt = { ...receipt, id: newId('rcpt'), createdAt: now() }
    this.put('receipts', record)
    this.appendEvent({
      type: 'receipt/created', projectId: receipt.projectId, taskId: receipt.taskId,
      data: {
        receiptId: record.id, verdict: record.verdict, attempt: record.attempt, claimOverruled: record.claimOverruled, reason: record.reason,
        integrityBlocked: (record.integrity?.findings ?? []).some(f => f.severity === 'block'), impactedModules: record.impactedModules,
      },
    })
    return record
  }
  getReceipt(pid: ProjectId, id: ReceiptId): Receipt | undefined { return this.readJson(this.recordPath(pid, 'receipts', id)) }
  listReceipts(pid: ProjectId, taskId?: TaskId): Receipt[] {
    const all = this.list<Receipt>(pid, 'receipts')
    return taskId ? all.filter(r => r.taskId === taskId) : all
  }

  // ------------------------------------------------------------ human gates

  openHumanGate(gate: Omit<HumanGate, 'id' | 'createdAt' | 'status'>): HumanGate {
    const record: HumanGate = { ...gate, id: newId('hg'), status: 'open', createdAt: now() }
    this.put('human-gates', record)
    this.appendEvent({ type: 'human-gate/opened', projectId: gate.projectId, taskId: gate.taskId, data: { humanGateId: record.id, reason: gate.reason, detail: gate.detail, actions: gate.actions?.length ?? 0 } })
    return record
  }
  getHumanGate(pid: ProjectId, id: HumanGateId): HumanGate | undefined { return this.readJson(this.recordPath(pid, 'human-gates', id)) }
  listHumanGates(pid: ProjectId, status?: HumanGate['status']): HumanGate[] {
    const all = this.list<HumanGate>(pid, 'human-gates')
    return status ? all.filter(g => g.status === status) : all
  }
  resolveHumanGate(pid: ProjectId, id: HumanGateId, decision: 'approved' | 'rejected', resolution: string): HumanGate {
    const gate = this.getHumanGate(pid, id)
    if (!gate) throw new Error(`human gate ${id} not found`)
    if (gate.status !== 'open') throw new Error(`human gate ${id} already ${gate.status}`)
    const next: HumanGate = { ...gate, status: decision, resolution, resolvedAt: now() }
    this.put('human-gates', next)
    this.appendEvent({ type: 'human-gate/resolved', projectId: pid, taskId: gate.taskId, data: { humanGateId: id, decision, resolution } })
    return next
  }

  // ------------------------------------------------------------ task leases

  /**
   * Acquire the run lease for a task (O_EXCL lock file). A lease whose holder process no
   * longer exists is taken over; a live holder (this or another process) wins.
   * @returns true when this process now holds the lease.
   */
  acquireLease(pid: ProjectId, taskId: TaskId, owner = 'engine'): boolean {
    const dir = join(this.projectDir(pid), 'leases')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${taskId}.lock`)
    const lease: TaskLease = { pid: process.pid, acquiredAt: now(), owner }
    for (let tries = 0; tries < 2; tries++) {
      try {
        writeFileSync(file, JSON.stringify(lease), { flag: 'wx' })
        return true
      } catch (exists) {
        void exists
        const holder = this.readLease(pid, taskId)
        if (holder && processAlive(holder.pid)) return false
        try {
          unlinkSync(file) // stale lease from a dead process
        } catch (raced) {
          void raced // another process removed it first; retry the exclusive create
        }
      }
    }
    return false
  }

  readLease(pid: ProjectId, taskId: TaskId): TaskLease | undefined {
    const file = join(this.projectDir(pid), 'leases', `${taskId}.lock`)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as TaskLease
    } catch (torn) {
      void torn
      return { pid: -1, acquiredAt: '', owner: 'torn' }
    }
  }

  /** Task ids with a lease file in the project (live or stale). */
  listLeases(pid: ProjectId): TaskId[] {
    const dir = join(this.projectDir(pid), 'leases')
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.lock')).map(f => f.slice(0, -5)) : []
  }

  releaseLease(pid: ProjectId, taskId: TaskId): void {
    const holder = this.readLease(pid, taskId)
    if (holder?.pid !== process.pid) return
    try {
      unlinkSync(join(this.projectDir(pid), 'leases', `${taskId}.lock`))
    } catch (gone) {
      void gone
    }
  }

  /** Remove a lease whose holder process no longer exists. @returns whether it was removed. */
  removeStaleLease(pid: ProjectId, taskId: TaskId): boolean {
    const holder = this.readLease(pid, taskId)
    if (!holder || processAlive(holder.pid)) return false
    try {
      unlinkSync(join(this.projectDir(pid), 'leases', `${taskId}.lock`))
      return true
    } catch (gone) {
      void gone
      return false
    }
  }

  // ------------------------------------------------------------ generic records (wakes, meta)

  /** Durable per-project record in a named collection (e.g. Chief wakes). */
  putRecord<T extends { id: string; projectId: ProjectId }>(collection: RecordCollection, record: T): T {
    return this.put(collection, record)
  }
  getRecord<T>(pid: ProjectId, collection: RecordCollection, id: string): T | undefined {
    return this.readJson<T>(this.recordPath(pid, collection, id))
  }
  listRecords<T>(pid: ProjectId, collection: RecordCollection): T[] {
    return this.list<T>(pid, collection)
  }
  /** Small per-project key/value state (cursors, session ids). */
  getMeta<T>(pid: ProjectId, key: string): T | undefined {
    if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid meta key ${key}`)
    return this.readJson<T>(join(this.projectDir(pid), 'meta', `${key}.json`))
  }
  setMeta(pid: ProjectId, key: string, value: unknown): void {
    if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid meta key ${key}`)
    this.writeJson(join(this.projectDir(pid), 'meta', `${key}.json`), value)
  }

  // ------------------------------------------------------------ events

  /**
   * Append an event and notify in-process subscribers.
   * @returns the event with its per-project sequence number.
   */
  appendEvent(input: NewEvent): SuperAgentEvent {
    const file = join(this.projectDir(input.projectId), 'events.jsonl')
    mkdirSync(this.projectDir(input.projectId), { recursive: true })
    const line = { ...input, ts: input.ts ?? now() }
    appendFileSync(file, `${JSON.stringify(line)}\n`)
    const seq = this.countEventLines(input.projectId, file)
    const event = { seq, ...line } as SuperAgentEvent
    this.emitter.emit('event', event)
    return event
  }

  private countEventLines(pid: ProjectId, file: string): number {
    let [offset, lines] = this.eventCursor.get(pid) ?? [0, 0]
    const size = statSync(file).size
    if (size > offset) {
      const fd = openSync(file, 'r')
      try {
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        for (const byte of buf) if (byte === 0x0a) lines++
      } finally {
        closeSync(fd)
      }
      offset = size
      this.eventCursor.set(pid, [offset, lines])
    }
    return lines
  }

  /**
   * Read events with `seq > since` (cross-process safe: reads the file).
   * @param limit - maximum events returned (newest kept when trimming from `since=0`).
   */
  readEvents(pid: ProjectId, since = 0, limit = 1000): SuperAgentEvent[] {
    const file = join(this.projectDir(pid), 'events.jsonl')
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n')
    const out: SuperAgentEvent[] = []
    for (let i = since; i < lines.length; i++) {
      if (!lines[i]) continue
      let parsed: Omit<SuperAgentEvent, 'seq'>
      try {
        parsed = JSON.parse(lines[i]!) as Omit<SuperAgentEvent, 'seq'>
      } catch (partial) {
        // A crash mid-append leaves a torn last line. Skip it (seq stays = line number);
        // a torn line in the middle is corruption and must not be silently ignored.
        if (i >= lines.length - 2) continue
        throw new StateCorruptError(`${file}:${i + 1}`, partial)
      }
      out.push({ seq: i + 1, ...parsed } as SuperAgentEvent)
    }
    return out.length > limit ? out.slice(-limit) : out
  }

  /** Sequence number of the newest event (0 when none), without parsing the log. */
  lastEventSeq(pid: ProjectId): number {
    const file = join(this.projectDir(pid), 'events.jsonl')
    return existsSync(file) ? this.countEventLines(pid, file) : 0
  }

  /** Byte offset where line `seq + 1` starts, per project (events only append). */
  private readonly tailOffsets = new Map<string, Map<number, number>>()

  /**
   * Oldest-first events with `seq > since`, at most `limit` — for consumers that
   * follow the log (SSE, wake monitor). Resumes from a cached byte offset instead of
   * re-reading the file, and never returns an unterminated (in-progress/torn) tail line.
   */
  tailEvents(pid: ProjectId, since = 0, limit = 1000): SuperAgentEvent[] {
    const file = join(this.projectDir(pid), 'events.jsonl')
    if (!existsSync(file)) return []
    let offsets = this.tailOffsets.get(pid)
    if (!offsets) this.tailOffsets.set(pid, offsets = new Map())
    let start = since === 0 ? 0 : offsets.get(since)
    if (start === undefined) {
      // Cold start: find the byte offset after `since` lines.
      const buf = readFileSync(file)
      let line = 0
      start = buf.length
      for (let i = 0; i < buf.length && line < since; i++) if (buf[i] === 0x0a && ++line === since) start = i + 1
      if (line < since) return []
    }
    const size = statSync(file).size
    if (size <= start) return []
    const fd = openSync(file, 'r')
    const chunk = Buffer.alloc(size - start)
    try {
      readSync(fd, chunk, 0, chunk.length, start)
    } finally {
      closeSync(fd)
    }
    const out: SuperAgentEvent[] = []
    let seq = since
    let pos = 0
    let lastGood = start
    let lastSeq = since
    while (out.length < limit) {
      const nl = chunk.indexOf(0x0a, pos)
      if (nl < 0) break // unterminated tail: an append in progress or a torn write
      seq++
      const text = chunk.subarray(pos, nl).toString('utf8')
      pos = nl + 1
      if (text) {
        try {
          out.push({ seq, ...(JSON.parse(text) as Omit<SuperAgentEvent, 'seq'>) } as SuperAgentEvent)
        } catch (partial) {
          // Same rule as readEvents: only the final line may be torn.
          if (chunk.indexOf(0x0a, pos) >= 0) throw new StateCorruptError(`${file}:${seq}`, partial)
        }
      }
      lastGood = start + pos
      lastSeq = seq
    }
    if (offsets.size > 256) offsets.clear()
    offsets.set(lastSeq, lastGood)
    return out
  }

  eventsPath(pid: ProjectId): string { return join(this.projectDir(pid), 'events.jsonl') }

  /** Subscribe to events appended by this process. @returns unsubscribe. */
  subscribe(listener: (event: SuperAgentEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => { this.emitter.off('event', listener) }
  }

  emitTyped(type: SuperAgentEventType, projectId: ProjectId, data: Record<string, unknown>, ids: { goalId?: GoalId; taskId?: TaskId; workerId?: WorkerId } = {}): SuperAgentEvent {
    return this.appendEvent({ type, projectId, data, ...ids })
  }
}

export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return s || newId('proj')
}

/** Whether a process exists (signal 0 probes without delivering anything). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
