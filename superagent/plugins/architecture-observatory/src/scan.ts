/**
 * Static scan: dependency-cruiser (JS/TS import graph) aggregated to module
 * edges, TypeScript AST for exported interfaces, manifests for services.
 * No LLM involved (Freeze §7.2).
 */
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import ts from 'typescript'
import { buildModules, listProjectFiles, readJson, SOURCE_EXT, TEST_FILE, type ModuleResolver } from './discover.ts'
import { DEFAULT_ADAPTERS, type FileDependency, type LanguageAdapter } from './adapters.ts'
import type { DeclaredArchitecture, InterfaceInfo, ModuleEdge, ModuleInfo, ServiceInfo } from './schema.ts'

export interface ScanResult {
  readonly files: readonly string[]
  readonly modules: readonly ModuleInfo[]
  readonly edges: readonly ModuleEdge[]
  /** File-level cycles reported by dependency-cruiser (each a list of files). */
  readonly fileCycles: ReadonlyArray<readonly string[]>
  readonly interfaces: readonly InterfaceInfo[]
  readonly services: readonly ServiceInfo[]
  readonly resolver: ModuleResolver
  readonly scanMs: number
}

export async function scanProject(root: string, declared: DeclaredArchitecture, adapters: readonly LanguageAdapter[] = DEFAULT_ADAPTERS): Promise<ScanResult> {
  const started = Date.now()
  const files = listProjectFiles(root, declared.ignore ?? [])
  const resolver = buildModules(root, files, declared)
  const deps: FileDependency[] = []
  for (const adapter of adapters) deps.push(...await adapter.collect(root, files.filter(f => adapter.files.test(f))))

  const edgeMap = new Map<string, { weight: number; typeOnly: boolean; testOnly: boolean; evidence: string[] }>()
  const external = new Map<string, Set<string>>()
  const fileCycles: string[][] = []
  const cycleKeys = new Set<string>()
  for (const dep of deps) {
    const from = resolver.moduleOf(dep.from)
    if (!from) continue
    const spec = dep.specifier
    let to = dep.to ? resolver.moduleOf(dep.to) : undefined
    if (!to && !spec.startsWith('.')) to = resolver.moduleOfPackage(spec)
    if (!to) {
      if (!dep.to && !spec.startsWith('.') && !dep.builtin && !isBuiltin(spec)) {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
        if (!external.has(from)) external.set(from, new Set())
        external.get(from)!.add(pkg)
      }
      continue
    }
    if (dep.cycle) {
      const key = [...new Set(dep.cycle)].sort().join('|')
      if (!cycleKeys.has(key)) { cycleKeys.add(key); fileCycles.push([...dep.cycle]) }
    }
    if (to === from) continue
    const key = `${from}\u0000${to}`
    const e = edgeMap.get(key) ?? { weight: 0, typeOnly: true, testOnly: true, evidence: [] }
    e.weight++
    if (!TEST_FILE.test(dep.from)) e.testOnly = false
    if (!dep.typeOnly) e.typeOnly = false
    if (e.evidence.length < 5) e.evidence.push(`${dep.from} → ${dep.to ?? spec}`)
    edgeMap.set(key, e)
  }
  const edges: ModuleEdge[] = [...edgeMap].map(([key, e]) => {
    const [from, to] = key.split('\u0000') as [string, string]
    return { from, to, weight: e.weight, typeOnly: e.typeOnly, testOnly: e.testOnly, evidence: e.evidence }
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const modules = resolver.modules.map(m => ({ ...m, externalDeps: [...(external.get(m.id) ?? [])].sort() }))
  return {
    files, modules, edges, fileCycles,
    interfaces: modules.filter(m => m.entry).map(m => ({ module: m.id, entry: m.entry!, exports: exportsOf(root, m.entry!) })),
    services: detectServices(root, modules, files, resolver),
    resolver,
    scanMs: Date.now() - started,
  }
}

/** Exported names of an entry file, following `export * from './x'` within the project (depth 4). */
export function exportsOf(root: string, file: string, depth = 0, seen = new Set<string>()): string[] {
  if (depth > 4 || seen.has(file)) return []
  seen.add(file)
  let text: string
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch (unreadable) {
    void unreadable
    return []
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  const names = new Set<string>()
  const hasExport = (n: ts.Node): boolean => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) for (const el of stmt.exportClause.elements) names.add(el.name.text)
      else if (!stmt.exportClause && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text.startsWith('.')) {
        const target = join(file, '..', stmt.moduleSpecifier.text).replace(/\.js$/, '.ts')
        for (const n of exportsOf(root, target, depth + 1, seen)) names.add(n)
      }
    } else if (hasExport(stmt)) {
      if (ts.isVariableStatement(stmt)) for (const d of stmt.declarationList.declarations) { if (ts.isIdentifier(d.name)) names.add(d.name.text) }
      else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name) names.add(stmt.name.text)
    } else if (ts.isExportAssignment(stmt)) names.add('default')
  }
  return [...names].sort()
}

function detectServices(root: string, modules: readonly ModuleInfo[], files: readonly string[], resolver: ModuleResolver): ServiceInfo[] {
  const out: ServiceInfo[] = []
  for (const m of modules) {
    const pkg = readJson(join(root, m.root, 'package.json'))
    if (!pkg) continue
    const bin = typeof pkg.bin === 'string' ? { [m.id]: pkg.bin } : (pkg.bin ?? {})
    for (const [name, path] of Object.entries(bin)) out.push({ id: `${m.id}:bin:${name}`, module: m.id, kind: 'bin', detail: String(path) })
    for (const s of ['start', 'serve', 'dev']) if (pkg.scripts?.[s]) out.push({ id: `${m.id}:script:${s}`, module: m.id, kind: 'script', detail: pkg.scripts[s] })
    if (pkg.dsh?.bundle) out.push({ id: `${m.id}:dsh-bundle`, module: m.id, kind: 'dsh-bundle', detail: String(pkg.dsh.bundle.patch ?? '') })
  }
  for (const f of files) {
    if (!SOURCE_EXT.test(f) || /\.(test|spec)\./.test(f)) continue
    let text: string
    try {
      text = readFileSync(join(root, f), 'utf8')
    } catch (unreadable) {
      void unreadable
      continue
    }
    if (/\bcreateServer\(/.test(text) && /\.listen\(/.test(text)) {
      const mod = resolver.moduleOf(f)
      if (mod) out.push({ id: `${mod}:http:${f}`, module: mod, kind: 'http-server', detail: f })
    }
  }
  return out
}
