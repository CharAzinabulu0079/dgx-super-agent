/** Appearance settings: style, theme, accent, card opacity, background (incl. Digital Human page). */
import { useState } from 'react'
import { upload, type Appearance, type AppearanceView } from './api.ts'
import { GRADIENTS } from './theme.ts'
import { t } from './i18n.ts'

const ACCENTS = ['#d97757', '#c96442', '#6366f1', '#0ea5e9', '#10b981', '#e11d48', '#a855f7', '#737373']

export function AppearancePanel({ view, current, isLocal, onSave, onReload, onClose, onError }: {
  view: AppearanceView | null; current: Appearance; isLocal: boolean
  onSave: (a: Appearance, scope: 'all' | 'device') => Promise<void>; onReload: () => void; onClose: () => void; onError: (e: string) => void
}) {
  const [a, setA] = useState<Appearance>(current)
  const [scope, setScope] = useState<'all' | 'device'>(isLocal ? 'device' : 'all')
  const [busy, setBusy] = useState(false)
  const bg = a.background
  const setBg = (b: Partial<Appearance['background']>) => setA({ ...a, background: { ...a.background, ...b } })
  const save = () => { setBusy(true); onSave(a, scope).then(onClose, e => onError(String(e))).finally(() => setBusy(false)) }
  const onFile = (f?: File) => {
    if (!f) return
    setBusy(true)
    upload<{ id: string; mime: string }>('/api/ui/backgrounds', f).then(r => { onReload(); setBg({ kind: r.mime.startsWith('video/') ? 'video' : 'image', assetId: r.id }) }, e => onError(String(e))).finally(() => setBusy(false))
  }
  return (
    <div className="modal" role="dialog" data-testid="appearance" onClick={onClose}>
      <div className="modal-body" onClick={e => e.stopPropagation()}>
        <header><strong>{t('Appearance')}</strong><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></header>
        <div className="modal-content settings">
          <Field label={t('Style')}>
            <Seg value={a.style} options={[['solid', t('Clean')], ['glass', t('Glass')]]} onChange={v => setA({ ...a, style: v as Appearance['style'] })} testId="style" />
          </Field>
          <Field label={t('Theme')}>
            <Seg value={a.theme} options={[['auto', t('Auto')], ['light', t('Light')], ['dark', t('Dark')]]} onChange={v => setA({ ...a, theme: v as Appearance['theme'] })} testId="theme" />
          </Field>
          <Field label={t('Accent')}>
            <div className="swatches">
              {ACCENTS.map(c => <button key={c} className={`swatch ${a.accent === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setA({ ...a, accent: c })} />)}
              <input type="color" value={a.accent} onChange={e => setA({ ...a, accent: e.target.value })} aria-label="custom accent" />
            </div>
          </Field>
          <Field label={t('Background')}>
            <Seg value={bg.kind} options={[['none', t('None')], ['gradient', t('Gradient')], ['image', t('Image / video')], ['embed', t('Web page / Digital Human')]]}
              onChange={v => setBg({ kind: v === 'image' && view?.assets[0] ? (view.assets[0].mime.startsWith('video/') ? 'video' : 'image') : v as Appearance['background']['kind'], ...(v === 'image' && view?.assets[0] ? { assetId: view.assets[0].id } : {}) })} testId="bg-kind" />
          </Field>
          {bg.kind === 'gradient' && (
            <div className="presets">{Object.entries(GRADIENTS).map(([k, g]) => <button key={k} className={`preset ${bg.preset === k ? 'on' : ''}`} style={{ background: g }} onClick={() => setBg({ preset: k })} data-testid={`preset-${k}`}><span>{k}</span></button>)}</div>
          )}
          {(bg.kind === 'image' || bg.kind === 'video' || (bg.kind as string) === 'image') && (
            <div className="assets">
              <label className="upload">{t('＋ Upload image or video')}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm" onChange={e => onFile(e.target.files?.[0])} data-testid="bg-upload" /></label>
              {view?.assets.map(x => (
                <button key={x.id} className={`asset ${bg.assetId === x.id ? 'on' : ''}`} onClick={() => setBg({ kind: x.mime.startsWith('video/') ? 'video' : 'image', assetId: x.id })} data-testid={`asset-${x.id}`}>
                  {x.mime.startsWith('video/') ? <video src={x.url} muted playsInline /> : <img src={x.url} alt="" />}
                </button>
              ))}
            </div>
          )}
          {bg.kind === 'embed' && (
            <div className="embed-settings">
              <input placeholder="http://10.8.0.1:8080/avatar" value={bg.url ?? ''} onChange={e => setBg({ url: e.target.value })} data-testid="embed-url" />
              <label><input type="checkbox" checked={!!bg.interactive} onChange={e => setBg({ interactive: e.target.checked })} /> {t('Interactive (clicks reach the page where the UI is transparent)')}</label>
              <label><input type="checkbox" checked={!!bg.allowMedia} onChange={e => setBg({ allowMedia: e.target.checked })} /> {t('Allow microphone / camera / autoplay (voice)')}</label>
              <label><input type="checkbox" checked={!!bg.allowChat} onChange={e => setBg({ allowChat: e.target.checked })} data-testid="embed-chat" /> {t('Allow chat — the page may send what you say to the Chief (only for pages you trust)')}</label>
              <p className="muted">{t('The page receives live activity and Chief messages — protocol: docs/DIGITAL_HUMAN_BACKGROUND.md.')}</p>
            </div>
          )}
          {bg.kind !== 'none' && <>
            <Field label={t('Blur {n}px', { n: bg.blur })}><input type="range" min={0} max={40} value={bg.blur} onChange={e => setBg({ blur: Number(e.target.value) })} /></Field>
            <Field label={t('Dim {n}%', { n: Math.round(bg.dim * 100) })}><input type="range" min={0} max={85} value={Math.round(bg.dim * 100)} onChange={e => setBg({ dim: Number(e.target.value) / 100 })} /></Field>
          </>}
          {a.style === 'glass' && <Field label={t('Card opacity {n}%', { n: Math.round(a.panelOpacity * 100) })}><input type="range" min={35} max={100} value={Math.round(a.panelOpacity * 100)} onChange={e => setA({ ...a, panelOpacity: Number(e.target.value) / 100 })} /></Field>}
          <Field label={t('Apply to')}>
            <Seg value={scope} options={[['all', t('All devices')], ['device', t('This device only')]]} onChange={v => setScope(v as 'all' | 'device')} testId="scope" />
          </Field>
          <div className="row-end">
            <button onClick={onClose}>{t('Cancel')}</button>
            <button className="primary" disabled={busy} onClick={save} data-testid="appearance-save">{t('Save')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field"><div className="field-label">{label}</div><div>{children}</div></div>
}

function Seg({ value, options, onChange, testId }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void; testId: string }) {
  return <div className="seg" role="radiogroup">{options.map(([v, l]) => <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)} data-testid={`${testId}-${v}`}>{l}</button>)}</div>
}
