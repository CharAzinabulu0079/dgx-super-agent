/** Working-tree change detection for one attempt (tracked + untracked, ignoring .gitignore). */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type TreeSnapshot = ReadonlyMap<string, string>

export function isGitRepo(root: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'pipe' })
    return true
  } catch (notRepo) {
    void notRepo
    return false
  }
}

/** Hash of every path that differs from HEAD (or every file when there is no commit). */
export function snapshotTree(root: string): TreeSnapshot {
  const map = new Map<string, string>()
  if (!isGitRepo(root)) return map
  const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  const entries = out.split('\0').filter(Boolean)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.startsWith('R') || status.startsWith('C')) i++ // skip rename source
    map.set(path, hashPath(join(root, path)))
  }
  return map
}

function hashPath(abs: string): string {
  if (!existsSync(abs)) return 'deleted'
  if (!statSync(abs).isFile()) return 'dir'
  return createHash('sha1').update(readFileSync(abs)).digest('hex')
}

/** Paths whose content differs between two snapshots. */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot, root: string): string[] {
  const changed = new Set<string>()
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.add(path)
  for (const [path, hash] of before) {
    // Dirty before, clean after: the attempt reverted it to HEAD.
    if (!after.has(path) && hash !== hashPath(join(root, path))) changed.add(path)
  }
  return [...changed].sort()
}
