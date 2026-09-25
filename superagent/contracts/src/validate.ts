/**
 * Runtime validation for records that cross a trust boundary: model/tool JSON
 * (WorkerReport), user-supplied policy/gate files, and durable files read back.
 */
import type { GateSpec, ModelRef, RetryStrategy, TaskPolicy, WorkerClaim, WorkerReport, WorkerReportKind } from './types.ts'

export class ContractError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.path = path
    this.name = 'ContractError'
  }
}

type Json = Record<string, unknown>

function obj(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContractError(path, 'expected object')
  return value as Json
}
function str(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ContractError(path, 'expected string')
  return value
}
function strOrNull(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null
  return str(value, path)
}
function strList(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ContractError(path, 'expected string[]')
  return value.map((v, i) => str(v, `${path}[${i}]`))
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ContractError(path, `expected one of ${allowed.join('|')}, got ${JSON.stringify(value)}`)
  }
  return value as T
}
function posInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ContractError(path, 'expected positive integer')
  return value
}

export const REPORT_KINDS: readonly WorkerReportKind[] = ['progress', 'blocker', 'result']
export const WORKER_CLAIMS: readonly WorkerClaim[] = ['claimed_pass', 'claimed_fail', 'not_run']
export const RETRY_STRATEGIES: readonly RetryStrategy[] = ['retry-with-feedback', 'fresh-context', 'escalate-model']

export function parseModelRef(value: unknown, path = 'model'): ModelRef {
  const o = obj(value, path)
  return { provider: str(o.provider, `${path}.provider`), model: str(o.model, `${path}.model`) }
}

/**
 * Validate a Worker report produced by a model. Lenient on optional fields,
 * strict on the enumerations the loop branches on.
 * @param value - untrusted JSON.
 * @param fallback - task id / model used when the model omits them.
 * @returns a normalized report.
 */
export function parseWorkerReport(value: unknown, fallback: { task_id: string; model: ModelRef }): WorkerReport {
  const o = obj(value, 'report')
  const progressRaw = o.progress === undefined ? 0 : o.progress
  if (typeof progressRaw !== 'number' || Number.isNaN(progressRaw)) throw new ContractError('report.progress', 'expected number')
  return {
    task_id: o.task_id === undefined ? fallback.task_id : str(o.task_id, 'report.task_id'),
    kind: oneOf(o.kind ?? 'progress', REPORT_KINDS, 'report.kind'),
    current_state: o.current_state === undefined ? 'unknown' : str(o.current_state, 'report.current_state'),
    progress: Math.max(0, Math.min(100, progressRaw)),
    changed_modules: strList(o.changed_modules, 'report.changed_modules'),
    verification_result: oneOf(o.verification_result ?? 'not_run', WORKER_CLAIMS, 'report.verification_result'),
    blocker: strOrNull(o.blocker, 'report.blocker'),
    next_action: strOrNull(o.next_action, 'report.next_action'),
    human_required: o.human_required === true,
    model: o.model === undefined ? fallback.model : parseModelRef(o.model, 'report.model'),
    summary: o.summary === undefined ? '' : str(o.summary, 'report.summary'),
  }
}

export function parseGateSpec(value: unknown, path = 'gate'): GateSpec {
  const o = obj(value, path)
  const kind = oneOf(o.kind ?? 'command', ['command', 'e2e', 'architecture-drift', 'hygiene'] as const, `${path}.kind`)
  if ((kind === 'command' || kind === 'e2e') && typeof o.command !== 'string') throw new ContractError(`${path}.command`, `required for ${kind} gates`)
  return {
    id: str(o.id, `${path}.id`),
    kind,
    command: o.command === undefined ? undefined : str(o.command, `${path}.command`),
    cwd: o.cwd === undefined ? undefined : str(o.cwd, `${path}.cwd`),
    timeoutMs: o.timeoutMs === undefined ? undefined : posInt(o.timeoutMs, `${path}.timeoutMs`),
    required: o.required !== false,
    parser: o.parser === undefined ? undefined : oneOf(o.parser, ['exit-code', 'node-test', 'playwright-json'] as const, `${path}.parser`),
    assets: o.assets === undefined ? undefined : strList(o.assets, `${path}.assets`),
    minTests: o.minTests === undefined ? undefined : posInt(o.minTests, `${path}.minTests`),
    env: o.env === undefined ? undefined : Object.fromEntries(Object.entries(obj(o.env, `${path}.env`)).map(([k, v]) => [k, str(v, `${path}.env.${k}`)])),
    heldOut: o.heldOut === undefined ? undefined : (() => {
      const h = obj(o.heldOut, `${path}.heldOut`)
      const mountAt = str(h.mountAt, `${path}.heldOut.mountAt`)
      if (mountAt.startsWith('/') || mountAt.split('/').includes('..')) throw new ContractError(`${path}.heldOut.mountAt`, 'must be a project-relative path without ..')
      return { source: str(h.source, `${path}.heldOut.source`), mountAt }
    })(),
  }
}

export function parseTaskPolicy(value: unknown, defaults: TaskPolicy): TaskPolicy {
  if (value === undefined) return defaults
  const o = obj(value, 'policy')
  const m = o.model === undefined ? {} : obj(o.model, 'policy.model')
  const pick = (key: 'planner' | 'worker' | 'reviewer' | 'escalation'): ModelRef | undefined =>
    m[key] === undefined ? defaults.model[key] : parseModelRef(m[key], `policy.model.${key}`)
  const strategies = o.strategies === undefined
    ? defaults.strategies
    : strList(o.strategies, 'policy.strategies').map((s, i) => oneOf(s, RETRY_STRATEGIES, `policy.strategies[${i}]`))
  if (strategies.length === 0) throw new ContractError('policy.strategies', 'must not be empty')
  return {
    model: { planner: pick('planner'), worker: pick('worker') ?? defaults.model.worker, reviewer: pick('reviewer'), escalation: pick('escalation') },
    production_write: o.production_write === true,
    maxAttempts: o.maxAttempts === undefined ? defaults.maxAttempts : posInt(o.maxAttempts, 'policy.maxAttempts'),
    maxSameFailure: o.maxSameFailure === undefined ? defaults.maxSameFailure : posInt(o.maxSameFailure, 'policy.maxSameFailure'),
    strategies,
  }
}
