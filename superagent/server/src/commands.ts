/**
 * Human-run shell commands (the ▷ button on code blocks in the UI).
 *
 * Only the human token can start one. The command runs with bash in the project root,
 * in its own process group, with SuperAgent credentials scrubbed from its environment,
 * a timeout and a Stop. Before running, the UI shows the exact command; if the pre-tool
 * classifier flags it (destructive, credentials, production, …) the human must confirm
 * that specifically — agent-written commands can carry injected intent.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, now } from '@superagent/contracts'
import { decideToolCall } from '@superagent/loop-policy'
import type { StateStore } from '@superagent/project-state'
import { workerEnv } from '@superagent/chief-worker'

export interface CommandRecord {
  readonly id: string
  readonly projectId: string
  readonly command: string
  readonly cwd: string
  readonly status: 'running' | 'exited' | 'stopped' | 'timeout' | 'error'
  readonly exitCode: number | null
  readonly startedAt: string
  readonly endedAt?: string
  /** Why the classifier flagged it (the human confirmed anyway). */
  readonly flagged?: string
}

export interface CommandCheck { readonly allowWithoutConfirm: boolean; readonly category?: string; readonly rule?: string }

export const COMMAND_TIMEOUT_MS = 30 * 60_000
const MAX_OUTPUT = 512 * 1024

export class CommandError extends Error {}

export class CommandRunner {
  private readonly store: StateStore
  private readonly running = new Map<string, { kill: () => void; record: CommandRecord }>()

  constructor(store: StateStore) {
    this.store = store
  }

  /** Classify a command with the same rules the pre-tool guard uses for agents. */
  check(projectId: string, command: string): CommandCheck {
    const p = this.store.requireProject(projectId)
    const d = decideToolCall({
      role: 'worker', projectRoot: p.root, verificationPaths: [], protectedModulePaths: [], approvedActions: [],
      forbiddenPaths: [this.store.home], apiOrigins: [], productionWrite: false, tempRoots: [tmpdir(), '/tmp'],
    }, 'bash', { command })
    return d.allow ? { allowWithoutConfirm: true } : { allowWithoutConfirm: false, category: d.category, rule: d.rule }
  }

  start(projectId: string, command: string, confirmedDanger: boolean, timeoutMs = COMMAND_TIMEOUT_MS): CommandRecord {
    const p = this.store.requireProject(projectId)
    const cmd = command.trim()
    if (!cmd) throw new CommandError('empty command')
    if (cmd.length > 10_000) throw new CommandError('command too long')
    const check = this.check(projectId, cmd)
    if (!check.allowWithoutConfirm && !confirmedDanger) throw new CommandError(`needs explicit confirmation: ${check.category} — ${check.rule}`)
    let record: CommandRecord = {
      id: newId('cmd'), projectId, command: cmd, cwd: p.root, status: 'running', exitCode: null, startedAt: now(),
      flagged: check.allowWithoutConfirm ? undefined : `${check.category}: ${check.rule}`,
    }
    mkdirSync(this.dir(projectId), { recursive: true })
    const log = this.logFile(projectId, record.id)
    appendFileSync(log, '')
    const child = spawn('bash', ['-c', cmd], { cwd: p.root, env: workerEnv({ TERM: 'dumb', FORCE_COLOR: '0', NO_COLOR: '1', NODE_TEST_CONTEXT: undefined }), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let written = 0
    const onData = (chunk: Buffer): void => {
      if (written >= MAX_OUTPUT) return
      const slice = chunk.subarray(0, MAX_OUTPUT - written)
      written += slice.length
      appendFileSync(log, slice)
      if (written >= MAX_OUTPUT) appendFileSync(log, '\n… output truncated at 512 KB\n')
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    let ended: CommandRecord['status'] | undefined
    const group = (sig: NodeJS.Signals): void => {
      try { process.kill(-child.pid!, sig) } catch (gone) { void gone }
    }
    const kill = (): void => { group('SIGTERM'); setTimeout(() => group('SIGKILL'), 3_000).unref() }
    const timer = setTimeout(() => { ended = 'timeout'; kill() }, timeoutMs)
    const finish = (status: CommandRecord['status'], exitCode: number | null, note?: string): void => {
      clearTimeout(timer)
      this.running.delete(record.id)
      if (note) appendFileSync(log, `\n[${note}]\n`)
      record = { ...record, status, exitCode, endedAt: now() }
      this.store.putRecord('commands', record)
      this.store.emitTyped('command/updated', projectId, { commandId: record.id, command: cmd.slice(0, 200), status, exitCode })
    }
    child.on('error', error => finish('error', null, String(error)))
    child.on('close', code => finish(ended ?? 'exited', code))
    this.running.set(record.id, { kill: () => { ended = 'stopped'; kill() }, record })
    this.store.putRecord('commands', record)
    this.store.emitTyped('command/updated', projectId, { commandId: record.id, command: cmd.slice(0, 200), status: 'running', exitCode: null, flagged: record.flagged ?? null })
    return record
  }

  stop(projectId: string, id: string): CommandRecord {
    const r = this.running.get(id)
    if (!r || r.record.projectId !== projectId) throw new CommandError('command is not running')
    r.kill()
    return r.record
  }

  get(projectId: string, id: string): { record: CommandRecord; output: string } {
    const record = this.store.getRecord<CommandRecord>(projectId, 'commands', id)
    if (!record) throw new CommandError(`command ${id} not found`)
    const log = this.logFile(projectId, id)
    return { record, output: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  list(projectId: string, limit = 50): CommandRecord[] {
    return this.store.listRecords<CommandRecord>(projectId, 'commands').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
  }

  stopAll(): void {
    for (const r of this.running.values()) r.kill()
  }

  private dir(projectId: string): string {
    return join(this.store.home, 'runtime', 'commands', projectId)
  }

  private logFile(projectId: string, id: string): string {
    if (!/^[\w.-]+$/.test(id)) throw new CommandError('invalid command id')
    return join(this.dir(projectId), `${id}.log`)
  }
}
