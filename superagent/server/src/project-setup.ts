/**
 * Project onboarding helpers for the "just describe it" flow: sensible default gates
 * detected from the repository, and human registration of held-out test suites.
 *
 * Detection only *proposes* gates at project creation time — a human action — so the
 * Gate Registry rule (agents never define gate commands) is unchanged.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseGateSpec, type GateSpec, type Project } from '@superagent/contracts'
import type { StateStore } from '@superagent/project-state'

const NPM_PLACEHOLDER = /no test specified/

function hasTestFiles(dir: string, depth = 0): boolean {
  if (!existsSync(dir) || depth > 4) return false
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (hasTestFiles(p, depth + 1)) return true }
    else if (/\.test\.(m?[jt]s)$/.test(name)) return true
  }
  return false
}

/**
 * Propose gates for a repository: unit tests (npm/node:test/pytest), Playwright E2E,
 * and the architecture drift gate. Unknown stacks get only the architecture gate —
 * which alone cannot PASS a task that should have tests, so the UI asks for one.
 */
export function detectGates(root: string): GateSpec[] {
  const gates: GateSpec[] = []
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    let scripts: Record<string, string> = {}
    try {
      scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch (badJson) {
      void badJson
    }
    const t = scripts.test
    if (t && !NPM_PLACEHOLDER.test(t) && !/playwright/.test(t)) {
      gates.push(parseGateSpec({ id: 'unit', kind: 'command', command: 'npm test --silent', parser: /node --test/.test(t) ? 'node-test' : undefined, timeoutMs: 600_000 }))
    } else if (hasTestFiles(join(root, 'test')) || hasTestFiles(join(root, 'tests')) || hasTestFiles(join(root, 'src'))) {
      gates.push(parseGateSpec({ id: 'unit', kind: 'command', command: 'node --test', parser: 'node-test', timeoutMs: 600_000 }))
    }
    if (readdirSync(root).some(n => /^playwright\.config\.(m?[jt]s)$/.test(n))) {
      gates.push(parseGateSpec({ id: 'e2e', kind: 'e2e', command: 'npx playwright test --reporter=json', parser: 'playwright-json', timeoutMs: 600_000 }))
    }
  } else if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini')) || existsSync(join(root, 'tests'))) {
    gates.push(parseGateSpec({ id: 'unit', kind: 'command', command: 'python3 -m pytest -q', timeoutMs: 600_000 }))
  }
  gates.push(parseGateSpec({ id: 'architecture', kind: 'architecture-drift' }))
  return gates
}

export interface HeldOutInput {
  readonly gateId: string
  /** Directory or file with the hidden tests (copied into the store; the original can be deleted). */
  readonly from: string
  /** Project-relative directory the tests are mounted at during verification. */
  readonly mountAt: string
  /** Command that runs them, e.g. `node --test acceptance/*.test.js`. */
  readonly command: string
  readonly parser?: GateSpec['parser']
  readonly minTests?: number
}

/**
 * Human action: copy a hidden test suite into `$SUPERAGENT_HOME/heldout/<project>/<gate>`
 * and register it as a required held-out gate on the project (defaults + registry).
 */
export function registerHeldOut(store: StateStore, projectId: string, input: HeldOutInput): Project {
  const project = store.requireProject(projectId)
  if (!/^[\w.-]+$/.test(input.gateId)) throw new Error(`invalid gate id ${input.gateId}`)
  const from = resolve(input.from)
  if (!existsSync(from)) throw new Error(`held-out source not found: ${from}`)
  if (from === project.root || from.startsWith(`${project.root}/`)) {
    // Inside the worktree the Worker could read it; insist it lives elsewhere.
    throw new Error('held-out tests must not live inside the project (the Worker could read them); keep them elsewhere and pass that path')
  }
  const source = join(project.id, input.gateId)
  const dest = join(store.home, 'heldout', source)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, '..'), { recursive: true, mode: 0o700 })
  // Always stored as a directory, mounted as the directory `mountAt`.
  if (statSync(from).isDirectory()) cpSync(from, dest, { recursive: true })
  else { mkdirSync(dest, { recursive: true }); cpSync(from, join(dest, basename(from))) }
  const gate = parseGateSpec({
    id: input.gateId, kind: 'command', command: input.command, required: true,
    parser: input.parser ?? (/node --test/.test(input.command) ? 'node-test' : /playwright/.test(input.command) ? 'playwright-json' : undefined),
    minTests: input.minTests, timeoutMs: 600_000,
    heldOut: { source, mountAt: input.mountAt },
  })
  const without = <T extends { id: string }>(list: readonly T[] | undefined): T[] => (list ?? []).filter(g => g.id !== gate.id)
  return store.updateProject(project.id, { defaultGates: [...without(project.defaultGates), gate], gateRegistry: without(project.gateRegistry) })
}
