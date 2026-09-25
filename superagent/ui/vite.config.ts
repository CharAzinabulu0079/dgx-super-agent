import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: `pnpm --filter @superagent/ui dev` proxies /api to a running `sa serve`.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': process.env.SUPERAGENT_API ?? 'http://127.0.0.1:7788' } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
})
