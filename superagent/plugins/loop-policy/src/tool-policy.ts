/**
 * Pre-tool policy (Directive §4.B): decide, BEFORE a tool runs, whether a model's
 * tool call needs a human. Pure and deterministic so it can run inside DSH's
 * `ctx.tools.guard()` (SuperAgent bundle) and be unit-tested here.
 *
 * Layers around it: DSH's Landlock workspace sandbox (writes outside the project
 * denied), the Verifier's integrity check (post-hoc, fail closed), and the API's
 * human token (Human Gates cannot be resolved by a Worker even over HTTP).
 * Shell parsing here is conservative pattern matching, not a proof: it catches
 * the direct forms; obfuscation patterns are denied as a class.
 */
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import type { HumanGateReason } from '@superagent/contracts'

export interface ToolPolicy {
  /** `advisor` = planner/reviewer sessions: read tools only, never a Human Gate (nothing to approve). */
  readonly role: 'worker' | 'chief' | 'advisor'
  /** Project root (Worker cwd). Paths are judged relative to it. */
  readonly projectRoot?: string
  /** Globs (project-relative) of verification assets. */
  readonly verificationPaths: readonly string[]
  /** Globs (project-relative) of protected architecture modules. */
  readonly protectedModulePaths: readonly string[]
  /** Fingerprints a human approved for this task. */
  readonly approvedActions: readonly string[]
  /** Absolute paths the model must never read or write through tools (state, secrets). */
  readonly forbiddenPaths: readonly string[]
  /** SuperAgent API origins (e.g. http://127.0.0.1:7788) the model must not call directly. */
  readonly apiOrigins: readonly string[]
  /** Task policy flag (Freeze §11 `production_write`). */
  readonly productionWrite: boolean
  /** Temp roots writes may target (scratch space). */
  readonly tempRoots: readonly string[]
}

export type ToolDecision =
  | { readonly allow: true; readonly approved?: boolean }
  | { readonly allow: false; readonly category: HumanGateReason; readonly rule: string; readonly summary: string; readonly fingerprint: string }

