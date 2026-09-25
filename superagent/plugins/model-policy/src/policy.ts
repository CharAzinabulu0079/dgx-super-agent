/**
 * Manual Model Policy (Freeze §11). Transparent role → provider/model selection;
 * no automatic router. Resolution order (later wins):
 *   built-in defaults → project `.superagent/policy.json` → task-level override.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTaskPolicy, type ModelRef, type RetryStrategy, type TaskPolicy } from '@superagent/contracts'

/**
 * `local-default` is a logical provider: on DGX it maps to the existing
 * OpenAI-compatible local inference service (Freeze §0.1-9); in Cloud it maps to
 * whatever `DEEPSEEK_BASE_URL` points at.
 */
export const LOCAL_DEFAULT: ModelRef = { provider: 'local-default', model: 'default' }

export const DEFAULT_POLICY: TaskPolicy = {
  model: { worker: LOCAL_DEFAULT },
  production_write: false,
  maxAttempts: 6,
  maxSameFailure: 2,
  strategies: ['retry-with-feedback', 'fresh-context', 'escalate-model'],
}

export function loadProjectPolicy(projectRoot: string): TaskPolicy {
  const file = join(projectRoot, '.superagent', 'policy.json')
  if (!existsSync(file)) return DEFAULT_POLICY
  return parseTaskPolicy(JSON.parse(readFileSync(file, 'utf8')), DEFAULT_POLICY)
}

/**
 * @param override - untrusted task-level policy fragment (user/Chief input).
 * @returns the effective policy.
 */
export function resolveTaskPolicy(projectRoot: string, override?: unknown): TaskPolicy {
  return parseTaskPolicy(override, loadProjectPolicy(projectRoot))
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
