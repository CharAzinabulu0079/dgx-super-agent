/** Thin client over the SuperAgent Realtime/API gateway. */

export interface ModelRef { provider: string; model: string }
export interface Attempt { n: number; strategy: string; model: ModelRef; verdict?: 'PASS' | 'FAIL'; receiptId?: string; workerId: string }
export interface Task {
  id: string; goalId: string; title: string; instructions: string; state: string; running?: boolean
  attempts: Attempt[]; policy: { model: { worker: ModelRef; escalation?: ModelRef; reviewer?: ModelRef }; maxAttempts: number }
  steer?: string; humanGateId?: string; review?: boolean; reviews?: Array<{ attempt: number; approve: boolean; comments: string; reviewer: string }>
}
export interface Goal { id: string; objective: string; status: string; taskIds: string[]; blocker?: string; createdAt: string; runRequested?: boolean; request?: string }
export interface ActivityLine { seq: number; ts: string; taskId?: string; tone: 'info' | 'good' | 'bad' | 'attention'; text: string }
export interface Project { id: string; name: string; root: string; goal?: Goal | null; openHumanGates?: number; defaultGates?: Array<{ id: string; kind: string; heldOut?: unknown }> }
export interface WorkerReport { kind: string; current_state: string; progress: number; changed_modules: string[]; verification_result: string; summary: string; human_required: boolean; blocker: string | null; at?: string }
export interface Worker { id: string; taskId: string; attempt: number; status: string; model: ModelRef; activeModules: string[]; lastReport?: WorkerReport; startedAt: string; executor: string }
export interface HumanGate { id: string; taskId?: string; reason: string; detail: string; status: string; resolution?: string; actions?: Array<{ fingerprint: string; summary: string; category: string; rule: string }> }
export interface ProjectDetail { project: Project; goal: Goal | null; goals: Goal[]; tasks: Task[]; workers: Worker[]; humanGates: HumanGate[]; report: string; runningGoals: string[] }
export interface GraphNode {
  id: string; label: string; layer?: string; root: string; status: string[]; files: number; declared: boolean; protected: boolean
  dependsOn: string[]; usedBy: string[]; gates: string[]; adrs: string[]; tests: string[]; entry?: string; description?: string; drift: string[]
}
export interface GraphEdge { from: string; to: string; weight: number; typeOnly: boolean; testOnly: boolean; evidence: string[] }
export interface ArchitectureGraph {
  generatedAt: string; commit?: string; layers: string[]; nodes: GraphNode[]; edges: GraphEdge[]
  drift: Array<{ kind: string; severity: string; modules: string[]; detail: string }>
  changes: { files: string[]; modules: string[]; impacted: string[]; gates: string[] }
  stats: { files: number; modules: number; edges: number; scanMs: number }
}
export interface SAEvent { seq: number; ts: string; type: string; projectId: string; taskId?: string; data: Record<string, unknown> }

const token = new URLSearchParams(location.search).get('token') ?? localStorage.getItem('superagent-token') ?? ''
if (token) localStorage.setItem('superagent-token', token)
// Keep the long-lived human token out of the address bar, history and bookmarks once stored.
if (new URLSearchParams(location.search).has('token')) {
  const rest = new URLSearchParams(location.search)
  rest.delete('token')
  history.replaceState(history.state, '', `${location.pathname}${rest.size ? `?${rest}` : ''}${location.hash}`)
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json as T
}

export function eventStream(project: string | undefined, onEvent: (e: SAEvent) => void): () => void {
  const qs = new URLSearchParams()
  if (project) qs.set('project', project)
  if (token) qs.set('token', token)
  const es = new EventSource(`/api/events/stream?${qs}`)
  es.addEventListener('superagent', m => onEvent(JSON.parse((m as MessageEvent).data)))
  return () => es.close()
}

export const fmtModel = (m?: ModelRef): string => (m ? `${m.provider}/${m.model}` : '—')

export interface SharedFile { id: string; name: string; size: number; mime: string; source: string; note?: string; from: { role: 'worker' | 'chief' | 'human'; workerId?: string; taskId?: string }; createdAt: string }
export interface TreeEntry { name: string; path: string; type: 'dir' | 'file'; size?: number; mime?: string }
export interface ChiefMessage { id: string; role: 'human' | 'chief' | 'tool' | 'wake' | 'error'; text: string; tool?: string; at: string }
export interface TranscriptStep { type: 'text' | 'tool_call' | 'tool_result' | 'final'; callId?: string; tool?: string; input?: unknown; status?: string; result?: string; text?: string }
export interface FileLink { url: string; expiresAt: string; name: string; mime: string; size: number }

/** A short-lived link the browser (or phone) can open without the token. */
export const fileLink = (project: string, target: { file: string } | { path: string }, download = false): Promise<FileLink> =>
  api<FileLink>('POST', '/api/links', { project, ...target, download })

export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)

export interface Appearance {
  style: 'glass' | 'solid'; theme: 'auto' | 'light' | 'dark'; accent: string; panelOpacity: number
  background: { kind: 'none' | 'gradient' | 'image' | 'video' | 'embed'; preset?: string; assetId?: string; url?: string; blur: number; dim: number; interactive?: boolean; allowChat?: boolean; allowMedia?: boolean }
}
export interface AppearanceView { appearance: Appearance; backgroundUrl: string | null; assets: Array<{ id: string; mime: string; size: number; url: string }>; presets: string[] }
export interface CommandRecord { id: string; command: string; cwd: string; status: 'running' | 'exited' | 'stopped' | 'timeout' | 'error' | 'interrupted'; exitCode: number | null; startedAt: string; endedAt?: string; flagged?: string }
export interface ActivityEvent { projectId: string; seq: number; ts: string; taskId?: string; tone: 'info' | 'good' | 'bad' | 'attention'; text: string }

/** Raw upload (image/video) with the human token. */
export async function upload<T>(path: string, file: File): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: file })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json as T
}

/** Plain-language activity lines from the SSE stream (also forwarded to a Digital Human background). */
export function activityStream(project: string | undefined, onLine: (a: ActivityEvent) => void): () => void {
  const qs = new URLSearchParams()
  if (project) qs.set('project', project)
  if (token) qs.set('token', token)
  const es = new EventSource(`/api/events/stream?${qs}`)
  es.addEventListener('activity', m => onLine(JSON.parse((m as MessageEvent).data)))
  return () => es.close()
}
