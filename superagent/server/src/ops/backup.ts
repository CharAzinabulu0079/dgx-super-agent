/**
 * Backup / Restore of SuperAgent state (`$SUPERAGENT_HOME`).
 *
 * A backup is `backups/<id>.tar.gz` with a `manifest.json`. Included: projects (records,
 * events, shared files), learning, skills, hidden tests, policies, presets, appearance.
 * Excluded by default: secrets (agent token, provider keys — `model-routes.json` is kept
 * with its `env` values removed) and DSH sessions; never: runtime logs, leases, backups.
 *
 * Restore first takes an automatic `pre-restore` backup, extracts to a staging directory,
 * validates the manifest (a backup from a newer state format is refused), then swaps
 * directories; the replaced state is kept under `.restore-old-<time>/` until Cleanup.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_SCHEMA_VERSION } from '@superagent/project-state'

export class BackupError extends Error {}

export interface BackupManifest {
  readonly format: 'superagent-backup'
  readonly formatVersion: 1
  readonly schema: number
  readonly createdAt: string
  readonly label: string
  readonly appVersion?: string
  readonly commit?: string
  readonly includes: { readonly secrets: boolean; readonly sessions: boolean }
  readonly projects: string[]
}

export interface BackupInfo { readonly id: string; readonly size: number; readonly manifest: BackupManifest }

/** Never part of a backup (process-local or derived). */
const ALWAYS_EXCLUDED = new Set(['backups', 'runtime', 'state-version.json.tmp'])
const SECRET_ITEMS = new Set(['secrets'])
const SESSION_ITEMS = new Set(['dsh-home'])
const ID = /^[\w.-]+$/

const backupsDir = (home: string) => join(home, 'backups')
export const backupFile = (home: string, id: string): string => {
  if (!ID.test(id)) throw new BackupError('invalid backup id')
  return join(backupsDir(home), `${id}.tar.gz`)
}

