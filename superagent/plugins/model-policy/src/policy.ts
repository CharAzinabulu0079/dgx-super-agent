/**
 * Model Policy (Freeze §11, Directive §4.F). Transparent role → provider/model selection,
 * no automatic router. Layers (later wins):
 *
 *   built-in defaults ← global ($SUPERAGENT_HOME/policy.json) ← project record ← task pin
 *
 * Roles a task did not pin are resolved at attempt time, so changing the global or
 * project Worker default ("all Workers use this cheap model") applies to queued tasks
 * immediately, without any model call. Policy never lives in the Worker-writable tree.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContractError, parseModelRef, parseTaskPolicy, RETRY_STRATEGIES,
  AUTONOMY_LEVELS, type Autonomy, type ModelRef, type ModelRole, type PolicyLayer, type Project, type RetryStrategy, type Task, type TaskPolicy,
} from '@superagent/contracts'

/**
 * `local-default` is a logical provider: on DGX it maps to the existing OpenAI-compatible
 * local inference service (Freeze §0.1-9) through `model-routes.json`; in Cloud to
 * whatever `DEEPSEEK_BASE_URL` points at.
 */
export const LOCAL_DEFAULT: ModelRef = { provider: 'local-default', model: 'default' }
export const MODEL_ROLES: readonly ModelRole[] = ['chief', 'worker', 'reviewer', 'escalation', 'planner']

export const DEFAULT_POLICY: TaskPolicy = {
  model: { worker: LOCAL_DEFAULT },
  production_write: false,
  maxAttempts: 6,
  maxSameFailure: 2,
  strategies: ['retry-with-feedback', 'fresh-context', 'escalate-model'],
}

/** Validate an untrusted policy layer (API/CLI/file input). */
export function parsePolicyLayer(value: unknown, path = 'policy'): PolicyLayer {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ContractError(path, 'expected object')
  const o = value as Record<string, unknown>
  const models: Partial<Record<ModelRole, ModelRef>> = {}
  if (o.models !== undefined) {
    if (typeof o.models !== 'object' || o.models === null) throw new ContractError(`${path}.models`, 'expected object')
    for (const [role, ref] of Object.entries(o.models as Record<string, unknown>)) {
      if (!MODEL_ROLES.includes(role as ModelRole)) throw new ContractError(`${path}.models.${role}`, `unknown role (${MODEL_ROLES.join('|')})`)
      if (ref === null) continue
      models[role as ModelRole] = typeof ref === 'string' ? (parseModelSpec(ref) ?? (() => { throw new ContractError(`${path}.models.${role}`, 'expected provider/model') })()) : parseModelRef(ref, `${path}.models.${role}`)
    }
  }
  const int = (k: 'maxAttempts' | 'maxSameFailure'): number | undefined => {
    const v = o[k]
    if (v === undefined) return undefined
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 50) throw new ContractError(`${path}.${k}`, 'expected integer 1..50')
    return v
  }
  let strategies: RetryStrategy[] | undefined
  if (o.strategies !== undefined) {
    if (!Array.isArray(o.strategies) || !o.strategies.length || !o.strategies.every(s => RETRY_STRATEGIES.includes(s as RetryStrategy))) throw new ContractError(`${path}.strategies`, 'invalid strategies')
    strategies = o.strategies as RetryStrategy[]
  }
  let autonomy: Autonomy | undefined
  if (o.autonomy !== undefined && o.autonomy !== null) {
    if (!AUTONOMY_LEVELS.includes(o.autonomy as Autonomy)) throw new ContractError(`${path}.autonomy`, `expected ${AUTONOMY_LEVELS.join('|')}`)
    autonomy = o.autonomy as Autonomy
  }
  return { models, maxAttempts: int('maxAttempts'), maxSameFailure: int('maxSameFailure'), strategies, ...(autonomy ? { autonomy } : {}) }
}

export function loadGlobalPolicy(home: string): PolicyLayer {
  const file = join(home, 'policy.json')
  return existsSync(file) ? parsePolicyLayer(JSON.parse(readFileSync(file, 'utf8')), 'global') : {}
}

export function saveGlobalPolicy(home: string, layer: PolicyLayer): PolicyLayer {
  const valid = parsePolicyLayer(layer, 'global')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'policy.json.tmp'), `${JSON.stringify(valid, null, 2)}\n`)
  renameSync(join(home, 'policy.json.tmp'), join(home, 'policy.json'))
  return valid
}