/** Stable identity of one tool call: tool name + canonical JSON arguments (sans description). */
export function actionFingerprint(tool: string, args: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).filter(k => k !== 'description' && k !== 'justification').sort().map(k => [k, canon((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return createHash('sha256').update(`${tool}\u0000${JSON.stringify(canon(args))}`).digest('hex').slice(0, 32)
}

interface ShellRule { readonly re: RegExp; readonly category: HumanGateReason; readonly rule: string }

const SHELL_RULES: readonly ShellRule[] = [
  // irreversible data / history
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\.\.)(\s|\/?$|\/\*)/, category: 'irreversible-data', rule: 'recursive delete outside the project' },
  { re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)/, category: 'irreversible-data', rule: 'recursive delete' },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-zA-Z]*[fdx]|checkout\s+(--\s+)?\.\s*$|stash\s+(drop|clear)|branch\s+-D|update-ref|reflog\s+expire|gc\s+--prune|filter-branch|filter-repo)/, category: 'irreversible-data', rule: 'destructive git operation' },
  { re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;?\s*$)/i, category: 'irreversible-data', rule: 'destructive SQL' },
  { re: /\b(mkfs(\.\w+)?|shred|wipefs|dd\s+[^|]*of=\/dev\/)/, category: 'irreversible-data', rule: 'disk-level destruction' },
  // production / deployment / publication
  { re: /\b(kubectl\s+(apply|delete|replace|rollout|scale|patch|edit)|helm\s+(install|upgrade|uninstall|rollback)|terraform\s+(apply|destroy|import)|pulumi\s+(up|destroy)|docker\s+(push|login)|(npm|pnpm|yarn)\s+publish|cargo\s+publish|twine\s+upload|gh\s+(release|pr\s+merge|repo\s+(delete|edit))|fly(ctl)?\s+deploy|vercel\s+.*--prod|netlify\s+deploy\s+.*--prod|firebase\s+deploy|serverless\s+deploy|aws\s+\S+\s+(deploy|delete|put|create|update|terminate)|gcloud\s+\S+.*\s(deploy|delete|create|update)|az\s+\S+.*\s(deploy|delete|create|update))\b/, category: 'production-deploy', rule: 'production / publication command' },
  { re: /\b(ssh|scp|sftp)\s+|rsync\s+[^|]*\s[\w.-]+@?[\w.-]+:/, category: 'production-deploy', rule: 'remote host access' },
  // permission / credential expansion
  { re: /(^|[;&|]\s*|\s)(sudo|su|doas|pkexec)\s/, category: 'permission-expansion', rule: 'privilege escalation' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*7[0-7]{0,2}\b|\bchmod\s+[+ugo]*s\b|\bchown\b|\bsetfacl\b|\bpasswd\b|\busermod\b|\bvisudo\b/, category: 'permission-expansion', rule: 'permission change' },
  { re: /(~|\$HOME|\/home\/[^/\s]+|\/root)\/\.(ssh|aws|gnupg|kube|docker|netrc|git-credentials|config\/gh|npmrc|pypirc)\b/, category: 'permission-expansion', rule: 'credential store access' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b|\b(ba)?sh\s+<\(\s*(curl|wget)/, category: 'permission-expansion', rule: 'remote script execution' },
  { re: /base64\s+(-d|--decode)[^|]*\|\s*(ba|z)?sh\b|\beval\s+"?\$\(|\bpython3?\s+-c\s+.*(exec|eval)\(.*(b64decode|decode)|\bxxd\s+-r.*\|\s*(ba)?sh/, category: 'permission-expansion', rule: 'obfuscated execution' },
  { re: /\b(iptables|ufw|firewall-cmd|nft)\b|\b(nc|ncat|socat)\s+-l/, category: 'permission-expansion', rule: 'network exposure' },
]

/** Shell forms that write to a path, capturing the target. */
const SHELL_WRITES: readonly RegExp[] = [
  />{1,2}\s*([^\s;&|]+)/g,
  /\btee\s+(?:-a\s+)?([^\s;&|]+)/g,
  /\b(?:sed|perl)\s+(?:-[a-zA-Z]*i[a-zA-Z]*\S*\s+)(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;&|]+)/g,
  /\b(?:cp|mv|install|ln)\s+(?:-\S+\s+)*\S+\s+([^\s;&|]+)/g,
  /\b(?:rm|unlink|truncate(?:\s+-s\s+\S+)?)\s+(?:-\S+\s+)*([^\s;&|]+)/g,
  /\bgit\s+(?:checkout|restore)\s+(?:\S+\s+)?--\s+([^\s;&|]+)/g,
]

function relPath(policy: ToolPolicy, p: string): { rel: string; outside: boolean } {
  const root = policy.projectRoot ?? process.cwd()
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, abs)
  return { rel, outside: rel.startsWith('..') || isAbsolute(rel) }
}

