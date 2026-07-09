// Robust Overpass API client: multi-endpoint, retry/backoff, on-disk cache.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const CACHE = join(__dirname, '..', 'data', 'metro', '_cache')

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
const UA = 'adapt-metro-thesis/1.0 (metro data extraction; knowledge.nomads.tw2@gmail.com)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function exists(p) {
  try { const s = await stat(p); return s.size > 0 } catch { return false }
}

async function post(endpoint, query, timeoutMs) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ data: query }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    return JSON.parse(text)
  } finally {
    clearTimeout(t)
  }
}

export async function query(q, { cacheName = null, timeout = 180000, maxAttempts = 8 } = {}) {
  if (cacheName) {
    const path = join(CACHE, cacheName)
    if (await exists(path)) return JSON.parse(await readFile(path, 'utf8'))
  }
  let lastErr
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const result = await post(endpoint, q, timeout)
      if (cacheName) {
        await mkdir(CACHE, { recursive: true })
        await writeFile(join(CACHE, cacheName), JSON.stringify(result))
      }
      return result
    } catch (e) {
      lastErr = e
      const wait = Math.min(60000, 5000 * (attempt + 1))
      process.stderr.write(
        `  [overpass] attempt ${attempt + 1}/${maxAttempts} on ` +
        `${new URL(endpoint).host} failed: ${e.message}; retry in ${wait / 1000}s\n`)
      await sleep(wait)
    }
  }
  throw new Error(`Overpass query failed after ${maxAttempts} attempts: ${lastErr?.message}`)
}
