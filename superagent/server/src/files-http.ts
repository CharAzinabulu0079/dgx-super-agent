/**
 * File preview/download for browsers and phones.
 *
 * Downloads use short-lived HMAC-signed links (`/dl/<token>`) minted by an authenticated
 * API call: a phone browser can open or save them without an Authorization header, and
 * the long-lived human token never appears in a download URL or browser history.
 *
 * Responses are hardened for untrusted content (agent-produced files): `nosniff`,
 * no referrer, and active formats (HTML, SVG, XML) are served under `CSP: sandbox` so
 * a script inside a shared file cannot read the UI's token from this origin.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, createReadStream, fstatSync, openSync, readdirSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream'
import { mimeOf, resolveProjectFile } from '@superagent/project-state'

export interface LinkPayload {
  /** project id */
  readonly p: string
  /** shared file id, or … */
  readonly f?: string
  /** … a project-relative path */
  readonly path?: string
  /** 1 = download (attachment), 0 = inline preview */
  readonly d: 0 | 1
  /** `bg` = a UI background asset (then `f` is its id and `p` is unused) */
  readonly k?: 'bg' | 'backup'
  /** expiry, ms since epoch */
  readonly e: number
}

export const LINK_TTL_MS = 15 * 60_000

export class LinkSigner {
  private readonly secret = randomBytes(32)

  sign(payload: Omit<LinkPayload, 'e'>, ttlMs = LINK_TTL_MS): { token: string; expiresAt: string } {
    const e = Date.now() + ttlMs
    const body = Buffer.from(JSON.stringify({ ...payload, e })).toString('base64url')
    return { token: `${body}.${this.mac(body)}`, expiresAt: new Date(e).toISOString() }
  }

  verify(token: string): LinkPayload | undefined {
    const [body, mac] = token.split('.')
    if (!body || !mac) return undefined
    const want = Buffer.from(this.mac(body))
    const got = Buffer.from(mac)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkPayload
      return typeof p.e === 'number' && p.e > Date.now() ? p : undefined
    } catch (invalid) {
      void invalid
      return undefined
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }
}

const ACTIVE = /^(text\/html|image\/svg\+xml|application\/xml|text\/xml)/

/** Stream a file with safe headers and single-range support (needed for video on iOS). */
export function sendFile(req: IncomingMessage, res: ServerResponse, abs: string, name: string, download: boolean, mime = mimeOf(name)): void {
  // Open first: an unreadable, vanished or swapped file fails here as an ordinary error
  // response, and the size comes from the very file that is streamed.
  const fd = openSync(abs, 'r')
  let size: number
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(`not a regular file: ${name}`)
    size = st.size
  } catch (error) {
    closeSync(fd)
    throw error
  }
  const stream = (opts: { start?: number; end?: number } = {}): void => {
    if (req.method === 'HEAD') { closeSync(fd); res.end(); return }
    // A read error mid-response ends the connection; it must never become an uncaught error.
    pipeline(createReadStream('', { fd, ...opts }), res, error => { if (error) res.destroy() })
  }
  const type = mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml' ? `${mime}; charset=utf-8` : mime
  const headers: Record<string, string> = {
    'content-type': download ? 'application/octet-stream' : type,
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, max-age=300',
    'accept-ranges': 'bytes',
  }
  if (ACTIVE.test(mime)) headers['content-security-policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(size - 1, end)
    if (start > end || start >= size) {
      closeSync(fd)
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
    stream({ start, end })
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  stream()
}

export interface TreeEntry { readonly name: string; readonly path: string; readonly type: 'dir' | 'file'; readonly size?: number; readonly mime?: string }

/** List one directory of a project (read-only browser); `.git` is hidden, symlinks are resolved and must stay inside. */
export function listProjectDir(projectRoot: string, rel: string, home: string, limit = 1000): { path: string; entries: TreeEntry[]; truncated: boolean } {
  const dir = resolveProjectFile(projectRoot, rel || '.', home, { allowDir: true })
  if (!dir.isDir) throw new Error(`not a directory: ${rel}`)
  const names = readdirSync(dir.abs).filter(n => n !== '.git').sort((a, b) => a.localeCompare(b))
  const entries: TreeEntry[] = []
  for (const name of names.slice(0, limit)) {
    const childRel = dir.rel ? `${dir.rel}/${name}` : name
    try {
      const r = resolveProjectFile(projectRoot, childRel, home, { allowDir: true })
      entries.push(r.isDir ? { name, path: childRel, type: 'dir' } : { name, path: childRel, type: 'file', size: statSync(r.abs).size, mime: mimeOf(name) })
    } catch (notListable) {
      void notListable // links leaving the project, sockets, state paths: not shown
    }
  }
  entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1))
  return { path: dir.rel.split('\\').join('/'), entries, truncated: names.length > limit }
}
