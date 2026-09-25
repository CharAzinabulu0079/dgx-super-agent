/** Regenerate this repository's `.architecture/` (also used by the post-commit hook). */
import { Observatory } from '../superagent/plugins/architecture-observatory/src/index.ts'
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const g = await new Observatory().scan(root)
const errors = g.drift.filter(d => d.severity === 'error')
console.log(`architecture: ${g.stats.modules} modules, ${g.stats.edges} edges, ${g.drift.length} drift (${errors.length} error) in ${g.stats.scanMs}ms`)
for (const d of g.drift) console.log(`  ${d.severity} ${d.kind}: ${d.detail}`)
process.exit(process.argv.includes('--check') && errors.length ? 1 : 0)
