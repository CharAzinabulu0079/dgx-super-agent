/**
 * UI appearance (shared across devices; a device may override locally in the UI):
 * style, theme, accent, panel opacity and a background layer.
 *
 * Background kinds: none | gradient (preset) | image / video (uploaded asset) |
 * embed — any web page shown behind the UI, e.g. the future Web Digital Human
 * (Freeze §12.2). The UI talks to an embed only through the postMessage bridge
 * documented in docs/DIGITAL_HUMAN_BACKGROUND.md.
 *
 * Uploads are validated by magic bytes (raster images, MP4/WebM only — never SVG or
 * HTML, which could carry script) and stored under `$SUPERAGENT_HOME/ui/backgrounds/`.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const GRADIENT_PRESETS = ['aurora', 'dusk', 'ocean', 'forest', 'graphite', 'sunrise'] as const
export type BackgroundKind = 'none' | 'gradient' | 'image' | 'video' | 'embed'

export interface Appearance {
  readonly style: 'glass' | 'solid'
  readonly theme: 'auto' | 'light' | 'dark'
  readonly accent: string
  /** Card opacity over the background (0.35–1). */
  readonly panelOpacity: number
  readonly background: {
    readonly kind: BackgroundKind
    readonly preset?: (typeof GRADIENT_PRESETS)[number]
    /** Uploaded asset id (image / video). */
    readonly assetId?: string
    /** Embed page URL (http/https), e.g. the Web Digital Human. */
    readonly url?: string
    /** Blur in px (0–40) and darkening (0–0.85) applied over the background. */
    readonly blur: number
    readonly dim: number
    /** Embed only: let pointer events reach the embed where the UI is transparent. */
    readonly interactive?: boolean
    /** Embed only: accept `{type:'chat'}` messages from the embed and send them to the Chief as the human. */
    readonly allowChat?: boolean
    /** Embed only: grant camera/microphone/autoplay to the embed (e.g. voice for a digital human). */
    readonly allowMedia?: boolean
  }
}

/** Default: the calm, solid "terminal-app" look (warm neutrals, one accent), no background. */
export const DEFAULT_APPEARANCE: Appearance = {
  style: 'solid', theme: 'auto', accent: '#d97757', panelOpacity: 0.72,
  background: { kind: 'none', blur: 0, dim: 0 },
}

export class AppearanceError extends Error {}

const num = (v: unknown, min: number, max: number, what: string, dflt: number): number => {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new AppearanceError(`${what}: expected a number ${min}–${max}`)
  return v
}
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string, dflt: T): T => {
  if (v === undefined) return dflt
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new AppearanceError(`${what}: expected ${allowed.join('|')}`)
  return v as T
}

/** Validate untrusted appearance JSON (missing fields take defaults). */
export function parseAppearance(value: unknown, assetExists: (id: string) => boolean = () => true): Appearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppearanceError('expected an object')
  const o = value as Record<string, unknown>
  const accent = o.accent === undefined ? DEFAULT_APPEARANCE.accent : o.accent
  if (typeof accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(accent)) throw new AppearanceError('accent: expected #rrggbb')
  const b = (o.background ?? {}) as Record<string, unknown>
  if (typeof b !== 'object' || Array.isArray(b)) throw new AppearanceError('background: expected an object')
  const kind = oneOf(b.kind, ['none', 'gradient', 'image', 'video', 'embed'] as const, 'background.kind', 'none')
  const background: Appearance['background'] = {
    kind,
    blur: num(b.blur, 0, 40, 'background.blur', 0),
    dim: num(b.dim, 0, 0.85, 'background.dim', 0),
    ...(kind === 'gradient' ? { preset: oneOf(b.preset, GRADIENT_PRESETS, 'background.preset', 'aurora') } : {}),
    ...(kind === 'image' || kind === 'video' ? (() => {
      if (typeof b.assetId !== 'string' || !/^bg_[0-9a-f]{16}$/.test(b.assetId) || !assetExists(b.assetId)) throw new AppearanceError('background.assetId: upload a background first')
      return { assetId: b.assetId }
    })() : {}),
    ...(kind === 'embed' ? (() => {
      let u: URL
      try {
        u = new URL(String(b.url ?? ''))
      } catch (invalid) {
        void invalid
        throw new AppearanceError('background.url: expected an http(s) URL')
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppearanceError('background.url: only http(s) pages can be embedded')
      if (u.username || u.password) throw new AppearanceError('background.url: credentials in the URL are not allowed')
      return { url: u.toString(), interactive: b.interactive === true, allowChat: b.allowChat === true, allowMedia: b.allowMedia === true }
    })() : {}),
  }
  return {
    style: oneOf(o.style, ['glass', 'solid'] as const, 'style', DEFAULT_APPEARANCE.style),
    theme: oneOf(o.theme, ['auto', 'light', 'dark'] as const, 'theme', DEFAULT_APPEARANCE.theme),
    accent: accent.toLowerCase(),
    panelOpacity: num(o.panelOpacity, 0.35, 1, 'panelOpacity', DEFAULT_APPEARANCE.panelOpacity),
    background,
  }
}

