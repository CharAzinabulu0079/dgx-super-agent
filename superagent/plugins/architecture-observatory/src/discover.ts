/**
 * Deterministic module discovery (Freeze §7.2 priorities 1, 6): package
 * manifests / workspace globs first, then declared globs, then directories.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import yaml from 'js-yaml'
import picomatch from 'picomatch'
import type { DeclaredArchitecture, ModuleInfo } from './schema.ts'

export const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/
export const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)tests?\/|__tests__)/
const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/lib/**', '**/build/**', '**/coverage/**', '.architecture/**', '**/*.d.ts']

export interface PackageManifest {
  readonly dir: string
  readonly name?: string
  readonly json: Record<string, any>
}

export function readJson(file: string): Record<string, any> | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
  } catch (invalid) {
    void invalid
    return undefined
  }
}

/** Expand simple workspace globs (`a/*`, `a/*\/b`, literal) into directories with a package.json. */
export function expandWorkspaceGlob(root: string, pattern: string): string[] {
  const segments = pattern.replace(/\/+$/, '').split('/')
  let dirs = ['']
  for (const seg of segments) {
    const next: string[] = []
    for (const d of dirs) {
      if (seg === '*' || seg === '**') {
        const abs = join(root, d)
        if (!existsSync(abs)) continue
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) next.push(d ? `${d}/${entry.name}` : entry.name)
        }
      } else next.push(d ? `${d}/${seg}` : seg)
    }
    dirs = next
  }
  return dirs.filter(d => existsSync(join(root, d, 'package.json')))
}

export function workspacePatterns(root: string): string[] {
  const patterns: string[] = []
  const pkg = readJson(join(root, 'package.json'))
  const ws = pkg?.workspaces
  if (Array.isArray(ws)) patterns.push(...ws)
  else if (ws && Array.isArray(ws.packages)) patterns.push(...ws.packages)
  const pnpmFile = join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpmFile)) {
    const doc = yaml.load(readFileSync(pnpmFile, 'utf8')) as { packages?: string[] } | undefined
    patterns.push(...(doc?.packages ?? []))
  }
  return patterns.filter(p => !p.startsWith('!'))
}