/** Merge two layers (b wins); a `null` model in b clears that role. */
export function mergeLayers(a: PolicyLayer, b: PolicyLayer): PolicyLayer {
  return {
    models: { ...a.models, ...b.models },
    maxAttempts: b.maxAttempts ?? a.maxAttempts,
    maxSameFailure: b.maxSameFailure ?? a.maxSameFailure,
    strategies: b.strategies ?? a.strategies,
    autonomy: b.autonomy ?? a.autonomy,
  }
}

/** Safe mode in effect for a project (global ← project), read at attempt time. */
export function autonomyFor(home: string, project?: Project): Autonomy {
  return mergeLayers(loadGlobalPolicy(home), project?.policy ?? {}).autonomy ?? 'normal'
}

/** Effective role → model map for a project (and a task's pins). */
export function effectiveModels(global: PolicyLayer, project?: PolicyLayer, pinned?: Partial<Record<ModelRole, ModelRef>>): Partial<Record<ModelRole, ModelRef>> & { worker: ModelRef } {
  const merged = { worker: LOCAL_DEFAULT, ...global.models, ...project?.models, ...pinned }
  return merged as Partial<Record<ModelRole, ModelRef>> & { worker: ModelRef }
}

/**
 * Policy for a new task. Model roles present in the override are pinned; the rest follow
 * live defaults (see {@link livePolicy}).
 */
export function resolveTaskPolicy(layers: { global: PolicyLayer; project?: PolicyLayer }, override?: unknown): { policy: TaskPolicy; pinned: Partial<Record<ModelRole, ModelRef>> } {
  const base = mergeLayers(layers.global, layers.project ?? {})
  const models = effectiveModels(layers.global, layers.project)
  const defaults: TaskPolicy = {
    ...DEFAULT_POLICY,
    model: { worker: models.worker, planner: models.planner, reviewer: models.reviewer, escalation: models.escalation },
    maxAttempts: base.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
    maxSameFailure: base.maxSameFailure ?? DEFAULT_POLICY.maxSameFailure,
    strategies: base.strategies ?? DEFAULT_POLICY.strategies,
  }
  const policy = parseTaskPolicy(override, defaults)
  const pinned: Partial<Record<ModelRole, ModelRef>> = {}
  const o = override as { model?: Record<string, unknown> } | undefined
  for (const role of ['worker', 'planner', 'reviewer', 'escalation'] as const) {
    if (o?.model?.[role] !== undefined && policy.model[role]) pinned[role] = policy.model[role]
  }
  return { policy, pinned }
}

/** A task's policy with un-pinned model roles re-resolved from the current layers. */
export function livePolicy(home: string, project: Project, task: Task): TaskPolicy {
  const models = effectiveModels(loadGlobalPolicy(home), project.policy, task.pinnedModels)
  return { ...task.policy, model: { worker: models.worker, planner: models.planner, reviewer: models.reviewer, escalation: models.escalation } }
}

/** Model for a non-task role (chief, reviewer) of a project. */
export function roleModel(home: string, project: Project | undefined, role: ModelRole): ModelRef {
  const models = effectiveModels(loadGlobalPolicy(home), project?.policy)
  return models[role] ?? models.worker
}

/** The model a Worker attempt runs with under a retry strategy. */
export function modelForStrategy(policy: TaskPolicy, strategy: RetryStrategy): ModelRef {
  if (strategy === 'escalate-model' && policy.model.escalation) return policy.model.escalation
  return policy.model.worker
}

/**
 * Parse a user phrase like `anthropic/claude-opus-5-5` or `local-default`.
 * @returns a ModelRef, or undefined when the text is not a model reference.
 */
export function parseModelSpec(spec: string): ModelRef | undefined {
  const s = spec.trim()
  if (!s) return undefined
  if (s === 'local-default' || s === 'local') return LOCAL_DEFAULT
  const slash = s.indexOf('/')
  if (slash <= 0 || slash === s.length - 1) return undefined
  return { provider: s.slice(0, slash), model: s.slice(slash + 1) }
}

export const formatModel = (m: ModelRef): string => `${m.provider}/${m.model}`
