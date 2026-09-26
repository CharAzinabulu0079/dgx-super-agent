/**
 * Minimal, safe Markdown for agent text (React text nodes only, no HTML): paragraphs,
 * lists, **bold**, `code`, and fenced code blocks with Copy and ▷ Run (shell blocks).
 */
import { Fragment, useState, type ReactNode } from 'react'
import { RunSheet } from './Run.tsx'

const SHELL = /^(bash|sh|shell|zsh|console|terminal|cmd)?$/i

export function Markdown({ text, projectId }: { text: string; projectId?: string }) {
  const parts: ReactNode[] = []
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Prose key={k++} text={text.slice(last, m.index)} />)
    parts.push(<CodeBlock key={k++} lang={m[1] ?? ''} code={m[2]!.replace(/\n$/, '')} projectId={projectId} />)
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(<Prose key={k++} text={text.slice(last)} />)
  return <div className="md">{parts}</div>
}

function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/).filter(Boolean)
  return <>{blocks.map((b, i) => {
    const lines = b.split('\n')
    if (lines.every(l => /^\s*([-*]|\d+\.)\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>)}</ul>
    return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l.replace(/^#{1,6}\s+/, ''))}</Fragment>)}</p>
  })}</>
}

export function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((t, i) =>
    t.startsWith('`') && t.endsWith('`') && t.length > 2 ? <code key={i} className="inline">{t.slice(1, -1)}</code>
      : t.startsWith('**') && t.endsWith('**') && t.length > 4 ? <strong key={i}>{t.slice(2, -2)}</strong>
      : <Fragment key={i}>{t}</Fragment>)
}

/** Strip prompt markers ("$ ", "> ") so a copied/run command is exactly the command. */
export function commandOf(code: string): string {
  return code.split('\n').map(l => l.replace(/^\s*\$\s+/, '')).join('\n').trim()
}

export function CodeBlock({ lang, code, projectId }: { lang: string; code: string; projectId?: string }) {
  const [copied, setCopied] = useState(false)
  const [run, setRun] = useState(false)
  const runnable = !!projectId && SHELL.test(lang) && code.trim().length > 0
  const copy = async () => {
    const text = SHELL.test(lang) ? commandOf(code) : code
    try {
      await navigator.clipboard.writeText(text)
    } catch (insecureContext) {
      // Plain HTTP over WireGuard is not a secure context: fall back to a hidden textarea.
      void insecureContext
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="codeblock" data-testid="codeblock">
      <div className="codeblock-bar">
        <span className="lang">{lang || 'text'}</span>
        <span className="spacer" />
        {runnable && <button className="icon" title="Run in the project on the server" aria-label="Run" onClick={() => setRun(true)} data-testid="code-run">▷</button>}
        <button className="icon" title="Copy" aria-label="Copy" onClick={copy} data-testid="code-copy">{copied ? '✓' : '⧉'}</button>
      </div>
      <pre><code>{code}</code></pre>
      {run && projectId && <RunSheet projectId={projectId} command={commandOf(code)} onClose={() => setRun(false)} />}
    </div>
  )
}
