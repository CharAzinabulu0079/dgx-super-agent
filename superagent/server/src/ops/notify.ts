/**
 * Phone notifications for what needs a human or is finished: ntfy (self-hostable), Bark
 * (iOS) or a Telegram bot. All three work over plain HTTP(S) from the server, so they reach
 * a phone without the web UI being open (browser push would need HTTPS). Config in
 * `$SUPERAGENT_HOME/notify.json` (0600); secrets are write-only through the API.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SuperAgentEvent } from '@superagent/contracts'
import type { StateStore } from '@superagent/project-state'
import { narrate, type NarrateLang } from '../narrate.ts'

export type NotifyKind = 'ntfy' | 'bark' | 'telegram'
export type NotifyEvent = 'done' | 'stuck' | 'decision'
export const NOTIFY_EVENTS: readonly NotifyEvent[] = ['done', 'stuck', 'decision']

export interface NotifyChannel {
  readonly kind: NotifyKind
  /** ntfy: topic URL (https://ntfy.sh/<topic> or your server); bark: https://api.day.app/<key>. */
  readonly url?: string
  /** ntfy access token (optional). */
  readonly token?: string
  readonly botToken?: string
  readonly chatId?: string
}

export interface NotifyConfig {
  readonly channels: readonly NotifyChannel[]
  readonly events: Readonly<Record<NotifyEvent, boolean>>
  readonly lang: NarrateLang
}

export class NotifyError extends Error {}

const DEFAULT: NotifyConfig = { channels: [], events: { done: true, stuck: true, decision: true }, lang: 'zh' }
const file = (home: string): string => join(home, 'notify.json')

export function loadNotify(home: string): NotifyConfig {
  if (!existsSync(file(home))) return DEFAULT
  try {
    const c = JSON.parse(readFileSync(file(home), 'utf8')) as Partial<NotifyConfig>
    return { channels: c.channels ?? [], events: { ...DEFAULT.events, ...c.events }, lang: c.lang === 'en' ? 'en' : 'zh' }
  } catch (corrupt) {
    void corrupt
    return DEFAULT
  }
}

/** What the API shows: secrets masked. */
export function notifyView(home: string): NotifyConfig & { channels: Array<NotifyChannel & { secret: boolean }> } {
  const c = loadNotify(home)
  return {
    ...c,
    channels: c.channels.map(ch => ({
      kind: ch.kind,
      url: ch.kind === 'bark' && ch.url ? ch.url.replace(/(api\.day\.app\/)[^/]+/, '$1••••') : ch.url,
      chatId: ch.chatId,
      secret: !!(ch.token || ch.botToken || ch.kind === 'bark'),
    })),
  }
}

function validUrl(u: string | undefined, what: string): string {
  try {
    const url = new URL(String(u ?? ''))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol')
    return url.toString().replace(/\/$/, '')
  } catch (bad) {
    void bad
    throw new NotifyError(`${what}: a full http(s) URL is required`)
  }
}

/** Save channels + events. A channel sent without its secret keeps the stored one (same kind, same index). */
export function saveNotify(home: string, input: unknown): NotifyConfig {
  const o = (input ?? {}) as { channels?: unknown[]; events?: Record<string, unknown>; lang?: string }
  const old = loadNotify(home)
  const channels = (Array.isArray(o.channels) ? o.channels : []).map((raw, i): NotifyChannel => {
    const c = (raw ?? {}) as Record<string, unknown>
    const prev = old.channels[i]?.kind === c.kind ? old.channels[i] : undefined
    if (c.kind === 'ntfy') return { kind: 'ntfy', url: validUrl(c.url as string, 'ntfy topic URL'), ...((c.token as string) || prev?.token ? { token: (c.token as string) || prev!.token } : {}) }
    if (c.kind === 'bark') {
      const url = typeof c.url === 'string' && c.url.includes('••••') ? prev?.url : c.url
      return { kind: 'bark', url: validUrl(url as string, 'Bark URL') }
    }
    if (c.kind === 'telegram') {
      const botToken = (c.botToken as string) || prev?.botToken
      if (!botToken || !/^\d+:[\w-]{20,}$/.test(botToken)) throw new NotifyError('Telegram: bot token like 123456:ABC… is required')
      if (!/^-?\d+$|^@\w+$/.test(String(c.chatId ?? ''))) throw new NotifyError('Telegram: chat id (a number) is required')
      return { kind: 'telegram', botToken, chatId: String(c.chatId) }
    }
    throw new NotifyError('kind must be ntfy | bark | telegram')
  })
  const events = Object.fromEntries(NOTIFY_EVENTS.map(e => [e, o.events?.[e] !== false])) as Record<NotifyEvent, boolean>
  const cfg: NotifyConfig = { channels, events, lang: o.lang === 'en' ? 'en' : 'zh' }
  mkdirSync(home, { recursive: true })
  writeFileSync(`${file(home)}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${file(home)}.tmp`, file(home))
  chmodSync(file(home), 0o600)
  return cfg
}

export async function sendTo(ch: NotifyChannel, title: string, body: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const signal = AbortSignal.timeout(10_000)
  let res: Response
  if (ch.kind === 'ntfy') {
    // Title goes in the JSON body (header values must be ASCII; titles are often Chinese).
    const u = new URL(ch.url!)
    res = await fetchImpl(u.origin, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...(ch.token ? { authorization: `Bearer ${ch.token}` } : {}) }, body: JSON.stringify({ topic: u.pathname.replace(/^\//, ''), title, message: body }) })
  } else if (ch.kind === 'bark') {
    res = await fetchImpl(`${ch.url}`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, body, group: 'SuperAgent' }) })
  } else {
    res = await fetchImpl(`https://api.telegram.org/bot${ch.botToken}/sendMessage`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: ch.chatId, text: `${title}\n${body}` }) })
  }
  if (!res.ok) throw new NotifyError(`${ch.kind}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
}

/** Which notification an event is, if any. */
export function classify(e: SuperAgentEvent): NotifyEvent | undefined {
  const d = e.data as Record<string, unknown>
  if (e.type === 'human-gate/opened') return 'decision'
  if (e.type === 'goal/updated' && d.from !== d.status) {
    if (d.status === 'complete') return 'done'
    if (d.status === 'failed' || d.error) return 'stuck'
  }
  return undefined
}

/** Subscribe to the store; returns an unsubscribe function. Failures are logged, never thrown. */
export function startNotifier(store: StateStore, fetchImpl: typeof fetch = fetch): () => void {
  return store.subscribe(e => {
    const kind = classify(e)
    if (!kind) return
    const cfg = loadNotify(store.home)
    if (!cfg.channels.length || !cfg.events[kind]) return
    const line = narrate(e, id => store.getTask(e.projectId, id)?.title, cfg.lang)
    if (!line) return
    const project = store.getProject(e.projectId)?.name ?? e.projectId
    const head = cfg.lang === 'zh' ? { done: '完成', stuck: '卡住了', decision: '需要你决定' }[kind] : { done: 'Done', stuck: 'Stuck', decision: 'Needs your decision' }[kind]
    for (const ch of cfg.channels) {
      sendTo(ch, `SuperAgent · ${project} · ${head}`, line.text, fetchImpl).catch(error => console.error(`notify ${ch.kind}: ${String((error as Error).message ?? error)}`))
    }
  })
}
