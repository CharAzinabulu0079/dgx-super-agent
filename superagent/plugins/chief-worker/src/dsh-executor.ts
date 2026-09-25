/**
 * DSH-backed Worker: one `dsh headless --json` run per attempt, in the project root.
 *
 * - Model Policy → a generated `--patch` overlay that sets DSH's
 *   `agent-default-model` row (and optional `llm-pi-ai` routes).
 * - `retry-with-feedback` continues the previous DSH Session (`--session-id`);
 *   `fresh-context` / `escalate-model` start a new Session.
 * - Live progress: `tool_call` events become progress reports; the final message's
 *   `superagent-report` block becomes the result report. A missing block is
 *   recorded as `not_run` — the verifier decides regardless.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRef } from '@superagent/contracts'
import { runDshStreaming } from './dsh-process.ts'
import type { WorkerExecutor, WorkerRunInput, WorkerRunOutput } from './executor.ts'
import { buildWorkerPrompt, extractFinalReport } from './prompt.ts'

/** How a logical ModelRef maps onto DSH configuration. Stored in `$SUPERAGENT_HOME/model-routes.json`. */
export interface ModelRoutes {
  /** Logical provider → concrete DSH provider route + model. */
  readonly aliases?: Record<string, { provider: string; model: string }>
  /** `llm-pi-ai` `providers` config (OpenAI-compatible local gateway, Anthropic, …). */
  readonly piAiProviders?: Record<string, unknown>
  /** Extra environment for every Worker (never secrets in git: this file lives in SUPERAGENT_HOME). */
  readonly env?: Record<string, string>
}

export interface DshExecutorOptions {
  /** DSH_HOME for Worker runs; default `<stateHome>/dsh-home`. */
  readonly dshHome?: string
  /** DSH profile; default `headless`. */
  readonly profile?: string
  /** Extra `--patch` overlays (e.g. browser-use / SuperAgent bundle). */
  readonly patches?: readonly string[]
  readonly timeoutMs?: number
  readonly env?: Record<string, string>
  readonly routes?: ModelRoutes
}

export function loadModelRoutes(stateHome: string): ModelRoutes {
  const file = join(stateHome, 'model-routes.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as ModelRoutes : {}
}

/** Resolve a logical ModelRef to the DSH `{provider, model}` selection. */
export function resolveRoute(model: ModelRef, routes: ModelRoutes): { provider: string; model: string } | undefined {
  const alias = routes.aliases?.[model.provider]
  if (alias) return alias
  if (model.provider === 'local-default') return undefined // keep the profile's own default
  return { provider: model.provider, model: model.model }
}

/** YAML overlay (JSON is valid YAML) selecting the model for this attempt. */
export function modelPatch(model: ModelRef, routes: ModelRoutes): string | undefined {
  const rows: unknown[] = []
  const route = resolveRoute(model, routes)
  if (route) rows.push({ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: route })
  if (routes.piAiProviders) rows.push({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: routes.piAiProviders } })
  return rows.length ? JSON.stringify(rows, null, 2) : undefined
}

export class DshHeadlessExecutor implements WorkerExecutor {
  readonly name = 'dsh-headless'
  private readonly options: DshExecutorOptions

  constructor(options: DshExecutorOptions = {}) {
    this.options = options
  }

  async run(input: WorkerRunInput): Promise<WorkerRunOutput> {
    const routes = this.options.routes ?? loadModelRoutes(input.stateHome)
    const dshHome = this.options.dshHome ?? join(input.stateHome, 'dsh-home')
    const runDir = join(input.stateHome, 'runtime', 'workers', input.worker.id)
    mkdirSync(runDir, { recursive: true })
    const args = ['--profile', this.options.profile ?? 'headless']
    for (const p of this.options.patches ?? []) args.push('--patch', p)
    const patch = modelPatch(input.model, routes)
    if (patch) {
      const file = join(runDir, 'model.patch.yml')
      writeFileSync(file, patch)
      args.push('--patch', file)
    }
    args.push('--json')
    if (input.previousSessionId) args.push('--session-id', input.previousSessionId)
    const gates = input.task.gates.length ? input.task.gates : input.project.defaultGates
    const prompt = buildWorkerPrompt(input, gates)
    writeFileSync(join(runDir, 'prompt.md'), prompt)
    args.push(prompt)

    let sessionId: string | undefined
    let finalText = ''
    let steps = 0
    const result = await runDshStreaming({
      args,
      cwd: input.project.root,
      env: {
        DSH_HOME: dshHome,
        SUPERAGENT_HOME: input.stateHome,
        SUPERAGENT_PROJECT_ID: input.project.id,
        SUPERAGENT_TASK_ID: input.task.id,
        SUPERAGENT_WORKER_ID: input.worker.id,
        ...routes.env,
        ...this.options.env,
      },
      timeoutMs: this.options.timeoutMs ?? 30 * 60_000,
      signal: input.signal,
      logFile: join(runDir, 'events.jsonl'),
      onEvent: event => {
        if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
        else if (event.type === 'final' && typeof event.text === 'string') finalText = event.text
        else if (event.type === 'tool_call') {
          steps++
          const tool = String(event.tool)
          const inputObj = (event.input ?? {}) as Record<string, unknown>
          const target = typeof inputObj.file_path === 'string' ? inputObj.file_path : typeof inputObj.description === 'string' ? inputObj.description : typeof inputObj.command === 'string' ? inputObj.command.slice(0, 80) : ''
          if (tool === 'superagent_report') return // the bundle tool writes its own report
          input.report({
            kind: 'progress', current_state: `${tool}${target ? `: ${target}` : ''}`, progress: Math.min(90, steps * 5),
            changed_modules: [], verification_result: 'not_run', blocker: null, next_action: null, human_required: false, summary: '',
          })
        }
      },
    })

    const fallback = { task_id: input.task.id, model: input.model }
    const final = extractFinalReport(finalText, fallback)
    if (final) input.report(final)
    else {
      input.report({
        kind: 'result', current_state: 'finished-without-report', progress: 100, changed_modules: [], verification_result: 'not_run',
        blocker: null, next_action: null, human_required: false, summary: finalText.slice(0, 500),
      })
    }
    if (input.signal.aborted) return { exit: 'cancelled', sessionId, finalText }
    if (result.timedOut) return { exit: 'timeout', sessionId, finalText, diagnostics: result.stderrTail }
    return { exit: result.exitCode === 0 ? 'completed' : 'crashed', sessionId, finalText, diagnostics: result.stderrTail }
  }
}
