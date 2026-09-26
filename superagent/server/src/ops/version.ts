/** The running SuperAgent version (root package.json) and git commit, when available. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@superagent/testkit'

let cached: { appVersion?: string; commit?: string } | undefined

export function appVersion(root = REPO_ROOT): { appVersion?: string; commit?: string } {
  if (cached && root === REPO_ROOT) return cached
  let v: string | undefined
  let commit: string | undefined
  try { v = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version } catch (absent) { void absent }
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch (notGit) { void notGit }
  const out = { appVersion: v, commit }
  if (root === REPO_ROOT) cached = out
  return out
}
