// Static server for the sample app. PORT env (default 4321).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const root = join(import.meta.dirname, 'public')
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  try {
    const body = await readFile(join(root, path.replace(/\.\.+/g, '')))
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
server.listen(Number(process.env.PORT ?? 4321), '127.0.0.1', () => console.log(`sample-webapp on http://127.0.0.1:${server.address().port}`))
