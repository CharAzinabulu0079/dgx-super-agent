/** System → Remote access (addresses, bind, QR for the phone) and Notifications (ntfy / Bark / Telegram). */
import { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { api } from './api.ts'
import { t, tx } from './i18n.ts'

interface Addr { address: string; iface: string; kind: 'loopback' | 'vpn' | 'lan' | 'all' | 'other'; link?: string }
interface RemoteState { host?: string; port?: number; addresses: Addr[]; service: boolean; stableToken: boolean; supervised: boolean }

/** QR as inline SVG, generated in the browser (the link never leaves this page). */
function Qr({ text }: { text: string }) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  return <div className="qr" data-testid="qr" dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />
}

export function Remote({ onError }: { onError: (e: string) => void }) {
  const [r, setR] = useState<RemoteState | null>(null)
  const [pick, setPick] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const load = () => api<RemoteState>('GET', '/api/system/remote').then(x => { setR(x); setPick(x.host ?? '127.0.0.1') }, e => onError(String(e)))
  useEffect(() => { void load() }, [])
  if (!r) return <p className="muted">{t('Loading…')}</p>
  const kindLabel = (k: Addr['kind']) => t(`addr:${k}`)
  const apply = () => {
    if (pick !== '127.0.0.1' && !confirm(t('Listen on {a}? Every request then needs the token. Use it only inside WireGuard / your home network.', { a: pick }))) return
    api<{ restarting: boolean; port: number }>('POST', '/api/system/remote', { host: pick }).then(x => {
      const target = pick === '0.0.0.0' ? location.hostname : pick
      setNote(t('Restarting on {a}. Open: {u}', { a: pick, u: `http://${target}:${x.port}/` }))
      if (pick !== '0.0.0.0' && pick !== location.hostname) setTimeout(() => { location.href = `http://${target}:${x.port}/` }, 6000)
      else setTimeout(() => location.reload(), 6000)
    }, e => onError(String(e)))
  }
  return (
    <div data-testid="remote">
      <p>{t('Listening on')} <code>{r.host}:{r.port}</code> {r.host === '127.0.0.1' ? <span className="muted">{t('— only this machine can open it')}</span> : <span className="muted">{t('— the token is required for every request')}</span>}</p>
      <h4>{t('Addresses of this machine')}</h4>
      <ul className="gate-list">{r.addresses.map(a => (
        <li key={a.address} data-testid={`addr-${a.address}`}>
          <label><input type="radio" name="bind" checked={pick === a.address} onChange={() => setPick(a.address)} /> <code>{a.address}</code> <span className="badge">{kindLabel(a.kind)}</span> <span className="muted">{a.iface !== '*' ? a.iface : ''}</span></label>
          {a.link && a.kind !== 'loopback' && <button className="small" onClick={() => setShown(shown === a.address ? null : a.address)} data-testid={`qr-${a.address}`}>{t('Phone QR')}</button>}
          {a.link && shown === a.address && <div className="qr-box"><Qr text={a.link} /><div className="muted">{t('Scan with the phone (inside the same network / WireGuard). The code contains your access token — do not share a screenshot.')}</div></div>}
        </li>
      ))}</ul>
      {!r.stableToken && <div className="warn-box">{t('No stable token: the phone link changes on every restart. `sa service install` writes one.')}</div>}
      {r.service && r.supervised
        ? <div className="row"><button className="primary" disabled={pick === r.host} onClick={apply} data-testid="remote-apply">{t('Switch and restart')}</button></div>
        : <p className="muted">{t('Not running as a service: restart it yourself with')} <code>sa serve --host {pick}</code></p>}
      {note && <div className="ok-box">{note}</div>}
      <p className="muted">{t('Tip: for a phone outside home, set up WireGuard on the DGX and pick its address (usually wg0 / 10.x).')}</p>
    </div>
  )
}

type Channel = { kind: 'ntfy' | 'bark' | 'telegram'; url?: string; token?: string; botToken?: string; chatId?: string; secret?: boolean }
interface NotifyState { channels: Channel[]; events: Record<'done' | 'stuck' | 'decision', boolean>; lang: 'zh' | 'en' }

