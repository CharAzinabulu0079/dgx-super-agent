/**
 * Shared files: agents (Worker / Chief) or the human hand a project file to the human
 * for preview or download. The file is validated against the project tree and copied
 * into the store, so later edits (or deletion) in the worktree do not change what was
 * shared, and serving never reads a Worker-controlled path again.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { newId, now, type SharedFile } from '@superagent/contracts'
import type { StateStore } from './store.ts'

export const MAX_SHARED_FILE_BYTES = 200 * 1024 * 1024

export class ShareError extends Error {}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain', '.xml': 'application/xml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
  '.py': 'text/plain', '.sh': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain', '.java': 'text/plain', '.c': 'text/plain', '.h': 'text/plain', '.cpp': 'text/plain', '.sql': 'text/plain', '.diff': 'text/plain', '.patch': 'text/plain',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tgz': 'application/gzip', '.tar': 'application/x-tar',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeOf(name: string): string {
  const ext = extname(name).toLowerCase()
  if (MIME[ext]) return MIME[ext]!
  if (/^(readme|license|makefile|dockerfile)$/i.test(basename(name))) return 'text/plain'
  return 'application/octet-stream'
}

/**
 * Resolve a path the caller wants to share or read. It must be a regular file inside
 * the project (after resolving symlinks), outside `.git` and outside the SuperAgent
 * home (state, secrets, held-out tests).
 * @returns absolute real path and the project-relative path.
 */
export function resolveProjectFile(projectRoot: string, path: string, home: string, opts: { allowDir?: boolean } = {}): { abs: string; rel: string; isDir: boolean } {
  const root = realpathSync(projectRoot)
  const candidate = isAbsolute(path) ? path : join(projectRoot, path)
  if (!existsSync(candidate)) throw new ShareError(`not found: ${path}`)
  const abs = realpathSync(candidate)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ShareError(`outside the project: ${path}`)
  const realHome = existsSync(home) ? realpathSync(home) : resolve(home)
  if (abs === realHome || abs.startsWith(realHome + sep)) throw new ShareError('SuperAgent state is not shareable')
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) throw new ShareError('.git is not shareable')
  const st = statSync(abs)
  if (st.isDirectory()) {
    if (!opts.allowDir) throw new ShareError(`is a directory: ${path}`)
    return { abs, rel, isDir: true }
  }
  if (!st.isFile()) throw new ShareError(`not a regular file: ${path}`)
  return { abs, rel, isDir: false }
}

/** Copy a project file into the store and record it; emits `file/shared`. */
export function shareFile(store: StateStore, projectId: string, path: string, from: SharedFile['from'], note?: string): SharedFile {
  const project = store.requireProject(projectId)
  const { abs, rel } = resolveProjectFile(project.root, path, store.home)
  const size = statSync(abs).size
  if (size > MAX_SHARED_FILE_BYTES) throw new ShareError(`too large (${size} bytes; max ${MAX_SHARED_FILE_BYTES})`)
  const id = newId('file')
  const name = basename(abs).replace(/[^\w.@+-]+/g, '_') || 'file'
  const dir = join(store.home, 'projects', projectId, 'files', id)
  mkdirSync(dir, { recursive: true })
  copyFileSync(abs, join(dir, name))
  const record: SharedFile = {
    id, projectId, name, size, mime: mimeOf(name), source: rel.split(sep).join('/'),
    note: note?.slice(0, 1000) || undefined, from, createdAt: now(),
  }
  store.putRecord('files', record)
  store.emitTyped('file/shared', projectId, { fileId: id, name, size, mime: record.mime, note: record.note ?? null, from: from.role }, { taskId: from.taskId, workerId: from.workerId })
  return record
}

/** Absolute path of a shared file's stored copy (never a worktree path). */
export function sharedFilePath(store: StateStore, file: SharedFile): string {
  const p = join(store.home, 'projects', file.projectId, 'files', file.id, file.name)
  if (lstatSync(p).isSymbolicLink()) throw new ShareError('stored copy is a link')
  return p
}
