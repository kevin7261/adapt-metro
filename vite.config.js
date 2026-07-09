import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createReadStream, existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
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
    const types = {
      json: 'application/json', geojson: 'application/json',
      png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    }
    const ext = file.split('.').pop().toLowerCase()
    res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  }
  return {
    name: 'serve-data-dir',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}

// Expose this repo's Claude skills (.claude/skills/*/SKILL.md) at /skills/*
// so the UI can list and display them.
function serveSkills() {
  const root = resolve(process.cwd(), '.claude/skills')
  const handler = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/skills/')) return next()
    const p = decodeURIComponent(req.url.split('?')[0])

    if (p === '/skills/index.json') {
      const skills = !existsSync(root) ? [] : readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
        .map((d) => {
          const md = readFileSync(join(root, d.name, 'SKILL.md'), 'utf8')
          const description = md.match(/^description:\s*(.+)$/m)?.[1].trim() ?? ''
          return { id: d.name, description }
        })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(skills))
      return
    }

    const m = p.match(/^\/skills\/([\w-]+)\.md$/)
    if (m) {
      const file = join(root, m[1], 'SKILL.md')
      if (existsSync(file)) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        createReadStream(file).pipe(res)
        return
      }
    }
    next()
  }
  return {
    name: 'serve-skills',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}

export default defineConfig({
  plugins: [vue(), serveDataDir(), serveSkills()],
  server: {
    port: 5173,
  },
})