export function Notify({ onError }: { onError: (e: string) => void }) {
  const [c, setC] = useState<NotifyState | null>(null)
  const [results, setResults] = useState<Array<{ kind: string; ok: boolean; detail: string }> | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { api<NotifyState>('GET', '/api/system/notify').then(setC, e => onError(String(e))) }, [])
  if (!c) return <p className="muted">{t('Loading…')}</p>
  const set = (i: number, patch: Partial<Channel>) => { setSaved(false); setC({ ...c, channels: c.channels.map((x, j) => (j === i ? { ...x, ...patch } : x)) }) }
  const add = (kind: Channel['kind']) => { setSaved(false); setC({ ...c, channels: [...c.channels, { kind, url: kind === 'ntfy' ? 'https://ntfy.sh/' : kind === 'bark' ? 'https://api.day.app/' : undefined }] }) }
  const save = () => api<NotifyState>('POST', '/api/system/notify', c).then(x => { setC(x); setSaved(true) }, e => onError(String(e)))
  const test = () => api<{ results: typeof results }>('POST', '/api/system/notify/test', {}).then(x => setResults(x.results), e => onError(String(e)))
  return (
    <div data-testid="notify">
      <p className="muted">{t('Get a message on your phone when work is done, stuck, or needs your decision — even with the page closed.')}</p>
      <h4>{t('Notify me when')}</h4>
      <div className="row">{(['decision', 'stuck', 'done'] as const).map(e => (
        <label key={e}><input type="checkbox" checked={c.events[e]} onChange={x => { setSaved(false); setC({ ...c, events: { ...c.events, [e]: x.target.checked } }) }} data-testid={`notify-${e}`} /> {t(`notify:${e}`)}</label>
      ))}</div>
      <h4>{t('Channels')}</h4>
      {c.channels.map((ch, i) => (
        <div key={i} className="card wizard" data-testid={`channel-${i}`}>
          <div className="row"><strong>{t(`channel:${ch.kind}`)}</strong><span className="spacer" /><button className="small danger" onClick={() => { setSaved(false); setC({ ...c, channels: c.channels.filter((_, j) => j !== i) }) }}>{t('Remove')}</button></div>
          {ch.kind === 'ntfy' && <>
            <div className="field"><div className="field-label">{t('Topic URL')}</div><input className="mono" value={ch.url ?? ''} onChange={e => set(i, { url: e.target.value })} placeholder="https://ntfy.sh/my-secret-topic" data-testid="ntfy-url" /></div>
            <div className="field"><div className="field-label">{t('Access token (optional)')}</div><input type="password" value={ch.token ?? ''} placeholder={ch.secret ? t('(saved — leave empty to keep)') : ''} onChange={e => set(i, { token: e.target.value })} /></div>
            <p className="muted">{t('Install the ntfy app, subscribe to the same topic. Use a long random topic name: anyone who knows it can read it.')}</p>
          </>}
          {ch.kind === 'bark' && <>
            <div className="field"><div className="field-label">{t('Bark URL')}</div><input className="mono" value={ch.url ?? ''} onChange={e => set(i, { url: e.target.value })} placeholder="https://api.day.app/yourkey" /></div>
            <p className="muted">{t('Copy the URL shown in the Bark app (iOS).')}</p>
          </>}
          {ch.kind === 'telegram' && <>
            <div className="field"><div className="field-label">{t('Bot token')}</div><input type="password" value={ch.botToken ?? ''} placeholder={ch.secret ? t('(saved — leave empty to keep)') : '123456:ABC…'} onChange={e => set(i, { botToken: e.target.value })} /></div>
            <div className="field"><div className="field-label">{t('Chat id')}</div><input value={ch.chatId ?? ''} onChange={e => set(i, { chatId: e.target.value })} /></div>
            <p className="muted">{t('Create a bot with @BotFather, send it a message, then get your chat id from @userinfobot.')}</p>
          </>}
        </div>
      ))}
      <div className="row"><button className="small" onClick={() => add('ntfy')} data-testid="add-ntfy">＋ ntfy</button><button className="small" onClick={() => add('bark')}>＋ Bark</button><button className="small" onClick={() => add('telegram')}>＋ Telegram</button></div>
      <div className="field"><div className="field-label">{t('Language')}</div><select value={c.lang} onChange={e => { setSaved(false); setC({ ...c, lang: e.target.value as 'zh' | 'en' }) }}><option value="zh">中文</option><option value="en">English</option></select></div>
      <div className="row-end"><button disabled={!saved || !c.channels.length} onClick={test} data-testid="notify-test">{t('Send a test')}</button><button className="primary" onClick={save} data-testid="notify-save">{t('Save')}</button></div>
      {saved && <div className="ok-box">{t('Saved.')}</div>}
      {results && <ul className="checks">{results.map((x, i) => <li key={i} className={`check ${x.ok ? 'ok' : 'fail'}`}>{x.ok ? '✓' : '✕'} {x.kind}: {tx(x.detail)}</li>)}</ul>}
    </div>
  )
}
