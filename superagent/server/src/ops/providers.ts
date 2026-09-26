/**
 * Provider setup wizard (no model tokens unless you press "test"):
 *   Base URL + key → probe `/models` → pick models → optional 1-token test → save.
 *
 * Saved into `$SUPERAGENT_HOME/model-routes.json` (mode 0600) as a DSH `llm-pi-ai` route
 * (`api`, `baseURL`, `apiKeyEnv`, `models`) with the key under `env`, so the key reaches
 * DSH through its credential reference and never appears in a profile patch. The API never
 * returns keys, only `hasKey`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRoutes } from '@superagent/chief-worker'

export type ProviderApi = 'openai-completions' | 'anthropic-messages'
export const PROVIDER_APIS: readonly ProviderApi[] = ['openai-completions', 'anthropic-messages']

export class ProviderError extends Error {}

export interface ProbeResult {
  readonly ok: boolean
  /** unreachable | unauthorized | not-found | bad-response | ok */
  readonly kind: 'ok' | 'unreachable' | 'unauthorized' | 'not-found' | 'bad-response'
  readonly detail: string
  readonly models: string[]
  readonly latencyMs: number
}

const trimSlash = (u: string) => u.replace(/\/+$/, '')

export function validateBaseUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch (invalid) {
    void invalid
    throw new ProviderError('Base URL must be a full URL, e.g. http://127.0.0.1:8000/v1')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProviderError('Base URL must be http(s)')
  if (u.username || u.password) throw new ProviderError('put the key in the Key field, not in the URL')
  return trimSlash(u.toString())
}

function headers(api: ProviderApi, key?: string): Record<string, string> {
  if (api === 'anthropic-messages') return { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
  return key ? { authorization: `Bearer ${key}` } : {}
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<{ res?: Response; error?: string; ms: number }> {
  const started = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    return { res, ms: Date.now() - started }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code
    return { error: cause ?? String((error as Error).message ?? error), ms: Date.now() - started }
  }
}

/** List models (`GET {base}/models`). Costs no tokens. */
export async function probeProvider(input: { api: ProviderApi; baseURL: string; apiKey?: string; timeoutMs?: number }): Promise<ProbeResult> {
  const base = validateBaseUrl(input.baseURL)
  const r = await timedFetch(`${base}/models`, { headers: headers(input.api, input.apiKey) }, input.timeoutMs ?? 8_000)
  if (!r.res) return { ok: false, kind: 'unreachable', detail: `cannot reach ${base}: ${r.error}`, models: [], latencyMs: r.ms }
  if (r.res.status === 401 || r.res.status === 403) return { ok: false, kind: 'unauthorized', detail: `the server rejected the key (HTTP ${r.res.status})`, models: [], latencyMs: r.ms }
  if (r.res.status === 404) return { ok: false, kind: 'not-found', detail: `${base}/models not found — is the Base URL right (usually ends with /v1)?`, models: [], latencyMs: r.ms }
  if (!r.res.ok) return { ok: false, kind: 'bad-response', detail: `HTTP ${r.res.status}`, models: [], latencyMs: r.ms }
  let body: unknown
  try {
    body = await r.res.json()
  } catch (notJson) {
    void notJson
    return { ok: false, kind: 'bad-response', detail: 'the /models response is not JSON', models: [], latencyMs: r.ms }
  }
  const list = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models
  const models = Array.isArray(list) ? list.map(m => (typeof m === 'string' ? m : (m as { id?: unknown; name?: unknown }).id ?? (m as { name?: unknown }).name)).filter((x): x is string => typeof x === 'string') : []
  if (!models.length) return { ok: false, kind: 'bad-response', detail: 'reachable, but no models listed', models: [], latencyMs: r.ms }
  return { ok: true, kind: 'ok', detail: `${models.length} model(s) available`, models: models.sort(), latencyMs: r.ms }
}

/** One minimal generation (max 1 token) to prove the key and model work end to end. */
export async function testModel(input: { api: ProviderApi; baseURL: string; apiKey?: string; model: string; timeoutMs?: number }): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const base = validateBaseUrl(input.baseURL)
  const body = input.api === 'anthropic-messages'
    ? { model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : { model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  const url = input.api === 'anthropic-messages' ? `${base}/messages` : `${base}/chat/completions`
  const r = await timedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers(input.api, input.apiKey) }, body: JSON.stringify(body) }, input.timeoutMs ?? 30_000)
  if (!r.res) return { ok: false, detail: `cannot reach ${base}: ${r.error}`, latencyMs: r.ms }
  if (!r.res.ok) {
    const text = (await r.res.text().catch(() => '')).slice(0, 300)
    return { ok: false, detail: `HTTP ${r.res.status}${text ? `: ${text}` : ''}`, latencyMs: r.ms }
  }
  return { ok: true, detail: `responded in ${r.ms} ms`, latencyMs: r.ms }
}

// ---------------------------------------------------------------- persistence (model-routes.json)

const routesFile = (home: string) => join(home, 'model-routes.json')

export function readRoutes(home: string): ModelRoutes {
  const f = routesFile(home)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ModelRoutes) : {}
}

