/**
 * DSH profile setup for SuperAgent (idempotent). Uses only DSH's supported
 * extension path: named profiles from shipped templates + `dsh plugin add`.
 *
 *   superagent-worker  (from `headless`)  SuperAgent bundle + Playwright MCP browser provider
 *   superagent-chief   (from `web`)       SuperAgent bundle (Chief talks to the user in DSH Web)
 *
 * Both profiles disable DSH's default remote OTLP telemetry (private DGX deployment).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshBin, REPO_ROOT } from '@superagent/testkit'

export const WORKER_PROFILE = 'superagent-worker'
export const CHIEF_PROFILE = 'superagent-chief'
export const BUNDLE_DIR = join(REPO_ROOT, 'superagent', 'dsh-bundle')
export const BROWSER_PATCH = join(BUNDLE_DIR, 'patches', 'worker-browser.yml')
const DSH_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'upstream', 'dsh.lock.json'), 'utf8')).npm.version as string
const BROWSER_PACKAGES = [`@deepseek-ai/dsh-browser-use@${DSH_VERSION}`, `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@${DSH_VERSION}`]
const MARKER = '# superagent:managed'

const PROFILE_PATCH = `${MARKER}
# Private deployment: no remote telemetry export (DSH default posts OTLP logs to deepseeksvc.com).
- id: session-telemetry-otel
  disabled: true
`

export interface SetupResult {
  readonly dshHome: string
  readonly profiles: Record<string, { created: boolean; bundleLinked: boolean; browser: boolean }>
}

function dsh(dshHome: string, args: string[], cwd = REPO_ROOT): string {
  return execFileSync(dshBin(), args, { cwd, env: { ...process.env, DSH_HOME: dshHome, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }).toString('utf8')
}

/** Build the bundle if its compiled entry is missing or older than its source. */
export function ensureBundleBuilt(): void {
  const lib = join(BUNDLE_DIR, 'lib', 'index.js')
  const src = join(BUNDLE_DIR, 'src', 'index.ts')
  if (!existsSync(lib) || statSync(lib).mtimeMs < statSync(src).mtimeMs) {
    execFileSync(process.execPath, ['build.mjs'], { cwd: BUNDLE_DIR, stdio: 'pipe' })
  }
}

function ensureProfile(dshHome: string, name: string, template: string, withBrowser: boolean): SetupResult['profiles'][string] {
  const dir = join(dshHome, 'profiles', name)
  let created = false
  if (!existsSync(join(dir, 'package.json'))) {
    dsh(dshHome, ['--profile', name, '--from-default-profile', template, '--help'])
    created = true
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const deps = manifest.dependencies ?? {}
  const wanted: string[] = []
  if (!deps['@superagent/dsh-bundle']) wanted.push(BUNDLE_DIR)
  if (withBrowser) for (const spec of BROWSER_PACKAGES) if (!deps[spec.slice(0, spec.lastIndexOf('@'))]) wanted.push(spec)
  if (wanted.length) dsh(dshHome, ['plugin', '--profile', name, 'add', ...wanted])
  const patchFile = join(dir, 'cordis.patch.yml')
  const current = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  if (!current.includes(MARKER)) {
    // The template holds comments plus an empty flow list `[]`; drop that placeholder so the
    // appended block sequence stays one valid YAML list.
    const kept = current.split('\n').filter(line => line.trim() !== '[]').join('\n').trimEnd()
    const body = kept ? `${kept}\n` : ''
    writeFileSync(patchFile, `${body}${PROFILE_PATCH}`)
  }
  return { created, bundleLinked: true, browser: withBrowser }
}

/**
 * Create/refresh the SuperAgent DSH profiles under `dshHome`.
 * @param options.chief - also set up the Chief (web) profile (default true).
 */
export function setupDshProfiles(dshHome: string, options: { chief?: boolean } = {}): SetupResult {
  ensureBundleBuilt()
  const profiles: SetupResult['profiles'] = {}
  profiles[WORKER_PROFILE] = ensureProfile(dshHome, WORKER_PROFILE, 'headless', true)
  if (options.chief !== false) profiles[CHIEF_PROFILE] = ensureProfile(dshHome, CHIEF_PROFILE, 'web', false)
  return { dshHome, profiles }
}

export function workerProfileReady(dshHome: string): boolean {
  return existsSync(join(dshHome, 'profiles', WORKER_PROFILE, 'package.json'))
}
