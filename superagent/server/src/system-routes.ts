/** System routes: health, providers, model presets (and later backup, update, cleanup). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StateStore } from '@superagent/project-state'
import { HttpError } from './http.ts'
import { runHealthCheck, type HealthContext } from './ops/health.ts'
import { PROVIDER_APIS, ProviderError, listProviders, probeProvider, removeProvider, saveProvider, storedConnection, testModel, type ProviderApi } from './ops/providers.ts'
import { PresetError, applyPreset, presetViews, savePresets } from './ops/presets.ts'
import { UpdateError, isSupervised, scheduleRestart, type UpdateManager } from './ops/update.ts'
import { ScanError, initGit, listDirs, scanProject } from './ops/project-scan.ts'
import { CLEANUP_KINDS, applyCleanup, previewCleanup, type CleanupContext } from './ops/cleanup.ts'
import { BackupError, createBackup, deleteBackup, importBackup, listBackups, restoreBackup } from './ops/backup.ts'

type Role = 'human' | 'agent' | 'anonymous'
type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: any; query: URLSearchParams; role: Role }) => unknown | Promise<unknown>
export type RouteFn = (method: string, path: string, handler: Handler, level?: 'read' | 'agent' | 'human', raw?: { types: RegExp; maxBytes: number }) => void

export interface SystemDeps {
  readonly store: StateStore
  readonly healthCtx: () => HealthContext
  /** Why state must not be swapped right now (a goal or command is running), if so. */
  readonly busy: () => string | undefined
  /** Short-lived download link for a backup archive. */
  readonly backupLink: (id: string) => string
  readonly appVersion: () => { appVersion?: string; commit?: string }
  /** Present when the server runs from a managed install (`sa install`). */
  readonly update?: UpdateManager
  /** Restart through the supervisor (default: exit 75 when supervised). */
  readonly restart?: () => boolean
  readonly cleanupCtx: () => CleanupContext
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
  // Backup / Restore (human only: archives hold all project state).
  const backups = () => listBackups(store.home).map(b => ({ ...b, url: deps.backupLink(b.id) }))
  route('GET', '/api/system/backups', () => ({ backups: backups() }), 'human')
  route('POST', '/api/system/backups', ({ body }) => as400(() => {
    createBackup(store.home, { label: typeof body?.label === 'string' ? body.label : 'manual', includeSecrets: body?.includeSecrets === true, includeSessions: body?.includeSessions === true, ...deps.appVersion() })
    return { backups: backups() }
  }, BackupError), 'human')
  route('POST', '/api/system/backups/upload', ({ body }) => as400(() => {
    if (!Buffer.isBuffer(body)) throw new BackupError('send the .tar.gz file')
    importBackup(store.home, body)
    return { backups: backups() }
  }, BackupError), 'human', { types: /^application\/(gzip|x-gzip|octet-stream)\b/, maxBytes: 1024 ** 3 })
  route('POST', '/api/system/backups/:id/delete', ({ params }) => as400(() => { deleteBackup(store.home, params.id!); return { backups: backups() } }, BackupError), 'human')
  route('POST', '/api/system/backups/:id/restore', ({ params }) => as400(() => {
    const busy = deps.busy()
    if (busy) throw new BackupError(`cannot restore while ${busy}; stop it first`)
    const r = restoreBackup(store.home, params.id!, deps.appVersion())
    return { ...r, backups: backups() }
  }, BackupError), 'human')

  // Project Add wizard (human: browses the server's folders).
  route('GET', '/api/system/dirs', ({ query }) => as400(() => listDirs(query.get('path') ?? undefined, query.get('hidden') === '1'), ScanError), 'human')
  route('POST', '/api/system/scan', ({ body }) => as400(() => scanProject(String(body?.root ?? ''), store), ScanError), 'human')
  route('POST', '/api/system/scan/git-init', ({ body }) => as400(() => { initGit(String(body?.root ?? '')); return scanProject(String(body.root), store) }, ScanError), 'human')

  // Cleanup: preview, then apply the chosen kinds.
  route('GET', '/api/system/cleanup', ({ query }) => ({ items: previewCleanup({ ...deps.cleanupCtx(), days: Number(query.get('days') ?? 14) || 14 }), kinds: CLEANUP_KINDS }), 'human')
  route('POST', '/api/system/cleanup', ({ body }) => {
    const kinds = Array.isArray(body?.kinds) ? body.kinds.filter((k: unknown) => CLEANUP_KINDS.includes(k as never)) : []
    if (!kinds.length) throw new HttpError(400, `choose what to clean: ${CLEANUP_KINDS.join(', ')}`)
    const ctx = { ...deps.cleanupCtx(), days: Number(body?.days ?? 14) || 14 }
    const done = applyCleanup(ctx, kinds)
    return { done, items: previewCleanup(ctx) }
  }, 'human')

  // Update / Rollback / Restart.
  const supervised = () => isSupervised() || !!deps.restart
  const restart = () => (deps.restart ? deps.restart() : isSupervised() ? (scheduleRestart(), true) : false)
  route('GET', '/api/system/update', () => deps.update
    ? { ...deps.update.status(), supervised: supervised(), running: deps.appVersion() }
    : { managed: false, supervised: supervised(), running: deps.appVersion(), hint: 'Updates need a managed install: `sa install --dir ~/superagent`, then run the service from ~/superagent/current (`sa service install`).' }, 'human')
  const needUpdate = (): UpdateManager => {
    if (!deps.update) throw new UpdateError('not a managed install — run `sa install --dir ~/superagent` and start SuperAgent from there')
    return deps.update
  }
  route('POST', '/api/system/update/check', () => as400(() => needUpdate().check(), UpdateError), 'human')
  route('POST', '/api/system/update', ({ body }) => as400(() => {
    if (typeof body?.ref !== 'string' || !body.ref) throw new UpdateError('ref (a version tag) is required')
    return { job: needUpdate().startUpdate(body.ref, deps.busy()), supervised: supervised() }
  }, UpdateError), 'human')
  route('POST', '/api/system/update/rollback', () => as400(() => ({ to: needUpdate().rollback(deps.busy()), supervised: supervised() }), UpdateError), 'human')
  route('POST', '/api/system/restart', () => {
    const busy = deps.busy()
    if (busy) throw new HttpError(409, `cannot restart while ${busy}`)
    if (!restart()) throw new HttpError(409, 'not running under a supervisor: restart it yourself (or install the service: `sa service install`)')
    return { restarting: true }
  }, 'human')

  route('POST', '/api/system/presets/:id/apply', ({ params }) => as400(() => { const policy = applyPreset(store.home, params.id!); return { policy, presets: presetViews(store.home) } }, PresetError), 'human')
}
