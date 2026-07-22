// Persist Straighten／RWD 的整數格佈局到 data/metro/straighten-cells/*.json（取代 localStorage）。
//   POST /hc-cells/save  { city, variant, shapelike?, payload }
//   POST /hc-cells/clear { city } | { city, variant, shapelike? }
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'data/metro/straighten-cells'

function safeCity(s) { return /^[\w-]+$/.test(s ?? '') ? s : null }
function safeVariant(s) { return /^[\w.-]+$/.test(s ?? '') ? s : null }

function fileName(city, variant, shapelike) {
  return `${city}.${variant}${shapelike ? '.shapelike' : ''}.json`
}

export function hcCellsPersist() {
  const root = process.cwd()
  const readBody = (req) => new Promise((ok) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok(null) } })
  })
  const handler = async (req, res, next) => {
    const p = (req.url ?? '').split('?')[0]
    if (!p.startsWith('/hc-cells/')) return next()
    res.setHeader('Content-Type', 'application/json')
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'POST only' }))
      return
    }
    const body = await readBody(req)
    const city = safeCity(body?.city)
    if (!city) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'bad city' }))
      return
    }
    const absDir = join(root, DIR)
    if (p === '/hc-cells/save') {
      const variant = safeVariant(body?.variant)
      const payload = body?.payload
      if (!variant || !payload || typeof payload !== 'object') {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'bad params' }))
        return
      }
      mkdirSync(absDir, { recursive: true })
      const name = fileName(city, variant, !!body.shapelike)
      writeFileSync(join(absDir, name), JSON.stringify(payload))
      res.end(JSON.stringify({ ok: true, file: `${DIR}/${name}` }))
      return
    }
    if (p === '/hc-cells/clear') {
      if (!existsSync(absDir)) {
        res.end(JSON.stringify({ cleared: 0, files: [] }))
        return
      }
      const variant = body?.variant != null ? safeVariant(body.variant) : null
      if (body?.variant != null && !variant) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'bad variant' }))
        return
      }
      const files = readdirSync(absDir).filter((n) => {
        if (!n.endsWith('.json') || n === '.gitkeep') return false
        if (variant) {
          const want = fileName(city, variant, !!body.shapelike)
          return n === want
        }
        return n.startsWith(`${city}.`)
      })
      let n = 0
      for (const f of files) {
        try { rmSync(join(absDir, f)); n++ } catch { /* best-effort */ }
      }
      res.end(JSON.stringify({ cleared: n, files: files.map((f) => `${DIR}/${f}`) }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  }
  return {
    name: 'hc-cells-persist',
    configureServer(server) { server.middlewares.use(handler) },
  }
}