const uiDir = (home: string) => join(home, 'ui')
const bgDir = (home: string) => join(uiDir(home), 'backgrounds')

export function loadAppearance(home: string): Appearance {
  const file = join(uiDir(home), 'appearance.json')
  if (!existsSync(file)) return DEFAULT_APPEARANCE
  try {
    return parseAppearance(JSON.parse(readFileSync(file, 'utf8')), id => !!findBackground(home, id))
  } catch (invalid) {
    void invalid // an unreadable/stale appearance must not break the UI
    return DEFAULT_APPEARANCE
  }
}

export function saveAppearance(home: string, value: unknown): Appearance {
  const a = parseAppearance(value, id => !!findBackground(home, id))
  mkdirSync(uiDir(home), { recursive: true })
  const file = join(uiDir(home), 'appearance.json')
  writeFileSync(`${file}.tmp`, `${JSON.stringify(a, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
  return a
}

export const MAX_BACKGROUND_BYTES = { image: 25 * 1024 * 1024, video: 150 * 1024 * 1024 }

const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', ext: 'png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: b => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { mime: 'image/webp', ext: 'webp', test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/avif', ext: 'avif', test: b => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'video/mp4', ext: 'mp4', test: b => b.subarray(4, 8).toString('latin1') === 'ftyp' && !/^avi[fs]/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'video/webm', ext: 'webm', test: b => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
]

export interface BackgroundAsset { readonly id: string; readonly mime: string; readonly size: number; readonly file: string }

/** Store an uploaded background after checking its bytes (the declared type is not trusted). */
export function saveBackground(home: string, data: Buffer): BackgroundAsset {
  const sig = SIGNATURES.find(s => s.test(data))
  if (!sig) throw new AppearanceError('unsupported background: use PNG, JPEG, GIF, WebP, AVIF, MP4 or WebM')
  const limit = sig.mime.startsWith('video/') ? MAX_BACKGROUND_BYTES.video : MAX_BACKGROUND_BYTES.image
  if (data.length > limit) throw new AppearanceError(`background too large (${data.length} bytes; max ${limit})`)
  mkdirSync(bgDir(home), { recursive: true })
  const id = `bg_${randomBytes(8).toString('hex')}`
  const file = join(bgDir(home), `${id}.${sig.ext}`)
  writeFileSync(file, data)
  return { id, mime: sig.mime, size: data.length, file }
}

export function listBackgrounds(home: string): BackgroundAsset[] {
  if (!existsSync(bgDir(home))) return []
  return readdirSync(bgDir(home)).flatMap(f => {
    const m = /^(bg_[0-9a-f]{16})\.(\w+)$/.exec(f)
    const sig = m && SIGNATURES.find(s => s.ext === m[2])
    return m && sig ? [{ id: m[1]!, mime: sig.mime, size: statSync(join(bgDir(home), f)).size, file: join(bgDir(home), f) }] : []
  })
}

export function findBackground(home: string, id: string): BackgroundAsset | undefined {
  return /^bg_[0-9a-f]{16}$/.test(id) ? listBackgrounds(home).find(a => a.id === id) : undefined
}

export function deleteBackground(home: string, id: string): void {
  const a = findBackground(home, id)
  if (!a) throw new AppearanceError(`background ${id} not found`)
  rmSync(a.file, { force: true })
}
