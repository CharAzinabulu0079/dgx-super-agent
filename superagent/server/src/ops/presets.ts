/**
 * Model presets: one click switches every role (chief, planner, worker, reviewer,
 * escalation). Built-ins: Local (everything on local-default) plus Budget / Default /
 * Max that you fill once with your own models. Presets that name an unconfigured
 * provider are shown as unavailable instead of failing at the next run.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRef, ModelRole, PolicyLayer } from '@superagent/contracts'
import { MODEL_ROLES, formatModel, loadGlobalPolicy, parseModelSpec, saveGlobalPolicy } from '@superagent/model-policy'
import { readRoutes } from './providers.ts'

export interface ModelPreset {
  readonly id: string
  readonly name: string
  readonly description: string
  /** role → "provider/model" | "local-default" */
  readonly models: Partial<Record<ModelRole, string>>
}

export const BUILTIN_PRESETS: readonly ModelPreset[] = [
  { id: 'local', name: 'All local', description: 'Everything on your own model server (no API cost).', models: Object.fromEntries(MODEL_ROLES.map(r => [r, 'local-default'])) },
  { id: 'budget', name: 'Budget', description: 'Cheap API models for Workers; local where possible.', models: {} },
  { id: 'default', name: 'Default', description: 'Balanced: capable Chief/Reviewer, efficient Workers.', models: {} },
  { id: 'max', name: 'Max performance', description: 'Strongest models everywhere.', models: {} },
]

export class PresetError extends Error {}

const file = (home: string) => join(home, 'presets.json')

export function loadPresets(home: string): ModelPreset[] {
  if (!existsSync(file(home))) return [...BUILTIN_PRESETS]
  const stored = (JSON.parse(readFileSync(file(home), 'utf8')) as { presets?: ModelPreset[] }).presets ?? []
  const byId = new Map(stored.map(p => [p.id, p]))
  return [...BUILTIN_PRESETS.map(b => byId.get(b.id) ?? b), ...stored.filter(p => !BUILTIN_PRESETS.some(b => b.id === p.id))]
}

export function savePresets(home: string, presets: unknown): ModelPreset[] {
  if (!Array.isArray(presets)) throw new PresetError('expected a list of presets')
  const clean = presets.map((p, i): ModelPreset => {
    const o = p as Record<string, unknown>
    if (typeof o.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(o.id)) throw new PresetError(`presets[${i}].id: lowercase letters, digits, dashes`)
    const models: Partial<Record<ModelRole, string>> = {}
    for (const [role, spec] of Object.entries((o.models ?? {}) as Record<string, unknown>)) {
      if (!MODEL_ROLES.includes(role as ModelRole)) throw new PresetError(`presets[${i}].models.${role}: unknown role`)
      if (spec === '' || spec === null || spec === undefined) continue
      if (typeof spec !== 'string' || !parseModelSpec(spec)) throw new PresetError(`presets[${i}].models.${role}: expected provider/model or local-default`)
      models[role as ModelRole] = spec
    }
    return { id: o.id, name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : o.id, description: typeof o.description === 'string' ? o.description.slice(0, 200) : '', models }
  })
  mkdirSync(home, { recursive: true })
  writeFileSync(`${file(home)}.tmp`, `${JSON.stringify({ presets: clean }, null, 2)}\n`)
  renameSync(`${file(home)}.tmp`, file(home))
  return loadPresets(home)
}

/** Providers the harness can route to: configured routes, aliases, and local-default. */
export function knownProviders(home: string): Set<string> {
  const r = readRoutes(home)
  return new Set(['local-default', ...Object.keys(r.piAiProviders ?? {}), ...Object.keys(r.aliases ?? {})])
}

export interface PresetView extends ModelPreset {
  readonly available: boolean
  readonly problems: string[]
  readonly active: boolean
}

export function presetViews(home: string): PresetView[] {
  const known = knownProviders(home)
  const current = loadGlobalPolicy(home).models ?? {}
  return loadPresets(home).map(p => {
    const entries = Object.entries(p.models) as Array<[ModelRole, string]>
    const problems = entries.flatMap(([role, spec]) => {
      const m = parseModelSpec(spec)!
      return known.has(m.provider) ? [] : [`${role}: provider "${m.provider}" is not configured`]
    })
    if (!entries.length) problems.push('not set up yet — choose a model for each role')
    const active = entries.length > 0 && entries.every(([role, spec]) => { const c = current[role]; return !!c && formatModel(c) === formatModel(parseModelSpec(spec)!) })
    return { ...p, available: problems.length === 0, problems, active }
  })
}

/** Apply a preset to the global policy (all projects without their own override). */
export function applyPreset(home: string, id: string): PolicyLayer {
  const view = presetViews(home).find(p => p.id === id)
  if (!view) throw new PresetError(`preset ${id} not found`)
  if (!view.available) throw new PresetError(`preset ${view.name} is not ready: ${view.problems.join('; ')}`)
  const current = loadGlobalPolicy(home)
  const models: Partial<Record<ModelRole, ModelRef>> = { ...current.models }
  for (const [role, spec] of Object.entries(view.models) as Array<[ModelRole, string]>) models[role] = parseModelSpec(spec)!
  return saveGlobalPolicy(home, { ...current, models })
}
