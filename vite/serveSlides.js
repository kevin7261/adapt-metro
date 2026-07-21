import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'

export function serveSlides() {
  const root = resolve(process.cwd(), 'slides')
  const handler = (req, res, next) => {
    if (!req.url) return next()
    const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/adapt-metro/, '')
    const m = p.match(/^\/slides(\/.*)?$/)
    if (!m) return next()
    let rel = (m[1] || '/').replace(/^\/+/, '')
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'
    const file = normalize(join(root, rel))
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()
    const types = {
      html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
      json: 'application/json', png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    }
    const ext = file.split('.').pop().toLowerCase()
    res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  }
  return {
    name: 'serve-slides',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}
