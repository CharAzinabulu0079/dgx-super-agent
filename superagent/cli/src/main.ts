#!/usr/bin/env node
/**
 * `sa` — SuperAgent command line. Thin shell over the same runtime the API uses.
 * Run: `node superagent/cli/src/main.ts <command>` (or `pnpm sa <command>`).
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseGateSpec, type GateSpec } from '@superagent/contracts'
import { parseModelSpec } from '@superagent/model-policy'
import { scanHygiene } from '@superagent/verifier'
import { Observatory } from '@superagent/architecture-observatory'
import { createRuntime, startServer } from '@superagent/server'
import { REPO_ROOT } from '@superagent/testkit'

const HELP = `sa — DGX Super Agent CLI

  sa serve [--port 7788] [--host 127.0.0.1] [--no-watch] [--worker-patch file.yml]...
  sa project add <name> <root> [--gate 'id=command'...] [--protect module...]
  sa project list
  sa status <project>
  sa goal <project> "<objective>"
  sa task add <project> <goal> --title T --instructions I [--model provider/model] [--escalation provider/model] [--gate 'id=command'...]
  sa run <project> <goal>                      run the goal's tasks through the loop (DSH Workers)
  sa stop <project> <task> | sa steer <project> <task> "<text>"
  sa decide <project> <humanGate> approve|reject ["note"]
  sa recover <project>                          close attempts interrupted by a crash
  sa arch scan [root] [--check]                 regenerate .architecture/ (exit 1 on drift errors with --check)
  sa arch hook [root]                           install a git pre-commit hook that refreshes .architecture/
  sa hygiene [root]                             repo hygiene gate (secrets, large files, artifacts)

Environment: SUPERAGENT_HOME (state, default ~/.superagent), SUPERAGENT_TOKEN (API auth),
DSH model credentials (e.g. DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL) for DSH Workers.`

function gateArg(spec: string, i: number): GateSpec {
  const eq = spec.indexOf('=')
  if (spec.trim().startsWith('{')) return parseGateSpec(JSON.parse(spec), `--gate[${i}]`)
  if (eq <= 0) throw new Error(`--gate must be 'id=command' or JSON, got ${spec}`)
  const id = spec.slice(0, eq)
  const command = spec.slice(eq + 1)
  const kind = id === 'architecture' ? 'architecture-drift' : id === 'hygiene' ? 'hygiene' : /playwright/.test(command) ? 'e2e' : 'command'
  return parseGateSpec({ id, kind, command: kind === 'command' || kind === 'e2e' ? command : undefined, parser: /node --test/.test(command) ? 'node-test' : undefined }, `--gate[${i}]`)
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' }, host: { type: 'string' }, 'no-watch': { type: 'boolean' },
      'worker-patch': { type: 'string', multiple: true },
      gate: { type: 'string', multiple: true }, protect: { type: 'string', multiple: true },
      title: { type: 'string' }, instructions: { type: 'string' }, model: { type: 'string' }, escalation: { type: 'string' },
      check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  const [cmd, sub, ...rest] = positionals
  if (!cmd || values.help) { console.log(HELP); return 0 }

  if (cmd === 'arch') {
    const root = resolve(rest[0] ?? (sub !== 'scan' && sub !== 'hook' ? sub ?? '.' : '.'))
    if (sub === 'hook') {
      const hook = join(root, '.git', 'hooks', 'pre-commit')
      if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git repository root`)
      writeFileSync(hook, `#!/bin/sh\n# SuperAgent: keep .architecture/ in sync with every commit\nnode "${join(REPO_ROOT, 'superagent/cli/src/main.ts')}" arch scan "${root}" >/dev/null && git add "${root}/.architecture"\n`)
      chmodSync(hook, 0o755)
      console.log(`installed ${hook}`)
      return 0
    }
    const g = await new Observatory().scan(root)
    const errors = g.drift.filter(d => d.severity === 'error')
    console.log(`${g.stats.modules} modules, ${g.stats.edges} edges, ${g.drift.length} drift (${errors.length} error) in ${g.stats.scanMs}ms → ${join(root, '.architecture')}`)
    for (const d of g.drift) console.log(`  ${d.severity} ${d.kind}: ${d.detail}`)
    if (g.changes.modules.length) console.log(`  changing: ${g.changes.modules.join(', ')}; impacted: ${g.changes.impacted.join(', ') || '—'}; gates: ${g.changes.gates.join(', ') || '—'}`)
    return values.check && errors.length ? 1 : 0
  }
  if (cmd === 'hygiene') {
    const findings = scanHygiene(resolve(sub ?? '.'))
    for (const f of findings) console.log(`${f.severity.toUpperCase()} ${f.rule} ${f.file} (${f.detail})`)
    const blocks = findings.filter(f => f.severity === 'block').length
    console.log(`hygiene: ${blocks} block, ${findings.length - blocks} warn`)
    return blocks ? 1 : 0
  }

  const rt = createRuntime({ workerPatches: values['worker-patch'] })
  const { store, chief, engine } = rt
  switch (cmd) {
    case 'serve': {
      const s = await startServer({
        runtime: rt, port: Number(values.port ?? 7788), host: values.host, token: process.env.SUPERAGENT_TOKEN,
        uiDir: join(REPO_ROOT, 'superagent/ui/dist'), watch: !values['no-watch'],
      })
      for (const p of store.listProjects()) engine.recoverInterrupted(p.id)
      console.log(`SuperAgent API + UI on ${s.url}  (state: ${store.home})`)
      await new Promise(() => {})
      return 0
    }
    case 'project': {
      if (sub === 'list') {
        for (const p of store.listProjects()) console.log(`${p.id}\t${p.root}\t${store.currentGoal(p.id)?.status ?? '-'}`)
        return 0
      }
      if (sub === 'add') {
        const [name, root] = rest
        if (!name || !root) throw new Error('usage: sa project add <name> <root>')
        const p = await rt.addProject({ name, root: resolve(root), defaultGates: (values.gate ?? []).map(gateArg), protectedModules: values.protect ?? [] })
        console.log(JSON.stringify(p, null, 2))
        return 0
      }
      break
    }
    case 'status': console.log(chief.statusReport(sub!)); return 0
    case 'goal': console.log(JSON.stringify(chief.createGoal(sub!, rest.join(' ')), null, 2)); return 0
    case 'task': {
      if (sub !== 'add') break
      const [pid, gid] = rest
      const worker = values.model ? parseModelSpec(values.model) : undefined
      const escalation = values.escalation ? parseModelSpec(values.escalation) : undefined
      const t = chief.addTask(pid!, gid!, {
        title: values.title ?? 'task', instructions: values.instructions ?? '',
        gates: (values.gate ?? []).map(gateArg),
        policy: worker || escalation ? { model: { ...(worker ? { worker } : {}), ...(escalation ? { escalation } : {}) } } : undefined,
      })
      console.log(JSON.stringify(t, null, 2))
      return 0
    }
    case 'run': {
      engine.recoverInterrupted(sub!)
      const unsubscribe = store.subscribe(e => {
        if (['task/state', 'receipt/created', 'loop/decision', 'human-gate/opened', 'chief/wake'].includes(e.type)) console.log(`[${e.type}] ${JSON.stringify(e.data).slice(0, 240)}`)
      })
      const r = await chief.runGoal(sub!, rest[0]!)
      unsubscribe()
      console.log(`\n${chief.statusReport(sub!)}`)
      return r.goal.status === 'complete' ? 0 : 2
    }
    case 'stop': console.log(engine.stop(sub!, rest[0]!).state); return 0
    case 'steer': console.log(engine.steer(sub!, rest[0]!, rest.slice(1).join(' ')).steer); return 0
    case 'decide': {
      const [hg, decision, ...note] = rest
      const t = engine.resolveHumanGate(sub!, hg!, decision === 'approve' ? 'approved' : 'rejected', note.join(' '))
      console.log(t ? `task ${t.id} → ${t.state}` : 'resolved')
      return 0
    }
    case 'recover': console.log(`${engine.recoverInterrupted(sub!).length} task(s) recovered`); return 0
  }
  console.error(HELP)
  return 64
}

main(process.argv.slice(2)).then(code => process.exit(code), error => {
  console.error(`sa: ${(error as Error).message ?? error}`)
  process.exit(1)
})
