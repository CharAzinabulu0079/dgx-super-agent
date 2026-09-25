/** Thin client over the SuperAgent Realtime/API gateway. */

export interface ModelRef { provider: string; model: string }
export interface Attempt { n: number; strategy: string; model: ModelRef; verdict?: 'PASS' | 'FAIL'; receiptId?: string; workerId: string }
export interface Task {
  id: string; goalId: string; title: string; instructions: string; state: string; running?: boolean
  attempts: Attempt[]; policy: { model: { worker: ModelRef; escalation?: ModelRef; reviewer?: ModelRef }; maxAttempts: number }
  steer?: string; humanGateId?: string
}
export interface Goal { id: string; objective: string; status: string; taskIds: string[]; blocker?: string; createdAt: string }
export interface Project { id: string; name: string; root: string; goal?: Goal | null; openHumanGates?: number }
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
