// Pre-compute the per-city view thumbnails the galleries render as SVG:
//   • 8 Map Adjust views   → data/metro/views/<id>.json
//   • 6 Hill Climbing views → data/metro/hcviews/<id>.json
// plus an index.json catalog in each dir.
//
//   in : data/metro/index.json + data/metro/systems/**/*.geojson
//   out: data/metro/views/<id>.json     (原始/旋轉/骨架化/格網化前後 ×…)
//        data/metro/hcviews/<id>.json    (格網化後/Hill Climbing/縮減網格 ×2)
//        data/metro/{views,hcviews}/index.json
//
// The geometry is produced by src/stores/viewGeometry.js — the SAME pure
// stores the live Map Adjust / Hill Climbing tab (D3Tab.vue) uses — so the
// thumbnails match the interactive views. Run after metro:build.
//
//   node scripts/buildViews.mjs
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeCityViews, computeCityHcViews } from '../src/stores/viewGeometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const OUT = join(BASE, 'views')
const HC_OUT = join(BASE, 'hcviews')

// Same id the gallery/layer derive from a system file: the basename sans ext.
const idOf = (file) => file.split('/').pop().replace(/\.geojson$/, '')

async function main() {
  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const systems = index.systems ?? []
  if (!systems.length) {
    console.error('index.json 沒有 systems[]，請先跑 npm run metro:build')
    process.exit(1)
  }

  // Fresh output dirs so removed cities don't leave stale view files behind.
  await rm(OUT, { recursive: true, force: true })
  await rm(HC_OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await mkdir(HC_OUT, { recursive: true })

  const catalog = []
  const hcCatalog = []
  let ok = 0
  let hcOk = 0
  const failures = []
  const hcFailures = []

  const meta = (sys, id, r) => ({
    id,
    file: sys.file,
    city: sys.city,
    country: sys.country,
    continent: sys.continent,
    line_count: sys.line_count,
    station_count: sys.station_count,
    tilt: +r.tilt.toFixed(2),
    canRotate: r.canRotate,
  })

  for (const sys of systems) {
    const id = idOf(sys.file)
    let geojson
    try {
      geojson = JSON.parse(await readFile(join(BASE, sys.file), 'utf8'))
    } catch (err) {
      failures.push({ id, city: sys.city, error: String(err?.message ?? err) })
      hcFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
      continue
    }

    // 8 Map Adjust views
    try {
      const r = computeCityViews(geojson)
      await writeFile(join(OUT, `${id}.json`), JSON.stringify({
        ...meta(sys, id, r), W: r.W, H: r.H, views: r.views,
      }))
      catalog.push(meta(sys, id, r))
      ok++
    } catch (err) {
      failures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }

    // 6 Hill Climbing views
    try {
      const r = computeCityHcViews(geojson)
      await writeFile(join(HC_OUT, `${id}.json`), JSON.stringify({
        ...meta(sys, id, r), W: r.W, H: r.H, views: r.views, stats: r.stats,
      }))
      hcCatalog.push(meta(sys, id, r))
      hcOk++
    } catch (err) {
      hcFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }
  }

  // Keep catalogs in index.json order (already sorted upstream).
  await writeFile(join(OUT, 'index.json'), JSON.stringify({
    generated_from: 'scripts/buildViews.mjs',
    view_ids: ['original', 'rotated', 'skeleton', 'rotated-skeleton',
      'grid-orig-pre', 'grid-orig-post', 'grid-rot-pre', 'grid-rot-post'],
    system_count: catalog.length,
    systems: catalog,
  }))
  await writeFile(join(HC_OUT, 'index.json'), JSON.stringify({
    generated_from: 'scripts/buildViews.mjs',
    view_ids: ['grid-orig-post', 'hc-orig', 'compact-orig',
      'grid-rot-post', 'hc-rot', 'compact-rot'],
    system_count: hcCatalog.length,
    systems: hcCatalog,
  }))

  console.log(`views:   ${ok}/${systems.length} 城市 → data/metro/views/`)
  console.log(`hcviews: ${hcOk}/${systems.length} 城市 → data/metro/hcviews/`)
  for (const f of failures) console.log(`  ✗ views   ${f.id} (${f.city}) — ${f.error}`)
  for (const f of hcFailures) console.log(`  ✗ hcviews ${f.id} (${f.city}) — ${f.error}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
