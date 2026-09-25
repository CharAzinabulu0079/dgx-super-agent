/**
 * Scriptable Anthropic-Messages-compatible SSE server for keyless DSH runs.
 *
 * DSH's DeepSeek adapter speaks the Messages wire protocol under `<base>/messages`,
 * so pointing `DEEPSEEK_BASE_URL` at `http://127.0.0.1:<port>/v1` lets tests drive a
 * real DSH agent loop with deterministic model turns (text and tool calls).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly name: string; readonly input: Record<string, unknown> }

/** One scripted model turn. */
export interface MockTurn {
  readonly blocks: readonly MockBlock[]
}

/** Dynamic responder: receives the parsed request body and returns the next turn. */
export type MockResponder = (request: MockRequest, index: number) => MockTurn

export interface MockRequest {
  readonly model?: string
  readonly messages: ReadonlyArray<{ role: string; content: unknown }>
  readonly tools?: ReadonlyArray<{ name: string }>
  readonly system?: unknown
}

export interface MockLlm {
  readonly baseUrl: string
  readonly requests: MockRequest[]
  close(): Promise<void>
}

export const text = (value: string): MockTurn => ({ blocks: [{ type: 'text', text: value }] })
export const toolCall = (name: string, input: Record<string, unknown>, preface?: string): MockTurn => ({
  blocks: [
    ...(preface === undefined ? [] : [{ type: 'text' as const, text: preface }]),
    { type: 'tool_use' as const, name, input },
  ],
})

/**
 * Start the server.
 * @param script - a FIFO of turns, or a responder function.
 * @returns the base URL (ending in `/v1`), captured requests, and a closer.
 */
export async function startMockLlm(script: readonly MockTurn[] | MockResponder): Promise<MockLlm> {
  const requests: MockRequest[] = []
  let counter = 0
  const server = createServer((req, res) => {
    void handle(req, res)
  })
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'not_found', message: `no route ${req.method} ${req.url}` } }))
      return
    }
    let body: MockRequest
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MockRequest
    } catch (parseError) {
      // Malformed JSON from the client is a test failure; report it on the wire.
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: String(parseError) } }))
      return
    }
    requests.push(body)
    const index = counter++
    let turn: MockTurn | undefined
    if (typeof script === 'function') turn = script(body, index)
    else turn = script[index]
    if (turn === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'mock_error', message: 'mock script exhausted' } }))
      return
    }
    writeTurn(res, turn, index)
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}

function writeTurn(res: ServerResponse, turn: MockTurn, index: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const sse = (payload: unknown): void => { res.write(`data: ${JSON.stringify(payload)}\n\n`) }
  sse({
    type: 'message_start',
    message: { id: `mock-msg-${index}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 10, output_tokens: 0 } },
  })
  let usesTool = false
  turn.blocks.forEach((block, i) => {
    if (block.type === 'text') {
      sse({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
      sse({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } })
    } else {
      usesTool = true
      sse({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `mock-call-${index}-${i}`, name: block.name, input: {} } })
      sse({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    }
    sse({ type: 'content_block_stop', index: i })
  })
  sse({ type: 'message_delta', delta: { stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  sse({ type: 'message_stop' })
  res.end()
}
