/** Appearance: shared settings from the server, optionally overridden on this device. */
import { useCallback, useEffect, useState } from 'react'
import { api, type Appearance, type AppearanceView } from './api.ts'

const LOCAL_KEY = 'superagent-appearance-local'

export const DEFAULT_APPEARANCE: Appearance = { style: 'solid', theme: 'auto', accent: '#d97757', panelOpacity: 0.72, background: { kind: 'none', blur: 0, dim: 0 } }

export const GRADIENTS: Record<string, string> = {
  aurora: 'radial-gradient(1200px 700px at 10% 10%, #7c3aed55, transparent 60%), radial-gradient(900px 600px at 90% 20%, #06b6d455, transparent 60%), radial-gradient(900px 700px at 50% 100%, #22c55e44, transparent 60%), linear-gradient(160deg, #0f172a, #1e1b4b)',
  dusk: 'linear-gradient(160deg, #2b1a3d 0%, #7a3b52 45%, #e0875a 100%)',
  ocean: 'linear-gradient(160deg, #0b2447 0%, #19376d 45%, #3aa6b9 100%)',
  forest: 'linear-gradient(160deg, #0f2419 0%, #1f4d3a 50%, #8fbf8f 100%)',
  graphite: 'linear-gradient(160deg, #1f1e1d 0%, #3a3936 60%, #5b5953 100%)',
  sunrise: 'linear-gradient(160deg, #fdf2e9 0%, #f7c9a9 45%, #d97757 100%)',
}

function readLocal(): Appearance | null {
  try {
    const v = localStorage.getItem(LOCAL_KEY)
    return v ? (JSON.parse(v) as Appearance) : null
  } catch (unavailable) {
    void unavailable
    return null
  }
}

export function useAppearance(onError: (e: string) => void) {
  const [view, setView] = useState<AppearanceView | null>(null)
  const [local, setLocal] = useState<Appearance | null>(readLocal)
  const load = useCallback(() => api<AppearanceView>('GET', '/api/ui/appearance').then(setView, e => onError(String(e))), [onError])
  useEffect(() => { void load() }, [])
  const effective: Appearance = local ?? view?.appearance ?? DEFAULT_APPEARANCE
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const resolvedTheme: 'light' | 'dark' = effective.theme === 'auto' ? (dark ? 'dark' : 'light') : effective.theme
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.dataset.style = effective.style
    root.dataset.bg = effective.background.kind
    root.style.setProperty('--accent', effective.accent)
    root.style.setProperty('--panel-alpha', String(effective.style === 'glass' ? effective.panelOpacity : 1))
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme === 'dark' ? '#262624' : '#faf9f5')
  }, [resolvedTheme, effective.style, effective.accent, effective.panelOpacity, effective.background.kind])
  /** Save for all devices (server) or only this one (localStorage). */
  const save = async (next: Appearance, scope: 'all' | 'device'): Promise<void> => {
    if (scope === 'device') {
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(next)) } catch (unavailable) { void unavailable }
      setLocal(next)
      return
    }
    const v = await api<AppearanceView>('POST', '/api/ui/appearance', next)
    try { localStorage.removeItem(LOCAL_KEY) } catch (unavailable) { void unavailable }
    setLocal(null)
    setView(v)
  }
  const assetUrl = (id?: string) => (id ? view?.assets.find(a => a.id === id)?.url ?? (view?.appearance.background.assetId === id ? view?.backgroundUrl ?? undefined : undefined) : undefined)
  return { view, effective, resolvedTheme, isLocal: local !== null, save, reload: load, assetUrl }
}
