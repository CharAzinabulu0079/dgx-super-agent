/**
 * Repo Hygiene Gate (Freeze §17): large files, secrets, forbidden binaries/artifacts.
 * Scans files git would commit (tracked + untracked-not-ignored).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GateResult, GateSpec } from '@superagent/contracts'

export interface HygieneFinding {
  readonly file: string
  readonly rule: 'large-file' | 'forbidden-extension' | 'secret' | 'env-file' | 'forbidden-dir'
  readonly severity: 'block' | 'warn'
  readonly detail: string
}

export interface HygieneOptions {
  readonly warnBytes?: number
  readonly blockBytes?: number
}

const FORBIDDEN_EXT = /\.(gguf|safetensors|ckpt|pt|pth|onnx|mp4|mov|mkv|wav|mp3|flac|zip|tar|gz|7z|iso|dmg|exe|dll|so|dylib)$/i
const FORBIDDEN_DIR = /(^|\/)(models|sessions|logs|cache|artifacts)\//
const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['private-key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{32,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['generic-assignment', /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*['"][A-Za-z0-9/+_-]{24,}['"]/i],
]

export function candidateFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  return out.toString('utf8').split('\0').filter(Boolean)
}

export function scanHygiene(root: string, options: HygieneOptions = {}): HygieneFinding[] {
  const warnBytes = options.warnBytes ?? 1024 * 1024
  const blockBytes = options.blockBytes ?? 10 * 1024 * 1024
  const findings: HygieneFinding[] = []
  for (const file of candidateFiles(root)) {
    const abs = join(root, file)
    if (!existsSync(abs)) continue
    const st = statSync(abs)
    if (!st.isFile()) continue
    const base = file.split('/').pop() ?? file
    if (/^\.env(\..+)?$/.test(base) && base !== '.env.example') {
      findings.push({ file, rule: 'env-file', severity: 'block', detail: 'dotenv file would be committed' })
    }
    if (FORBIDDEN_EXT.test(file)) findings.push({ file, rule: 'forbidden-extension', severity: 'block', detail: 'binary/media/model artifact' })
    if (FORBIDDEN_DIR.test(file)) findings.push({ file, rule: 'forbidden-dir', severity: 'warn', detail: 'runtime data directory' })
    if (st.size >= blockBytes) findings.push({ file, rule: 'large-file', severity: 'block', detail: `${st.size} bytes` })
    else if (st.size >= warnBytes) findings.push({ file, rule: 'large-file', severity: 'warn', detail: `${st.size} bytes` })
    if (st.size < 2 * 1024 * 1024 && !file.endsWith('pnpm-lock.yaml')) {
      const text = readFileSync(abs, 'utf8')
      if (text.includes('\0')) continue
      for (const [name, re] of SECRET_PATTERNS) {
        if (re.test(text) && !/hygiene\.(test\.)?ts$/.test(file)) {
          findings.push({ file, rule: 'secret', severity: 'block', detail: name })
        }
      }
    }
  }
  return findings
}

export function runHygieneGate(spec: GateSpec, root: string): GateResult {
  const started = Date.now()
  const base = { gateId: spec.id, kind: spec.kind, required: spec.required }
  let findings: HygieneFinding[]
  try {
    findings = scanHygiene(root)
  } catch (error) {
    return { ...base, status: 'error', durationMs: Date.now() - started, summary: `hygiene scan failed: ${String(error)}`, outputTail: '' }
  }
  const blocks = findings.filter(f => f.severity === 'block')
  const lines = findings.map(f => `${f.severity.toUpperCase()} ${f.rule} ${f.file} (${f.detail})`)
  return {
    ...base,
    status: blocks.length ? 'fail' : 'pass',
    durationMs: Date.now() - started,
    summary: `${blocks.length} block, ${findings.length - blocks.length} warn`,
    outputTail: lines.slice(0, 40).join('\n'),
    failureSignature: blocks.length ? `${spec.id}:${blocks.map(b => `${b.rule}@${b.file}`).sort().join(',')}` : undefined,
    details: { findings },
  }
}
