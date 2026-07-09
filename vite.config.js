import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'

// Serve the repo's data/ directory (metro catalog + per-system GeoJSON)
// at /data/* without copying 100+ MB into public/.
function serveDataDir() {
  const root = resolve(process.cwd(), 'data')
  const handler = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/data/')) return next()
    const urlPath = decodeURIComponent(req.url.split('?')[0]).replace(/^\/data\//, '')
    const file = normalize(join(root, urlPath))
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()
    res.setHeader(
      'Content-Type',
      /\.(json|geojson)$/.test(file) ? 'application/json' : 'application/octet-stream',
    )
    createReadStream(file).pipe(res)
  }
  return {
    name: 'serve-data-dir',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}

export default defineConfig({
  plugins: [vue(), serveDataDir()],
  server: {
    port: 5173,
  },
})
