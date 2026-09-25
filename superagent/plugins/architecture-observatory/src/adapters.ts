/**
 * Language adapter seam (Directive §4.G). An adapter turns source files into file-level
 * dependencies; the Observatory aggregates them into module edges uniformly. JS/TS uses
 * dependency-cruiser; Python is a small static import scanner that proves the seam.
 * Add a language by implementing `LanguageAdapter` (e.g. a Tree-sitter adapter).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { cruise } from 'dependency-cruiser'

export interface FileDependency {
  /** Project-relative importing file. */
  readonly from: string
  /** Project-relative resolved target inside the project, if resolved. */
  readonly to?: string
  /** Raw import specifier (package name for externals). */
  readonly specifier: string
  readonly typeOnly: boolean
  /** Builtin/stdlib module (ignored for externals). */
  readonly builtin: boolean
  /** File-level cycle reported by the adapter, if any. */
  readonly cycle?: readonly string[]
}

export interface LanguageAdapter {
  readonly id: string
  readonly files: RegExp
  collect(root: string, files: readonly string[]): Promise<FileDependency[]>
}

type CruiseDep = { resolved: string; module: string; couldNotResolve: boolean; coreModule: boolean; dependencyTypes: string[]; circular?: boolean; cycle?: Array<{ name: string } | string> }

export const jsTsAdapter: LanguageAdapter = {
  id: 'js-ts',
  files: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/,
  async collect(root, files) {
    if (!files.length) return []
    const result = await cruise([...files], {
      baseDir: root, doNotFollow: { path: 'node_modules' }, exclude: { path: '(^|/)node_modules/' },
      tsPreCompilationDeps: true, combinedDependencies: true, validate: false, skipAnalysisNotInRules: false,
    } as never, {}, {})
    const out: FileDependency[] = []
    for (const m of (result.output as unknown as { modules: Array<{ source: string; dependencies: CruiseDep[] }> }).modules) {
      for (const d of m.dependencies) {
        const inside = !d.couldNotResolve && !d.coreModule && !d.resolved.includes('node_modules/') && !d.resolved.startsWith('/')
        out.push({
          from: m.source, to: inside ? d.resolved : undefined, specifier: d.module,
          typeOnly: d.dependencyTypes.includes('type-only'), builtin: d.coreModule || d.module.startsWith('node:'),
          cycle: d.circular && Array.isArray(d.cycle) ? [m.source, ...d.cycle.map(c => (typeof c === 'string' ? c : c.name))] : undefined,
        })
      }
    }
    return out
  },
}

const PY_STDLIB = new Set(['os', 'sys', 're', 'json', 'time', 'datetime', 'math', 'random', 'typing', 'pathlib', 'subprocess', 'collections', 'itertools', 'functools', 'dataclasses', 'logging', 'unittest', 'asyncio', 'abc', 'enum', 'io', 'shutil', 'tempfile', 'argparse', 'hashlib', 'base64', 'copy', 'uuid', 'threading', 'socket', 'http', 'urllib', 'string', 'textwrap', 'contextlib', 'inspect', 'traceback', 'warnings', 'pickle', 'csv', 'glob', 'statistics', 'decimal', 'fractions', 'queue', 'signal', 'struct', 'zlib', 'gzip', '__future__'])

/** Static Python import scanner: `import a.b`, `from a.b import c`, `from . import x`. */
export const pythonAdapter: LanguageAdapter = {
  id: 'python',
  files: /\.py$/,
  async collect(root, files) {
    const known = new Set(files)
    const roots = ['', 'src/']
    const resolveAbs = (dotted: string): string | undefined => {
      const path = dotted.replace(/\./g, '/')
      for (const r of roots) {
        for (const cand of [`${r}${path}.py`, `${r}${path}/__init__.py`]) if (known.has(cand)) return cand
      }
      return undefined
    }
    const out: FileDependency[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(join(root, file), 'utf8')
      } catch (unreadable) {
        void unreadable
        continue
      }
      for (const line of text.split('\n')) {
        const from = /^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w*, ()]+)/.exec(line)
        const imp = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(line)
        const targets: Array<{ spec: string; to?: string }> = []
        if (from) {
          const dots = from[1]!.length
          const mod = from[2]!
          if (dots > 0) {
            let base = dirname(file)
            for (let i = 1; i < dots; i++) base = dirname(base)
            const rel = normalize(join(base === '.' ? '' : base, mod.replace(/\./g, '/')))
            const names = mod ? [rel] : from[3]!.split(',').map(n => normalize(join(base === '.' ? '' : base, n.trim().replace(/[()]/g, ''))))
            for (const n of names) targets.push({ spec: `${'.'.repeat(dots)}${mod}`, to: [`${n}.py`, `${n}/__init__.py`].find(c => known.has(c)) })
          } else targets.push({ spec: mod, to: resolveAbs(mod) })
        } else if (imp) {
          for (const m of imp[1]!.split(',')) targets.push({ spec: m.trim(), to: resolveAbs(m.trim()) })
        }
        for (const t of targets) {
          out.push({ from: file, to: t.to, specifier: t.spec.split('.')[0] || t.spec, typeOnly: false, builtin: PY_STDLIB.has(t.spec.split('.')[0]!) })
        }
      }
    }
    return out
  },
}

export const DEFAULT_ADAPTERS: readonly LanguageAdapter[] = [jsTsAdapter, pythonAdapter]

export function hasFile(root: string, rel: string): boolean {
  return existsSync(join(root, rel))
}
