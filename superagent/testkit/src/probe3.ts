import { createServer } from 'node:http'
import { startMockLlm, text, toolCall, runDsh } from './index.ts'
const page = createServer((_q, s) => { s.writeHead(200, {'content-type':'text/html'}); s.end('<html><title>SA Probe</title><body><h1 id="h">Hello Browser</h1><button onclick="document.getElementById(\'h\').textContent=\'Clicked!\'">Go</button></body></html>') })
await new Promise<void>(r => page.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(page.address() as any).port}/`
let step = 0
const m = await startMockLlm(req => {
  if (!req.tools?.length) return text('t')
  if (step === 0) void 0
  step++
  if (step === 1) return toolCall('mcp__playwright-mcp__browser_navigate', { url })
  if (step === 2) { const ref = JSON.stringify(req.messages).match(/button \\+"Go\\+" \[ref=(e\d+)\]/)?.[1]; console.log('ref', ref); return toolCall('mcp__playwright-mcp__browser_click', { element: 'Go button', ref: ref ?? 'e3' }) }
  if (step === 3) return toolCall('mcp__playwright-mcp__browser_snapshot', {})
  return text('DONE')
})
const r = await runDsh({ args: ['--profile', 'sa-worker', '--patch', '/home/user/dgx-super-agent/superagent/dsh-bundle/patches/worker-browser.yml', '--json', 'x'], cwd: '/tmp/claude-0/sa-scratch/ws', timeoutMs: 180000, env: { DSH_HOME: '/tmp/claude-0/sa-scratch/dh1', DEEPSEEK_BASE_URL: m.baseUrl, DEEPSEEK_API_KEY: 'k', SUPERAGENT_CHROMIUM: '/opt/pw-browsers/chromium', } })
console.log('exit', r.exitCode, r.stderr.slice(-1000))
for (const l of r.stdout.split('\n').filter(l => l.includes('tool_result'))) console.log(l.slice(0, 500))
await m.close(); page.close()
