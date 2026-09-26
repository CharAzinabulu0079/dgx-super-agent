/** Talk to the project's Chief: the same persistent session that handles automatic wakes. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type ChiefMessage } from './api.ts'
import { Markdown } from './Markdown.tsx'

export function ChiefChat({ projectId, refreshKey, onError }: { projectId: string; refreshKey: number; onError: (e: string) => void }) {
  const [data, setData] = useState<{ available: boolean; busy: boolean; messages: ChiefMessage[] } | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const load = () => api<{ available: boolean; busy: boolean; messages: ChiefMessage[] }>('GET', `/api/projects/${projectId}/chief/messages`).then(setData, e => onError(String(e)))
  useEffect(() => { void load() }, [projectId, refreshKey])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [data?.messages.length])
  useEffect(() => {
    if (!data?.busy) return
    const t = window.setInterval(load, 1500)
    return () => window.clearInterval(t)
  }, [data?.busy])
  const send = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || sending) return
    setSending(true)
    api('POST', `/api/projects/${projectId}/chief/messages`, { text }).then(() => { setText(''); void load() }, err => onError(String(err))).finally(() => setSending(false))
  }
  if (!data) return <p className="muted">Loading…</p>
  return (
    <section className="card chat" data-testid="chat">
      <h3>Chief</h3>
      {!data.available && <p className="muted">Chat needs the Chief profile: run <code>sa dsh setup</code> and restart <code>sa serve</code>.</p>}
      <div className="chat-log" data-testid="chat-log">
        {data.messages.length === 0 && <p className="muted">Ask the Chief anything about this project — progress, why something failed, what to do next. It can also send you files.</p>}
        {data.messages.map(m => <ChatMessage key={m.id} m={m} projectId={projectId} />)}
        {data.busy && <div className="msg chief typing" data-testid="chat-busy">Chief is working…</div>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={send}>
        <textarea rows={2} placeholder={data.available ? 'Message the Chief (Ctrl/⌘+Enter to send)' : 'Chief chat unavailable'} value={text} disabled={!data.available}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e) }} data-testid="chat-input" />
        <button type="submit" disabled={!data.available || sending || !text.trim()} data-testid="chat-send">Send</button>
      </form>
    </section>
  )
}

function ChatMessage({ m, projectId }: { m: ChiefMessage; projectId: string }) {
  const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (m.role === 'tool') return <div className="msg tool" data-testid="chat-tool">⚙ {m.text}</div>
  if (m.role === 'wake') {
    return (
      <details className="msg wake">
        <summary>Automatic wake · {time}</summary>
        <pre>{m.text}</pre>
      </details>
    )
  }
  return (
    <div className={`msg ${m.role}`} data-testid={`chat-${m.role}`}>
      {m.role === 'chief' ? <Markdown text={m.text} projectId={projectId} /> : <pre>{m.text}</pre>}
      <time>{time}</time>
    </div>
  )
}
