/**
 * The background layer behind the UI: gradient, uploaded image/video, or an embedded web
 * page (e.g. the Web Digital Human) wired through the postMessage bridge described in
 * docs/DIGITAL_HUMAN_BACKGROUND.md.
 */
import { useEffect, useRef } from 'react'
import type { ActivityEvent, Appearance } from './api.ts'
import { GRADIENTS, embedOrigin } from './theme.ts'
import { t } from './i18n.ts'

export interface BridgeFeed {
  /** Latest items to forward; the layer tracks what it already sent. */
  readonly activity: readonly ActivityEvent[]
  readonly chief: ReadonlyArray<{ seq: number; projectId: string; role: string; text: string }>
  readonly project: { id: string; name: string } | null
}

export function BackgroundLayer({ a, url, theme, feed, onChat, onNotice }: {
  a: Appearance; url?: string; theme: 'light' | 'dark'; feed: BridgeFeed
  onChat: (text: string) => void; onNotice: (text: string) => void
}) {
  const b = a.background
  if (b.kind === 'none') return null
  const filter = b.blur ? `blur(${b.blur}px)` : undefined
  return (
    <div className="bg-layer" aria-hidden={b.kind !== 'embed' || !b.interactive} data-testid="bg-layer" data-kind={b.kind}>
      {b.kind === 'gradient' && <div className="bg-fill" style={{ background: GRADIENTS[b.preset ?? 'aurora'] ?? GRADIENTS.aurora, filter }} />}
      {b.kind === 'image' && url && <div className="bg-fill" style={{ backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center', filter, transform: b.blur ? 'scale(1.05)' : undefined }} />}
      {b.kind === 'video' && url && <video className="bg-fill" src={url} autoPlay muted loop playsInline style={{ objectFit: 'cover', filter }} />}
      {b.kind === 'embed' && embedOrigin(b.url) && <EmbedBridge a={a} theme={theme} feed={feed} onChat={onChat} onNotice={onNotice} />}
      {b.dim > 0 && <div className="bg-dim" style={{ background: `rgba(0,0,0,${b.dim})` }} />}
    </div>
  )
}

function EmbedBridge({ a, theme, feed, onChat, onNotice }: { a: Appearance; theme: 'light' | 'dark'; feed: BridgeFeed; onChat: (text: string) => void; onNotice: (text: string) => void }) {
  const b = a.background
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const sent = useRef({ activity: 0, chief: 0 })
  const origin = embedOrigin(b.url)!
  const sameOrigin = origin === location.origin
  // A sandboxed same-origin frame has an opaque origin, so it can only be addressed with '*' (its window is still exact).
  const post = (type: string, data: unknown) => frame.current?.contentWindow?.postMessage({ source: 'superagent', version: 1, type, data }, sameOrigin ? '*' : origin)
  const hello = () => post('hello', { project: feed.project, theme, accent: a.accent, allowChat: !!b.allowChat })

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== (sameOrigin ? 'null' : origin)) return
      const m = e.data as { source?: string; type?: string; text?: unknown }
      if (m?.source !== 'superagent-background') return
      if (m.type === 'ready') {
        // Forward only what happens from now on (the page starts fresh on every load).
        ready.current = true
        sent.current = { activity: Math.max(0, ...feed.activity.map(l => l.seq)), chief: Math.max(0, ...feed.chief.map(c => c.seq)) }
        hello()
      }
      if (m.type === 'chat' && typeof m.text === 'string' && m.text.trim()) {
        if (b.allowChat && feed.project) onChat(m.text.slice(0, 2000))
        else onNotice(t('The background page tried to talk to the Chief; enable “Allow chat” in Appearance to let it.'))
      }
    }
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  })
  useEffect(() => { ready.current = false }, [b.url])
  useEffect(() => { if (ready.current) hello() }, [feed.project?.id, theme, a.accent, b.allowChat])
  useEffect(() => {
    if (!ready.current) return
    for (const l of feed.activity) if (l.seq > sent.current.activity) post('activity', l)
    for (const c of feed.chief) if (c.seq > sent.current.chief) post('chief', { projectId: c.projectId, role: c.role, text: c.text })
    sent.current = { activity: Math.max(sent.current.activity, ...feed.activity.map(l => l.seq)), chief: Math.max(sent.current.chief, ...feed.chief.map(c => c.seq)) }
  }, [feed.activity, feed.chief])
  return (
    <iframe
      ref={frame}
      className="bg-fill bg-embed"
      src={b.url}
      title="Background"
      data-testid="bg-embed"
      // Same-origin pages never get allow-same-origin (they could read the UI's token).
      sandbox={sameOrigin ? 'allow-scripts allow-forms' : 'allow-scripts allow-forms allow-same-origin'}
      allow={b.allowMedia ? 'autoplay; microphone; camera' : undefined}
      referrerPolicy="no-referrer"
      style={{ pointerEvents: b.interactive ? 'auto' : 'none' }}
    />
  )
}
