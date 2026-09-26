/** System routes: health, providers, model presets (and later backup, update, cleanup). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StateStore } from '@superagent/project-state'
import { HttpError } from './http.ts'
import { runHealthCheck, type HealthContext } from './ops/health.ts'
import { PROVIDER_APIS, ProviderError, listProviders, probeProvider, removeProvider, saveProvider, storedConnection, testModel, type ProviderApi } from './ops/providers.ts'
import { PresetError, applyPreset, presetViews, savePresets } from './ops/presets.ts'

type Role = 'human' | 'agent' | 'anonymous'
type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: any; query: URLSearchParams; role: Role }) => unknown | Promise<unknown>
export type RouteFn = (method: string, path: string, handler: Handler, level?: 'read' | 'agent' | 'human') => void

export interface SystemDeps {
  readonly store: StateStore
  readonly healthCtx: () => HealthContext
}

const as400 = async <T>(fn: () => T | Promise<T>, ...types: Array<new (...a: any[]) => Error>): Promise<T> => {
  try {
    return await fn()
  } catch (error) {
    if (types.some(t => error instanceof t)) throw new HttpError(400, (error as Error).message)
    throw error
  }
}

export function registerSystemRoutes(route: RouteFn, deps: SystemDeps): void {
  const { store } = deps
  // Health: the quick check is free; `deep` sends one tiny request per model, so it is human-only.
  route('GET', '/api/system/health', () => runHealthCheck(deps.healthCtx()))
  route('POST', '/api/system/health', ({ body }) => runHealthCheck({ ...deps.healthCtx(), deep: body?.deep === true }), 'human')

  // Providers (keys are write-only).
  const connection = (body: any): { api: ProviderApi; baseURL: string; apiKey?: string } => {
    const stored = typeof body?.name === 'string' ? storedConnection(store.home, body.name) : undefined
    const api = (body?.api ?? stored?.api ?? 'openai-completions') as ProviderApi
    if (!PROVIDER_APIS.includes(api)) throw new ProviderError(`api must be ${PROVIDER_APIS.join(' | ')}`)
    const baseURL = String(body?.baseURL ?? stored?.baseURL ?? '')
    const apiKey = typeof body?.apiKey === 'string' && body.apiKey ? body.apiKey : stored?.apiKey
    return { api, baseURL, apiKey }
  }
  route('GET', '/api/system/providers', () => ({ providers: listProviders(store.home), apis: PROVIDER_APIS }))
  route('POST', '/api/system/providers/probe', ({ body }) => as400(() => probeProvider(connection(body)), ProviderError), 'human')
  route('POST', '/api/system/providers/test', ({ body }) => as400(() => {
    if (typeof body?.model !== 'string' || !body.model) throw new ProviderError('model is required')
    return testModel({ ...connection(body), model: body.model })
  }, ProviderError), 'human')
  route('POST', '/api/system/providers', ({ body }) => as400(() => saveProvider(store.home, {
    name: String(body?.name ?? ''), api: body?.api, baseURL: String(body?.baseURL ?? ''),
    apiKey: typeof body?.apiKey === 'string' ? body.apiKey : undefined,
    models: Array.isArray(body?.models) ? body.models.map((m: any) => (typeof m === 'string' ? { id: m } : m)) : [],
    makeLocalDefault: body?.makeLocalDefault === true,
  }), ProviderError), 'human')
  route('POST', '/api/system/providers/:name/delete', ({ params }) => as400(() => { removeProvider(store.home, params.name!); return { providers: listProviders(store.home) } }, ProviderError), 'human')

  // Model presets.
  route('GET', '/api/system/presets', () => ({ presets: presetViews(store.home) }))
  route('POST', '/api/system/presets', ({ body }) => as400(() => { savePresets(store.home, body?.presets); return { presets: presetViews(store.home) } }, PresetError), 'human')
  route('POST', '/api/system/presets/:id/apply', ({ params }) => as400(() => { const policy = applyPreset(store.home, params.id!); return { policy, presets: presetViews(store.home) } }, PresetError), 'human')
}