function readManifestFrom(file: string): BackupManifest {
  let text: string
  try {
    text = execFileSync('tar', ['-xzOf', file, './manifest.json'], { maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')
  } catch (notABackup) {
    void notABackup
    throw new BackupError('not a SuperAgent backup (no manifest)')
  }
  const m = JSON.parse(text) as BackupManifest
  if (m.format !== 'superagent-backup' || m.formatVersion !== 1) throw new BackupError('unknown backup format')
  return m
}

export function createBackup(home: string, opts: { label?: string; includeSecrets?: boolean; includeSessions?: boolean; appVersion?: string; commit?: string } = {}): BackupInfo {
  mkdirSync(backupsDir(home), { recursive: true, mode: 0o700 })
  const label = (opts.label ?? 'manual').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'manual'
  const id = `sa-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')}-${label}`
  const items = readdirSync(home).filter(n =>
    !ALWAYS_EXCLUDED.has(n) && !n.startsWith('.') && n !== 'model-routes.json' &&
    (opts.includeSecrets || !SECRET_ITEMS.has(n)) && (opts.includeSessions || !SESSION_ITEMS.has(n)))
  const stage = mkdtempSync(join(home, '.backup-stage-'))
  try {
    const manifest: BackupManifest = {
      format: 'superagent-backup', formatVersion: 1, schema: STATE_SCHEMA_VERSION, createdAt: new Date().toISOString(), label,
      appVersion: opts.appVersion, commit: opts.commit,
      includes: { secrets: !!opts.includeSecrets, sessions: !!opts.includeSessions },
      projects: existsSync(join(home, 'projects')) ? readdirSync(join(home, 'projects')) : [],
    }
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const routes = join(home, 'model-routes.json')
    if (existsSync(routes)) {
      const r = JSON.parse(readFileSync(routes, 'utf8')) as { env?: Record<string, string> }
      // Without secrets: keep the provider layout, drop the key values.
      const out = opts.includeSecrets ? r : { ...r, env: Object.fromEntries(Object.keys(r.env ?? {}).map(k => [k, ''])) }
      writeFileSync(join(stage, 'model-routes.json'), JSON.stringify(out, null, 2), { mode: 0o600 })
    }
    const file = backupFile(home, id)
    const tmp = `${file}.partial`
    execFileSync('tar', [
      '-czf', tmp, '--exclude=leases', '--exclude=*.tmp', '--exclude=*.partial',
      '-C', stage, ...readdirSync(stage).map(n => `./${n}`),
      '-C', home, ...items.map(n => `./${n}`),
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    renameSync(tmp, file)
    return { id, size: statSync(file).size, manifest }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export function listBackups(home: string): BackupInfo[] {
  if (!existsSync(backupsDir(home))) return []
  return readdirSync(backupsDir(home)).filter(f => f.endsWith('.tar.gz')).flatMap(f => {
    const id = f.slice(0, -'.tar.gz'.length)
    try {
      return [{ id, size: statSync(join(backupsDir(home), f)).size, manifest: readManifestFrom(join(backupsDir(home), f)) }]
    } catch (unreadable) {
      void unreadable
      return []
    }
  }).sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
}

export function deleteBackup(home: string, id: string): void {
  const f = backupFile(home, id)
  if (!existsSync(f)) throw new BackupError(`backup ${id} not found`)
  rmSync(f)
}

/** Accept an uploaded archive (e.g. from another machine) after validating it. */
export function importBackup(home: string, data: Buffer): BackupInfo {
  mkdirSync(backupsDir(home), { recursive: true, mode: 0o700 })
  const tmp = join(backupsDir(home), `upload-${Date.now()}.partial`)
  writeFileSync(tmp, data)
  try {
    const m = readManifestFrom(tmp)
    const id = `sa-${m.createdAt.replace(/[:.]/g, '-').replace('Z', '')}-${m.label}-imported`
    renameSync(tmp, backupFile(home, id))
    return { id, size: data.length, manifest: m }
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export function restoreBackup(home: string, id: string, opts: { appVersion?: string; commit?: string } = {}): { restored: BackupManifest; preRestore: string; keptOldAt: string } {
  const file = backupFile(home, id)
  if (!existsSync(file)) throw new BackupError(`backup ${id} not found`)
  const manifest = readManifestFrom(file)
  if (manifest.schema > STATE_SCHEMA_VERSION) throw new BackupError(`backup uses state format ${manifest.schema}; this version understands up to ${STATE_SCHEMA_VERSION} — update SuperAgent first`)
  const pre = createBackup(home, { label: 'pre-restore', ...opts, includeSecrets: true, includeSessions: manifest.includes.sessions })
  const stage = mkdtempSync(join(home, '.restore-stage-'))
  const old = join(home, `.restore-old-${Date.now()}`)
  try {
    execFileSync('tar', ['-xzf', file, '-C', stage, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] })
    // Refuse archives that try to write outside the staging directory.
    const listing = execFileSync('tar', ['-tzf', file], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean)
    if (listing.some(p => p.startsWith('/') || p.split('/').includes('..'))) throw new BackupError('archive contains unsafe paths')
    if (!existsSync(join(stage, 'projects'))) throw new BackupError('archive has no projects directory')
    rmSync(join(stage, 'manifest.json'), { force: true })
    mkdirSync(old, { recursive: true })
    // Secrets and sessions not in the backup stay as they are.
    const keep = new Set<string>([...ALWAYS_EXCLUDED, ...(manifest.includes.secrets ? [] : [...SECRET_ITEMS, 'model-routes.json']), ...(manifest.includes.sessions ? [] : [...SESSION_ITEMS])])
    for (const n of readdirSync(stage)) {
      if (keep.has(n)) continue
      if (existsSync(join(home, n))) renameSync(join(home, n), join(old, n))
      renameSync(join(stage, n), join(home, n))
    }
    // Items the backup did not have (e.g. a project added later) move aside too.
    const inArchive = (n: string) => listing.some(p => p === `./${n}` || p === `./${n}/` || p.startsWith(`./${n}/`))
    for (const n of readdirSync(home)) {
      if (n.startsWith('.') || keep.has(n) || inArchive(n)) continue
      renameSync(join(home, n), join(old, n))
    }
    return { restored: manifest, preRestore: pre.id, keptOldAt: old }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
