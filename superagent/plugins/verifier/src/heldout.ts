/**
 * Held-out verification (Cloud v1.0): tests the Worker never sees.
 *
 * A held-out gate's tests live under `$SUPERAGENT_HOME/heldout/<source>` — outside
 * the project, inside the path the pre-tool guard forbids. At verification time the
 * Worker's final tree is exported (git snapshot, so uncommitted and untracked files
 * count) into a throwaway directory, the held-out files are copied in at `mountAt`,
 * the project's ignored environment roots are linked read-only-by-convention, and
 * the gate command runs there. Nothing is written into the Worker's worktree, so the
 * tests cannot leak through it, and semantic gaming ("detect the known test and
 * special-case it") has nothing to aim at.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type { GateResult, GateSpec } from '@superagent/contracts'
import { runCommandGate } from './command.ts'
import { isGitWorkTree, snapshotCommit } from './integrity.ts'

export const HELD_OUT_ENV_ROOTS = ['node_modules', '.venv', 'venv']

export class HeldOutError extends Error {}

/** Resolve a held-out source inside `root`; rejects escapes and missing sources. */
export function resolveHeldOutSource(root: string, source: string): string {
  const abs = resolve(root, source)
  const rel = relative(resolve(root), abs)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new HeldOutError(`held-out source escapes ${root}: ${source}`)
  if (!existsSync(abs)) throw new HeldOutError(`held-out source missing: ${source}`)
  return abs
}

/**
 * Build a verification copy of `projectRoot` with the held-out files mounted.
 * @returns the copy's path and a disposer.
 */
export function prepareHeldOutTree(projectRoot: string, spec: GateSpec, heldOutRoot: string, ref: string): { dir: string; dispose: () => void } {
  if (!spec.heldOut) throw new HeldOutError(`gate ${spec.id} is not held-out`)
  const source = resolveHeldOutSource(heldOutRoot, spec.heldOut.source)
  const dir = mkdtempSync(join(tmpdir(), 'sa-heldout-'))
  let pinned = false
  const dispose = (): void => {
    rmSync(dir, { recursive: true, force: true })
    if (pinned) {
      try {
        execFileSync('git', ['update-ref', '-d', `refs/superagent/${ref}`], { cwd: projectRoot, stdio: 'ignore' })
      } catch (alreadyGone) {
        void alreadyGone
      }
    }
  }
  try {
    if (isGitWorkTree(projectRoot)) {
      const commit = snapshotCommit(projectRoot, ref)
      pinned = true
      const tar = execFileSync('git', ['archive', '--format=tar', commit], { cwd: projectRoot, maxBuffer: 1024 * 1024 * 1024 })
      execFileSync('tar', ['-x', '-C', dir], { input: tar })
    } else {
      cpSync(projectRoot, dir, { recursive: true, filter: src => !HELD_OUT_ENV_ROOTS.some(e => src === join(projectRoot, e)) && !src.startsWith(join(projectRoot, '.git')) })
    }
    for (const env of HELD_OUT_ENV_ROOTS) {
      const from = join(projectRoot, env)
      if (existsSync(from) && !existsSync(join(dir, env))) symlinkSync(from, join(dir, env), 'dir')
    }
    // Held-out files win over anything the Worker put at the same path.
    const target = resolve(dir, spec.heldOut.mountAt)
    if (!target.startsWith(dir + sep)) throw new HeldOutError(`mountAt escapes the verification tree: ${spec.heldOut.mountAt}`)
    // The exported tree is Worker-controlled: a symlinked path component would carry the
    // hidden tests somewhere the next attempt can read. Refuse any link on the way down.
    const realDir = realpathSync(dir)
    let walk = dir
    for (const part of relative(dir, target).split(sep)) {
      walk = join(walk, part)
      if (existsSync(walk) || isLink(walk)) {
        if (lstatSync(walk).isSymbolicLink()) throw new HeldOutError(`the Worker tree has a symlink at ${relative(dir, walk)}; refusing to mount held-out tests through it`)
        if (!realpathSync(walk).startsWith(realDir + sep)) throw new HeldOutError(`mount path leaves the verification tree`)
      }
    }
    if (statSync(source).isDirectory()) {
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      cpSync(source, target, { recursive: true })
    } else {
      mkdirSync(resolve(target, '..'), { recursive: true })
      cpSync(source, target)
    }
    return { dir, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

/** Run a command/e2e gate against a verification copy carrying the held-out tests. */
export async function runHeldOutGate(spec: GateSpec, projectRoot: string, heldOutRoot: string | undefined, ref: string, signal?: AbortSignal): Promise<GateResult> {
  const base = { gateId: spec.id, kind: spec.kind, required: spec.required, heldOut: true }
  if (!heldOutRoot) return { ...base, status: 'error', durationMs: 0, summary: 'held-out gate but no held-out store configured', outputTail: '', failureSignature: `${spec.id}:heldout-unconfigured` }
  let tree: { dir: string; dispose: () => void }
  try {
    tree = prepareHeldOutTree(projectRoot, spec, heldOutRoot, ref)
  } catch (error) {
    return { ...base, status: 'error', durationMs: 0, summary: `held-out setup failed: ${(error as Error).message}`, outputTail: '', failureSignature: `${spec.id}:heldout-setup` }
  }
  try {
    const r = await runCommandGate(spec, tree.dir, signal)
    return { ...r, heldOut: true }
  } finally {
    tree.dispose()
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch (absent) {
    void absent
    return false
  }
}
