#!/usr/bin/env node
/**
 * `sa` — SuperAgent command line. Thin shell over the same runtime the API uses.
 * Run: `node superagent/cli/src/main.ts <command>` (or `pnpm sa <command>`).
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseGateSpec, type GateSpec } from '@superagent/contracts'
import { effectiveModels, formatModel, loadGlobalPolicy, parseModelSpec, parsePolicyLayer, saveGlobalPolicy } from '@superagent/model-policy'
import { scanHygiene } from '@superagent/verifier'
import { Observatory } from '@superagent/architecture-observatory'
import { BROWSER_PATCH, CHIEF_PROFILE, UpdateManager, createBackup, createRuntime, isLoopbackHost, isSupervised, managedBase, narrate, preflightChecks, registerHeldOut, setupDshProfiles, startServer, systemdUnit, appVersion } from '@superagent/server'
import { homedir, networkInterfaces } from 'node:os'
import { execFileSync } from 'node:child_process'
import { defaultHome } from '@superagent/project-state'
import { REPO_ROOT } from '@superagent/testkit'

const HELP = `sa — DGX Super Agent CLI

  sa dsh setup [--no-chief]                    create DSH profiles superagent-worker (+browser) / superagent-chief
  sa chief                                      print how to open the Chief (DSH Web with SuperAgent tools)
  sa serve [--port 7788] [--host 127.0.0.1] [--no-watch] [--browser] [--no-chief] [--reflect] [--worker-patch file.yml]...
                                                Chief auto-wake + UI chat are on when "sa dsh setup" created superagent-chief-cli
                                                phone over WireGuard: --host <wg address> (all requests then need the token);
                                                SUPERAGENT_HUMAN_TOKEN=<24+ chars> keeps the link stable across restarts
  sa project add <name> <root> [--gate 'id=command'...] [--protect module...]
  sa project list
  sa install --dir ~/superagent [--from <git url|path>] [--ref <tag>]
                                                managed install (releases + current symlink) for one-click Update/Rollback
  sa service unit|install [--dir ~/superagent] [--host <ip>] [--browser]
                                                systemd user service (auto start, restart after update)
  sa update status|check|apply <tag>|rollback [--dir ~/superagent]
  sa heldout add <project> <gateId> <testsDir> --mount <dir> --command "<cmd>"
                                                hidden acceptance tests: copied into $SUPERAGENT_HOME/heldout,
                                                mounted only into a verification copy, never visible to Workers
  sa status <project>
  sa do <project|path> "<what you want>" [--review] [--no-run]
                                                plan the request into tasks (Chief planner), then run them until
                                                independent checks pass; a path registers the project first
  sa goal <project> "<objective>"
  sa task add <project> <goal> --title T --instructions I [--model provider/model] [--escalation provider/model] [--gate 'id=command'...]
  sa run <project> <goal>                      run the goal's tasks through the loop (DSH Workers)
  sa stop <project> <task> | sa steer <project> <task> "<text>"
  sa decide <project> <humanGate> approve|reject ["note"]
  sa learn list [project] | sa learn eval <candidate> | sa learn approve|reject <candidate> ["note"]
  sa policy show [--project p]                  effective role → model (chief, worker, reviewer, escalation, planner)
  sa policy set <role> <provider/model|local-default> [--project p]    e.g. all Workers on a cheap API model
  sa policy clear <role> [--project p]
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
      check: { type: 'boolean' }, dir: { type: 'string' }, from: { type: 'string' }, ref: { type: 'string' }, review: { type: 'boolean' }, 'no-run': { type: 'boolean' }, mount: { type: 'string' }, command: { type: 'string' }, help: { type: 'boolean', short: 'h' }, project: { type: 'string' }, reflect: { type: 'boolean' },
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

  // ---- managed install / service / update (work without a running server)
  if (cmd === 'install') {
    const base = resolve(values.dir ?? join(homedir(), 'superagent'))
    let from = values.from
    if (!from) {
      try { from = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT }).toString().trim() } catch (noRemote) { void noRemote; from = REPO_ROOT }
    }
    console.log(`Installing SuperAgent into ${base} from ${from}${values.ref ? ` @ ${values.ref}` : ''} (clone, install, build, typecheck)…`)
    const m = UpdateManager.install(base, from, values.ref)
    console.log(`Installed ${m.state().current}. Run it from ${join(base, 'current')}:\n  node ${join(base, 'current', 'superagent/cli/src/main.ts')} dsh setup\n  node ${join(base, 'current', 'superagent/cli/src/main.ts')} service install --dir ${base}`)
    return 0
  }
  if (cmd === 'service') {
    const base = resolve(values.dir ?? managedBase(REPO_ROOT) ?? join(homedir(), 'superagent'))
    const unit = systemdUnit({ base, home: process.env.SUPERAGENT_HOME, host: values.host, port: values.port ? Number(values.port) : undefined, browser: values.browser })
    if (sub !== 'install') { console.log(unit); return 0 }
    const dir = join(homedir(), '.config', 'systemd', 'user')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'superagent.service'), unit)
    const envDir = join(homedir(), '.config', 'superagent')
    mkdirSync(envDir, { recursive: true, mode: 0o700 })
    if (!existsSync(join(envDir, 'env'))) writeFileSync(join(envDir, 'env'), '# SUPERAGENT_HUMAN_TOKEN=<24+ random characters>\n', { mode: 0o600 })
    console.log(`Wrote ${join(dir, 'superagent.service')}. Next:\n  systemctl --user daemon-reload && systemctl --user enable --now superagent\n  loginctl enable-linger $USER   # keep it running after logout\n  (optional) put SUPERAGENT_HUMAN_TOKEN in ${join(envDir, 'env')} for a stable phone link`)
    return 0
  }
  if (cmd === 'update') {
    const base = resolve(values.dir ?? managedBase(REPO_ROOT) ?? '')
    if (!base || !existsSync(join(base, 'releases.json'))) throw new Error('not a managed install: run `sa install --dir ~/superagent` first (or pass --dir)')
    const m = new UpdateManager({ base, home: defaultHome(), backup: label => createBackup(defaultHome(), { label, ...appVersion() }).id })
    if (sub === 'check') { const c = m.check(); for (const a of c.available) console.log(`${a.newer ? '↑' : ' '} ${a.ref}\t${a.commit.slice(0, 7)}`); return 0 }
    if (sub === 'apply') {
      const job = m.startUpdate(rest[0] ?? '')
      await m.done
      console.log(job.status === 'switched' ? `Switched to ${job.release}. Restart the service: systemctl --user restart superagent` : `Update failed: ${job.error} (log: ${job.log})`)
      return job.status === 'switched' ? 0 : 1
    }
    if (sub === 'rollback') { console.log(`Rolled back to ${m.rollback()}. Restart the service: systemctl --user restart superagent`); return 0 }
    console.log(JSON.stringify(m.state(), null, 2))
    return 0
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
  if (cmd === 'policy') {
    const home = defaultHome()
    const { StateStore } = await import('@superagent/project-state')
    const store = new StateStore(home)
    const proj = values.project ? store.requireProject(values.project) : undefined
    if (sub === 'set' || sub === 'clear') {
      const [role, spec] = rest
      if (!role) throw new Error('usage: sa policy set <role> <provider/model>')
      const current = proj ? (proj.policy ?? {}) : loadGlobalPolicy(home)
      const models: Record<string, unknown> = { ...current.models }
      if (sub === 'clear') delete models[role]
      else models[role] = spec
      const layer = parsePolicyLayer({ ...current, models }, proj ? 'project' : 'global')
      if (proj) store.updateProject(proj.id, { policy: layer })
      else saveGlobalPolicy(home, layer)
    }
    const eff = effectiveModels(loadGlobalPolicy(home), proj ? store.requireProject(proj.id).policy : undefined)
    for (const [role, m] of Object.entries(eff)) if (m) console.log(`${role.padEnd(11)} ${formatModel(m)}`)
    return 0
  }
  const rt = createRuntime({ workerPatches, llmReflection: values.reflect })
  const { store, chief, engine } = rt
  switch (cmd) {
    case 'serve': {
      const host = values.host ?? '127.0.0.1'
      const envToken = process.env.SUPERAGENT_HUMAN_TOKEN
      if (envToken !== undefined && envToken.length < 24) throw new Error('SUPERAGENT_HUMAN_TOKEN must be at least 24 characters (e.g. `openssl rand -base64 24`)')
      // Held only in memory from here on: nothing this process spawns (Chief, Workers, gates, ▷ Run) inherits it.
      delete process.env.SUPERAGENT_HUMAN_TOKEN
      const chiefProfile = existsSync(join(dshHome, 'profiles', 'superagent-chief-cli', 'package.json'))
      const s = await startServer({
        runtime: rt, port: Number(values.port ?? 7788), host, humanToken: envToken, chiefChat: chiefProfile,
        uiDir: join(REPO_ROOT, 'superagent/ui/dist'), watch: !values['no-watch'],
        chiefWake: !values['no-chief'] && chiefProfile,
        resumeGoals: true, stableToken: !!envToken,
      })
      // A freshly updated release checks itself; if it is red, go back to the previous one.
      const base = managedBase(REPO_ROOT)
      if (base) {
        const m = new UpdateManager({ base, home: store.home, restart: () => { if (isSupervised()) setTimeout(() => process.exit(75), 300) } })
        const failing = preflightChecks({ store, repoRoot: REPO_ROOT, dshHome, usesDsh: true }).filter(c => c.status === 'fail' && c.group === 'dsh')
        const r = m.verifyAfterStart(basename(realpathSync(REPO_ROOT)), failing.length === 0, failing.map(c => c.title).join('; '))
        if (r === 'rolled-back') console.error(`This release failed its start-up check (${failing.map(c => c.title).join('; ')}); switched back to ${m.state().current}.`)
        else if (r === 'verified') console.log(`Update verified: running ${basename(realpathSync(REPO_ROOT))}.`)
      }
      // Agent token for the Chief launcher (0600, outside any worktree). The human token
      // is printed once and kept only in this process's memory.
      mkdirSync(join(store.home, 'secrets'), { recursive: true, mode: 0o700 })
      writeFileSync(join(store.home, 'secrets', 'agent-token'), s.agentToken, { mode: 0o600 })
      const port = new URL(s.url).port
      const hosts = host === '0.0.0.0' || host === '::'
        ? Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a!.address)
        : [new URL(s.url).hostname]
      for (const h of hosts) console.log(`SuperAgent UI: http://${h}:${port}/?token=${s.humanToken}`)
      console.log(`  human link — keep private; ${envToken ? 'token from SUPERAGENT_HUMAN_TOKEN (stable across restarts)' : 'valid until restart (set SUPERAGENT_HUMAN_TOKEN for a stable link)'}. State: ${store.home}`)
      if (!isLoopbackHost(host)) console.log('  listening beyond localhost: every request needs the token; traffic is plain HTTP — use it only inside WireGuard/VPN (or behind TLS).')
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
    case 'heldout': {
      const [pid, gateId, from] = rest
      if (sub !== 'add' || !pid || !gateId || !from || !values.mount || !values.command) throw new Error('usage: sa heldout add <project> <gateId> <testsDir> --mount <dir> --command "<cmd>"')
      const p = registerHeldOut(store, pid, { gateId, from, mountAt: values.mount, command: values.command })
      console.log(`held-out gate ${gateId} registered on ${p.id}: ${p.defaultGates.map(g => g.id + (g.heldOut ? ' (held-out)' : '')).join(', ')}`)
      return 0
    }
    case 'do': {
      const request = rest.join(' ').trim()
      if (!sub || !request) throw new Error('usage: sa do <project|path> "<what you want>"')
      let pid = sub
      if (!store.getProject(sub)) {
        const root = resolve(sub)
        if (!existsSync(root)) throw new Error(`no project or directory named ${sub}`)
        const existing = store.listProjects().find(p => p.root === root)
        pid = existing?.id ?? (await rt.addProject({ name: root.split('/').at(-1)!, root })).id
        if (!existing) console.log(`Registered ${root} as project ${pid} (checks: ${store.requireProject(pid).defaultGates.map(g => g.id).join(', ')})`)
      }
      const titles = new Map<string, string>()
      const unsubscribe = store.subscribe(e => {
        if (e.projectId !== pid) return
        if (e.type === 'task/created') titles.set(e.taskId!, String(e.data.title))
        const line = narrate(e, id => titles.get(id))
        if (line) console.log(`${{ good: '✔', bad: '✖', attention: '!', info: '·' }[line.tone]} ${line.text}`)
      })
      const planned = await chief.planGoal(pid, request, { planner: rt.planner, review: values.review, architecture: rt.architectureSummary(store.requireProject(pid)) })
      if (values['no-run']) { unsubscribe(); console.log(`goal ${planned.goal.id} planned; run with: sa run ${pid} ${planned.goal.id}`); return 0 }
      engine.recoverInterrupted(pid)
      const r = await chief.runGoal(pid, planned.goal.id)
      unsubscribe()
      console.log(`\n${chief.statusReport(pid)}`)
      return r.goal.status === 'complete' ? 0 : 2
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
      if (sub === 'approve' || sub === 'reject') { const c = rt.learning.decide(rest[0]!, sub === 'approve', rest.slice(1).join(' ')); console.log(`${c.id} → ${c.status}`); return 0 }
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