function writeRoutes(home: string, routes: ModelRoutes): void {
  mkdirSync(home, { recursive: true })
  const f = routesFile(home)
  writeFileSync(`${f}.tmp`, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${f}.tmp`, f)
  chmodSync(f, 0o600)
}

export interface ProviderView {
  readonly name: string
  readonly api?: string
  readonly baseURL?: string
  readonly models: string[]
  readonly hasKey: boolean
  /** true when `local-default` maps to this provider */
  readonly isLocalDefault: boolean
}

/**
 * DSH's llm-pi-ai refuses to call a provider without a key ("No API key for provider"),
 * but a local server (llama.cpp, vLLM) usually needs none. Keyless providers therefore
 * point at this shared placeholder, which is not reported or sent back as a real key.
 */
export const KEYLESS_ENV = 'SA_KEYLESS'
const isRealKeyEnv = (v: string | undefined): v is string => !!v && v !== KEYLESS_ENV

type PiAiProvider = { api?: string; baseURL?: string; apiKeyEnv?: string; models?: Array<{ id: string; contextWindow?: number }>; displayName?: string }

export function listProviders(home: string): ProviderView[] {
  const r = readRoutes(home)
  const local = r.aliases?.['local-default']
  return Object.entries((r.piAiProviders ?? {}) as Record<string, PiAiProvider>).map(([name, p]) => ({
    name, api: p.api, baseURL: p.baseURL, models: (p.models ?? []).map(m => m.id),
    hasKey: !!(isRealKeyEnv(p.apiKeyEnv) && (r.env?.[p.apiKeyEnv] || process.env[p.apiKeyEnv])),
    isLocalDefault: local?.provider === name,
  }))
}

export interface SaveProviderInput {
  readonly name: string
  readonly api: ProviderApi
  readonly baseURL: string
  /** omitted = keep the stored key; '' = remove it */
  readonly apiKey?: string
  readonly models: ReadonlyArray<{ id: string; contextWindow?: number }>
  /** also map `local-default` to this provider's first model */
  readonly makeLocalDefault?: boolean
}

export function saveProvider(home: string, input: SaveProviderInput): ProviderView {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(input.name)) throw new ProviderError('name: lowercase letters, digits and dashes')
  if (['local-default', 'deepseek', 'deepseek-official'].includes(input.name)) throw new ProviderError(`"${input.name}" is reserved`)
  if (!PROVIDER_APIS.includes(input.api)) throw new ProviderError(`api must be ${PROVIDER_APIS.join(' | ')}`)
  const baseURL = validateBaseUrl(input.baseURL)
  const models = input.models.filter(m => typeof m.id === 'string' && m.id.trim()).map(m => ({ id: m.id.trim(), ...(m.contextWindow ? { contextWindow: Math.max(1024, Math.floor(m.contextWindow)) } : {}) }))
  if (!models.length) throw new ProviderError('pick at least one model')
  const r = readRoutes(home)
  const keyEnv = `SA_KEY_${input.name.toUpperCase().replace(/-/g, '_')}`
  const env = { ...r.env }
  if (input.apiKey !== undefined) {
    if (input.apiKey) env[keyEnv] = input.apiKey
    else delete env[keyEnv]
  }
  const providers = { ...(r.piAiProviders as Record<string, PiAiProvider> | undefined) }
  if (!env[keyEnv]) env[KEYLESS_ENV] = 'no-key'
  providers[input.name] = { api: input.api, baseURL, apiKeyEnv: env[keyEnv] ? keyEnv : KEYLESS_ENV, models }
  const aliases = { ...r.aliases }
  if (input.makeLocalDefault) aliases['local-default'] = { provider: input.name, model: models[0]!.id }
  writeRoutes(home, { ...r, piAiProviders: providers, env, aliases })
  return listProviders(home).find(p => p.name === input.name)!
}

export function removeProvider(home: string, name: string): void {
  const r = readRoutes(home)
  const providers = { ...(r.piAiProviders as Record<string, PiAiProvider> | undefined) }
  if (!providers[name]) throw new ProviderError(`provider ${name} not found`)
  const keyEnv = providers[name]!.apiKeyEnv
  delete providers[name]
  const env = { ...r.env }
  if (isRealKeyEnv(keyEnv)) delete env[keyEnv]
  const aliases = Object.fromEntries(Object.entries(r.aliases ?? {}).filter(([, a]) => a.provider !== name))
  writeRoutes(home, { ...r, piAiProviders: providers, env, aliases })
}

/** Stored connection details (with key) for probing/testing a saved provider. */
export function storedConnection(home: string, name: string): { api: ProviderApi; baseURL: string; apiKey?: string } | undefined {
  const r = readRoutes(home)
  const p = (r.piAiProviders as Record<string, PiAiProvider> | undefined)?.[name]
  if (!p?.baseURL || !PROVIDER_APIS.includes(p.api as ProviderApi)) return undefined
  return { api: p.api as ProviderApi, baseURL: p.baseURL, apiKey: isRealKeyEnv(p.apiKeyEnv) ? r.env?.[p.apiKeyEnv] ?? process.env[p.apiKeyEnv] : undefined }
}