export function discoverManifests(root: string): PackageManifest[] {
  const seen = new Set<string>()
  const out: PackageManifest[] = []
  for (const pattern of workspacePatterns(root)) {
    for (const dir of expandWorkspaceGlob(root, pattern)) {
      if (seen.has(dir)) continue
      seen.add(dir)
      const json = readJson(join(root, dir, 'package.json'))!
      out.push({ dir, name: json.name, json })
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

/** Files git would track (tracked + untracked-not-ignored), else a filesystem walk. */
export function listProjectFiles(root: string, ignore: readonly string[] = []): string[] {
  const isIgnored = picomatch([...DEFAULT_IGNORE, ...ignore], { dot: true })
  let files: string[]
  try {
    files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
      .toString('utf8').split('\0').filter(Boolean)
  } catch (notGit) {
    void notGit
    files = walk(root, root)
  }
  return files.filter(f => !isIgnored(f) && existsSync(join(root, f))).sort()
}

function walk(root: string, dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(root, abs))
    else out.push(relative(root, abs))
  }
  return out
}

const shortName = (name: string): string => name.replace(/^@[^/]+\//, '')

export interface ModuleResolver {
  readonly modules: ModuleInfo[]
  /** Module id owning a project-relative file, if any. */
  moduleOf(file: string): string | undefined
  /** Module id for a bare import specifier naming a workspace package. */
  moduleOfPackage(specifier: string): string | undefined
}

/**
 * Build modules and a file→module resolver.
 * Declared modules (glob paths) take precedence over manifest packages, which
 * take precedence over top-level directories.
 */
export function buildModules(root: string, files: readonly string[], declared: DeclaredArchitecture): ModuleResolver {
  const manifests = discoverManifests(root)
  type Draft = { id: string; source: ModuleInfo['source']; root: string; paths: string[]; packageName?: string; match: (f: string) => boolean; json?: Record<string, any> }
  const drafts: Draft[] = []
  const ids = new Set<string>()
  const uniqueId = (base: string, full: string): string => (ids.has(base) ? full : base)

  for (const d of declared.modules ?? []) {
    const isMatch = picomatch([...d.paths], { dot: true })
    const firstRoot = d.paths[0]?.replace(/\/?\*.*$/, '') ?? ''
    const manifest = manifests.find(m => m.dir === firstRoot)
    drafts.push({ id: d.id, source: 'declared', root: firstRoot, paths: [...d.paths], packageName: manifest?.name, match: isMatch, json: manifest?.json })
    ids.add(d.id)
  }
  for (const m of manifests) {
    if (drafts.some(d => d.root === m.dir)) continue
    const id = uniqueId(shortName(m.name ?? m.dir.split('/').pop()!), m.name ?? m.dir)
    ids.add(id)
    const prefix = `${m.dir}/`
    drafts.push({ id, source: 'manifest', root: m.dir, paths: [`${m.dir}/**`], packageName: m.name, match: f => f.startsWith(prefix), json: m.json })
  }
  if (!manifests.length && !(declared.modules ?? []).length) {
    // Directory fallback: src/<dir> when src/ exists, else top-level dirs with source files.
    const base = files.some(f => f.startsWith('src/')) ? 'src' : ''
    const dirs = new Set<string>()
    for (const f of files) {
      if (!SOURCE_EXT.test(f)) continue
      const rest = base ? f.slice(base.length + 1) : f
      if (!f.startsWith(base)) continue
      const top = rest.includes('/') ? rest.split('/')[0]! : (base || '(root)')
      dirs.add(top)
    }
    for (const top of [...dirs].sort()) {
      const dir = top === '(root)' || top === base ? base : base ? `${base}/${top}` : top
      const id = top === base ? base || 'root' : top
      ids.add(id)
      const prefix = dir ? `${dir}/` : ''
      drafts.push({
        id, source: 'directory', root: dir, paths: [dir ? `${dir}/**` : '*'],
        match: f => (dir === base && top === base) ? (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) : f.startsWith(prefix),
      })
    }
  }
  // Longer roots first so nested packages win over their parents.
  const ordered = [...drafts].sort((a, b) => (a.source === 'declared' ? -1 : 0) - (b.source === 'declared' ? -1 : 0) || b.root.length - a.root.length)
  const cache = new Map<string, string | undefined>()
  const moduleOf = (file: string): string | undefined => {
    if (!cache.has(file)) cache.set(file, ordered.find(d => d.match(file))?.id)
    return cache.get(file)
  }
  const byPackage = new Map(drafts.filter(d => d.packageName).map(d => [d.packageName!, d.id]))
  const moduleOfPackage = (specifier: string): string | undefined => {
    for (const [name, id] of byPackage) if (specifier === name || specifier.startsWith(`${name}/`)) return id
    return undefined
  }

  const declaredById = new Map((declared.modules ?? []).map(d => [d.id, d]))
  const modules: ModuleInfo[] = drafts.map(d => {
    const own = files.filter(f => moduleOf(f) === d.id)
    const decl = declaredById.get(d.id)
    return {
      id: d.id,
      source: d.source,
      root: d.root,
      paths: d.paths,
      packageName: d.packageName,
      layer: decl?.layer,
      description: decl?.description ?? d.json?.description,
      protected: decl?.protected === true,
      declared: decl !== undefined,
      files: own.length,
      gates: [...(decl?.gates ?? [])],
      adrs: [...(decl?.adrs ?? [])],
      tests: own.filter(f => TEST_FILE.test(f)),
      entry: entryOf(root, d.root, d.json, own),
      externalDeps: [],
    }
  })
  return { modules, moduleOf, moduleOfPackage }
}

function entryOf(root: string, dir: string, json: Record<string, any> | undefined, files: readonly string[]): string | undefined {
  const prefix = dir ? `${dir}/` : ''
  const exp = json?.exports
  const candidates: unknown[] = [
    typeof exp === 'string' ? exp : exp?.['.']?.default ?? exp?.['.']?.import ?? (typeof exp?.['.'] === 'string' ? exp['.'] : undefined),
    json?.module, json?.main,
  ]
  for (const c of candidates) {
    if (typeof c !== 'string') continue
    const rel = `${prefix}${c.replace(/^\.\//, '')}`
    if (existsSync(join(root, rel)) && statSync(join(root, rel)).isFile()) return rel
  }
  return files.find(f => /(^|\/)(src\/)?index\.(ts|tsx|js|mjs)$/.test(f.slice(prefix.length)))
}
