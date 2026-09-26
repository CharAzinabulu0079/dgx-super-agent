/** Files agents sent you, plus a read-only project browser; preview or download (phone-friendly). */
import { useEffect, useState } from 'react'
import { api, fileLink, fmtSize, type FileLink, type SharedFile, type TreeEntry } from './api.ts'
import { t } from './i18n.ts'

type Target = { file: string } | { path: string }

export function FilesPanel({ projectId, refreshKey, onError }: { projectId: string; refreshKey: number; onError: (e: string) => void }) {
  const [shared, setShared] = useState<SharedFile[]>([])
  const [dir, setDir] = useState('')
  const [tree, setTree] = useState<{ path: string; entries: TreeEntry[]; truncated: boolean } | null>(null)
  const [preview, setPreview] = useState<Target | null>(null)
  useEffect(() => { api<SharedFile[]>('GET', `/api/projects/${projectId}/files`).then(setShared, e => onError(String(e))) }, [projectId, refreshKey])
  useEffect(() => { api<typeof tree>('GET', `/api/projects/${projectId}/tree?path=${encodeURIComponent(dir)}`).then(setTree, e => onError(String(e))) }, [projectId, dir])
  const download = (t: Target) => fileLink(projectId, t, true).then(l => { window.location.href = l.url }, e => onError(String(e)))
  const crumbs = dir ? dir.split('/') : []
  return (
    <>
      <section className="card" data-testid="shared-files">
        <h3>{t('Sent to you')}</h3>
        {shared.length === 0 ? <p className="muted">{t('Nothing yet. Workers and the Chief can send you files (reports, screenshots, builds) — they show up here.')}</p> : (
          <ul className="file-list">{shared.map(f => (
            <li key={f.id} data-testid={`shared-${f.name}`}>
              <div className="file-main">
                <strong>{f.name}</strong> <span className="muted">{fmtSize(f.size)} · {t('from {r}', { r: t(f.from.role) })} · {new Date(f.createdAt).toLocaleString()}</span>
                {f.note && <div>{f.note}</div>}
              </div>
              <div className="file-actions">
                <button onClick={() => setPreview({ file: f.id })} data-testid="preview">{t('Preview')}</button>
                <button onClick={() => download({ file: f.id })} data-testid="download">{t('Download')}</button>
              </div>
            </li>
          ))}</ul>
        )}
      </section>
      <section className="card" data-testid="project-files">
        <h3>{t('Project files')}</h3>
        <nav className="crumbs">
          <button onClick={() => setDir('')}>{t('root')}</button>
          {crumbs.map((c, i) => <span key={i}> / <button onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
        </nav>
        <ul className="file-list">
          {tree?.entries.map(e => (
            <li key={e.path}>
              {e.type === 'dir'
                ? <button className="link" onClick={() => setDir(e.path)} data-testid={`dir-${e.name}`}>📁 {e.name}/</button>
                : <>
                    <button className="link" onClick={() => setPreview({ path: e.path })} data-testid={`file-${e.name}`}>📄 {e.name}</button>
                    <span className="muted"> {fmtSize(e.size ?? 0)}</span>
                    <button className="small" onClick={() => download({ path: e.path })}>⬇</button>
                  </>}
            </li>
          ))}
        </ul>
        {tree?.truncated && <p className="muted">{t('Showing the first 1000 entries.')}</p>}
      </section>
      {preview && <Preview projectId={projectId} target={preview} onClose={() => setPreview(null)} onDownload={() => download(preview)} onError={onError} />}
    </>
  )
}

const TEXTY = /^(text\/|application\/(json|x-ndjson|xml))/

function Preview({ projectId, target, onClose, onDownload, onError }: { projectId: string; target: Target; onClose: () => void; onDownload: () => void; onError: (e: string) => void }) {
  const [link, setLink] = useState<FileLink | null>(null)
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    fileLink(projectId, target).then(async l => {
      setLink(l)
      if (TEXTY.test(l.mime) && l.size <= 2_000_000) setText(await (await fetch(l.url)).text())
    }, e => onError(String(e)))
  }, [projectId, JSON.stringify(target)])
  const m = link?.mime ?? ''
  return (
    <div className="modal" role="dialog" data-testid="preview-modal" onClick={onClose}>
      <div className="modal-body" onClick={e => e.stopPropagation()}>
        <header>
          <strong>{link?.name ?? '…'}</strong> {link && <span className="muted">{fmtSize(link.size)}</span>}
          <span className="spacer" />
          {link && <a href={link.url} target="_blank" rel="noreferrer" data-testid="open-new-tab">{t('Open')}</a>}
          <button onClick={onDownload}>{t('Download')}</button>
          <button onClick={onClose} data-testid="close-preview">✕</button>
        </header>
        <div className="modal-content">
          {!link ? <p className="muted">{t('Loading…')}</p>
            : m.startsWith('image/') ? <img src={link.url} alt={link.name} data-testid="preview-image" />
            : m.startsWith('video/') ? <video src={link.url} controls playsInline data-testid="preview-video" />
            : m.startsWith('audio/') ? <audio src={link.url} controls />
            : m === 'application/pdf' ? <iframe src={link.url} title={link.name} data-testid="preview-pdf" />
            : text !== null ? <pre className="file-text" data-testid="preview-text">{text}</pre>
            : <p className="muted">{t('No inline preview for {m}{s}. Use Download or Open.', { m: m || t('this type'), s: link.size > 2_000_000 ? t(' at this size') : '' })}</p>}
        </div>
      </div>
    </div>
  )
}
