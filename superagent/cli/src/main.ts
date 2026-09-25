#!/usr/bin/env node
/**
 * `sa` — SuperAgent command line. Thin shell over the same runtime the API uses.
 * Run: `node superagent/cli/src/main.ts <command>` (or `pnpm sa <command>`).
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseGateSpec, type GateSpec } from '@superagent/contracts'
import { parseModelSpec } from '@superagent/model-policy'
import { scanHygiene } from '@superagent/verifier'
import { Observatory } from '@superagent/architecture-observatory'
import { BROWSER_PATCH, CHIEF_PROFILE, createRuntime, setupDshProfiles, startServer } from '@superagent/server'
import { defaultHome } from '@superagent/project-state'
import { REPO_ROOT } from '@superagent/testkit'

const HELP = `sa — DGX Super Agent CLI

  sa dsh setup [--no-chief]                    create DSH profiles superagent-worker (+browser) / superagent-chief
  sa chief                                      print how to open the Chief (DSH Web with SuperAgent tools)
  sa serve [--port 7788] [--host 127.0.0.1] [--no-watch] [--browser] [--worker-patch file.yml]...
  sa project add <name> <root> [--gate 'id=command'...] [--protect module...]
  sa project list
  sa status <project>
  sa goal <project> "<objective>"
  sa task add <project> <goal> --title T --instructions I [--model provider/model] [--escalation provider/model] [--gate 'id=command'...]
  sa run <project> <goal>                      run the goal's tasks through the loop (DSH Workers)
  sa stop <project> <task> | sa steer <project> <task> "<text>"
  sa decide <project> <humanGate> approve|reject ["note"]
  sa learn list [project] | sa learn eval <candidate> | sa learn approve|reject <candidate> ["note"]
  sa recover <project>                          close attempts interrupted by a crash
  sa arch scan [root] [--check]                 regenerate .architecture/ (exit 1 on drift errors with --check)
  sa arch hook [root]                           install a git pre-commit hook that refreshes .architecture/
  sa hygiene [root]                             repo hygiene gate (secrets, large files, artifacts)

Environment: SUPERAGENT_HOME (state, default ~/.superagent),
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
      port: { type: 'string' }, host: { type: 'string' }, 'no-watch': { type: 'boolean' }, browser: { type: 'boolean' }, 'no-chief': { type: 'boolean' },
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

  const dshHome = join(defaultHome(), 'dsh-home')
  if (cmd === 'dsh' && sub === 'setup') {
    const r = setupDshProfiles(dshHome, { chief: !values['no-chief'] })
    console.log(JSON.stringify(r, null, 2))
    return 0
  }
  if (cmd === 'chief') {
    console.log(`SUPERAGENT_ROLE=chief SUPERAGENT_AGENT_TOKEN=$(cat ${join(defaultHome(), 'secrets', 'agent-token')}) DSH_HOME=${dshHome} node_modules/.bin/dsh --profile ${CHIEF_PROFILE} web\n(run \`sa dsh setup\` first; start \`sa serve\` before this so the agent token exists)`)
    return 0
  }
  const workerPatches = [...(values.browser ? [BROWSER_PATCH] : []), ...(values['worker-patch'] ?? [])]
  const rt = createRuntime({ workerPatches })
  const { store, chief, engine } = rt
  switch (cmd) {
    case 'serve': {
      const s = await startServer({
        runtime: rt, port: Number(values.port ?? 7788), host: values.host,
        uiDir: join(REPO_ROOT, 'superagent/ui/dist'), watch: !values['no-watch'],
      })
      for (const p of store.listProjects()) engine.recoverInterrupted(p.id)
      // Agent token for the Chief launcher (0600, outside any worktree). The human token
      // is printed once and kept only in this process's memory.
      mkdirSync(join(store.home, 'secrets'), { recursive: true, mode: 0o700 })
      writeFileSync(join(store.home, 'secrets', 'agent-token'), s.agentToken, { mode: 0o600 })
      console.log(`SuperAgent API + UI: ${s.url}/?token=${s.humanToken}\n  (human link — keep private; valid until restart)  state: ${store.home}`)
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
    case 'learn': {
      if (sub === 'list') {
        for (const c of rt.learning.learning.list().filter(c => !rest[0] || c.evidence.projectId === rest[0])) console.log(`${c.id}\t${c.kind}\t${c.status}\t${c.name}\t${c.description}`)
        return 0
      }
      if (sub === 'eval') { const c = await rt.learning.evaluate(rest[0]!); console.log(`${c.id} → ${c.status} (${c.decision})`); return c.status === 'promoted' ? 0 : 2 }
      if (sub === 'approve' || sub === 'reject') { const c = rt.learning.decideMemory(rest[0]!, sub === 'approve', rest.slice(1).join(' ')); console.log(`${c.id} → ${c.status}`); return 0 }
      break
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
