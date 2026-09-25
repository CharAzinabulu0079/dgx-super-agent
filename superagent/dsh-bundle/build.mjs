// Bundle the Cordis plugin (and the SuperAgent store it writes to) into one ESM file.
// DSH loads plugins from node_modules, where Node will not strip TypeScript types.
import { build } from 'esbuild'
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  banner: { js: "import { createRequire as __saCreateRequire } from 'node:module'; const require = __saCreateRequire(import.meta.url);" },
  logLevel: 'info',
})