function judgePath(policy: ToolPolicy, raw: string, write: boolean): { category: HumanGateReason; rule: string } | undefined {
  const p = raw.replace(/^['"]|['"]$/g, '')
  if (!p || p.startsWith('-') || p.startsWith('&') || p === '/dev/null' || /^\/dev\/(stdout|stderr|fd\/\d)$/.test(p)) return undefined
  const abs = isAbsolute(p) ? resolve(p) : resolve(policy.projectRoot ?? process.cwd(), p)
  for (const f of policy.forbiddenPaths) {
    if (abs === f || abs.startsWith(`${f}/`)) return { category: 'permission-expansion', rule: `SuperAgent state/secrets path (${f})` }
  }
  if (!write) return undefined
  const { rel, outside } = relPath(policy, p)
  if (outside) {
    if (policy.tempRoots.some(t => abs === t || abs.startsWith(`${t}/`))) return undefined
    return { category: 'permission-expansion', rule: 'write outside the project workspace' }
  }
  if (policy.verificationPaths.length && picomatch([...policy.verificationPaths], { dot: true })(rel)) return { category: 'verification-change', rule: `verification asset ${rel}` }
  if (policy.protectedModulePaths.length && picomatch([...policy.protectedModulePaths], { dot: true })(rel)) return { category: 'protected-module', rule: `protected module path ${rel}` }
  return undefined
}

function judgeShell(policy: ToolPolicy, command: string): { category: HumanGateReason; rule: string } | undefined {
  for (const origin of policy.apiOrigins) {
    const hostPort = origin.replace(/^https?:\/\//, '')
    if (command.includes(hostPort) || (/localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(command) && /\/api\/(projects|learning|policy|events|health)/.test(command))) {
      return { category: 'permission-expansion', rule: 'direct call to the SuperAgent API' }
    }
  }
  for (const r of SHELL_RULES) {
    if (r.category === 'production-deploy' && policy.productionWrite) continue
    if (r.re.test(command)) {
      // `rm -r` confined to project scratch/build output is routine; judge the targets.
      if (r.rule === 'recursive delete') {
        const targets = [...command.matchAll(/\brm\s+(?:-\S+\s+)+([^;&|]+)/g)].flatMap(m => m[1]!.trim().split(/\s+/))
        const routine = targets.length > 0 && targets.every(t => /^(\.\/)?(dist|build|out|coverage|\.cache|tmp|\.tmp|test-results|playwright-report|node_modules|\.next|\.turbo|target)(\/|$)/.test(t.replace(/^['"]|['"]$/g, '')))
        if (routine) continue
      }
      return { category: r.category, rule: r.rule }
    }
  }
  for (const re of SHELL_WRITES) {
    for (const m of command.matchAll(re)) {
      const verdict = judgePath(policy, m[1]!, true)
      if (verdict) return verdict
    }
  }
  for (const f of policy.forbiddenPaths) if (command.includes(f)) return { category: 'permission-expansion', rule: `SuperAgent state/secrets path (${f})` }
  return undefined
}

const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'notebook_edit', 'apply_patch'])
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep'])
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'terminal_run', 'job_start'])
/** Tools that execute arbitrary code outside the shell/tool pipeline. */
const ARBITRARY_CODE = /(^|__)browser_run_code_unsafe$|(^|__)browser_evaluate$/

/**
 * Decide one tool call.
 * @param tool - DSH tool name (MCP tools are `mcp__<server>__<tool>`).
 * @param args - frozen JSON arguments.
 */
export function decideToolCall(policy: ToolPolicy, tool: string, args: Record<string, unknown>): ToolDecision {
  const fingerprint = actionFingerprint(tool, args)
  let verdict: { category: HumanGateReason; rule: string } | undefined
  if (policy.role === 'advisor' && !READ_TOOLS.has(tool)) {
    return { allow: false, category: 'permission-expansion', rule: 'read-only advisor session (planner/reviewer)', summary: `${tool}`, fingerprint }
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof args.command === 'string' ? args.command : JSON.stringify(args)
    verdict = judgeShell(policy, command)
    if (!verdict && typeof args.workdir === 'string') verdict = judgePath(policy, args.workdir, false)
  } else if (WRITE_TOOLS.has(tool)) {
    const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined
    verdict = path === undefined ? { category: 'permission-expansion', rule: 'write tool without a path' } : judgePath(policy, path, true)
  } else if (READ_TOOLS.has(tool)) {
    const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined
    if (path !== undefined) verdict = judgePath(policy, path, false)
  } else if (ARBITRARY_CODE.test(tool)) {
    verdict = { category: 'permission-expansion', rule: 'arbitrary code execution in the browser automation host' }
  }
  if (!verdict) return { allow: true }
  if (policy.approvedActions.includes(fingerprint)) return { allow: true, approved: true }
  const summary = `${tool}: ${SHELL_TOOLS.has(tool) ? String(args.command ?? '').slice(0, 200) : String(args.file_path ?? args.path ?? '').slice(0, 200)}`
  return { allow: false, category: verdict.category, rule: verdict.rule, summary, fingerprint }
}
