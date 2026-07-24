// 預寫 data/metro/straighten-cells——與 D3Tab「重新計算」同內容（base＋①〜⑧ post／
// endp／line／gather／loop）。開分頁只讀檔、不現場重算。
//
//   node scripts/bakeHcCells.mjs                         # 全城 orig+rot
//   node scripts/bakeHcCells.mjs as-chn-beijing          # 一城
//   node scripts/bakeHcCells.mjs --shape                 # 只 bake 成方成功（square）的 shapelike
//   node scripts/bakeHcCells.mjs --shape as-twn-kaohsiung
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import {
  buildHcGraph, iteratePost, straightenCompactLoop, movewiseStage,
  setSpanCap, setFrozen, countHV,
} from '../src/stores/hillClimb.js'
import { PAPER_KINDS, PAPER_BUILD } from '../src/stores/paperAlign.js'
import { applyShapeGreens } from '../src/stores/paper/shape.js'
import { getShapePresets } from '../src/stores/paper/shapePresets.js'
import { waitIfPaused } from './_recomputePause.mjs'
// 不 import straightenCells.js（會拖進瀏覽器 assetUrl）；指紋／algo 常數在此對齊。
// 寫入的是預計算結果（cellAfter），不是 network 快取。
const HC_CELLS_ALGO = 'hccells-v8'
function dfp(data) {
  let h = 5381
  const add = (s) => { for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0 }
  for (const f of data.features) {
    if (f.geometry?.type === 'Point') add(`${f.properties.station_id}@${f.geometry.coordinates.join(',')}`)
    else for (const r of f.properties?.routes ?? []) add(`${r.route_id ?? ''}#${(r.stations ?? []).map((s) => s.station_id).join('.')}`)
  }
  return (h >>> 0).toString(36)
}

setSpanCap(3)

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'straighten-cells')
const args = process.argv.slice(2)
const shapeOnly = args.includes('--shape')
const force = args.includes('--force')
const only = args.filter((a) => !a.startsWith('--'))

const serCells = (m) => [...m.entries()].map(([id, [c, r]]) => [id, c, r])
function serStageMap(obj) {
  const out = {}
  for (const k of Object.keys(obj ?? {})) {
    const e = obj[k]
    if (!e?.cellAfter) continue
    // 續跑時 posts／loops 可能已是磁碟序列（array），勿再當 Map 展平
    const cellAfter = e.cellAfter instanceof Map ? serCells(e.cellAfter) : e.cellAfter
    out[k] = {
      cellAfter,
      stats: e.stats,
      ...(e.cols != null ? { cols: e.cols, rows: e.rows } : {}),
    }
  }
  return out
}

function expandMembers(skeleton, preset, greens) {
  const out = new Set([...(preset.stations ?? []), ...greens.map((g) => g.id)])
  if (preset.routeId && skeleton.edges) {
    for (const e of skeleton.edges) {
      if (e.routes?.has(preset.routeId)) for (const id of e.path) out.add(id)
    }
  }
  return out
}

async function loadCity(cityId, variant) {
  const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'))
  const sys = (index.systems ?? []).find((s) => (s.file || '').split('/').pop()?.replace(/\.geojson$/, '') === cityId)
  if (!sys) throw new Error(`index 無 ${cityId}`)
  const geojson = JSON.parse(await readFile(join(DATA, sys.file), 'utf8'))
  const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
  const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
  const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }
  const tilt = computeOrientation(geojson).tilt
  const skeleton = buildConnectSkeleton(geojson)
  const angle = variant === 'rot' && Math.abs(tilt) >= 0.5 ? tilt : 0
  const projection = geoMercator().angle(angle).fitExtent([[24, 24], [1176, 776]], fitFC)
  const projById = new Map()
  for (const f of stations) {
    const p = projection(f.geometry.coordinates)
    if (p) projById.set(f.properties.station_id, p)
  }
  for (const c of skeleton.crossings ?? []) {
    const p = projection(c.coord)
    if (p) projById.set(c.id, p)
  }
  const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
  const fingerprint = `${dfp(geojson)}:rg1.15`
  return { geojson, skeleton, grid, fingerprint, tilt }
}

async function bakeOne(cityId, variant, { shapelike = false, force = false } = {}) {
  const { skeleton: sk0, grid, fingerprint } = await loadCity(cityId, variant.replace(/-shape$/, ''))
  let skeleton = sk0
  let baseCells = grid.cellOf
  let greens = []
  let frozen = null
  const useShape = shapelike || variant.includes('-shape')
  // D3Tab：shape 層 variant=orig-shape，shapelike=true → file orig-shape.shapelike.json
  const diskVariant = useShape
    ? (variant.endsWith('-shape') ? variant : `${variant.replace(/-shape$/, '')}-shape`)
    : variant
  const diskName = `${cityId}.${diskVariant}${useShape ? '.shapelike' : ''}.json`
  const diskPath = join(OUT, diskName)
  const kinds = ['hc', ...PAPER_KINDS.map((p) => p.kind)]
  const kindDone = (prev, k) =>
    !!(prev?.hc?.cellAfter &&
      (k === 'hc' || prev.posts?.[k]?.cellAfter) &&
      prev.loops?.[k]?.cellAfter &&
      prev.endp?.[k]?.cellAfter &&
      prev.line?.[k]?.cellAfter &&
      prev.gather?.[k]?.cellAfter)
  let prevPartial = null
  if (existsSync(diskPath)) {
    try {
      const prev = JSON.parse(await readFile(diskPath, 'utf8'))
      const hasFlow = kinds.every((k) => kindDone(prev, k))
      if (!force && prev.algo === HC_CELLS_ALGO && prev.fingerprint === fingerprint && hasFlow) {
        return { skip: true, reason: 'fresh', file: diskName }
      }
      // 同指紋未齊 → 續跑已完成的 kind（莫斯科曾跑數小時被殺，需斷點）
      if (prev.algo === HC_CELLS_ALGO && prev.fingerprint === fingerprint && prev.hc?.cellAfter) {
        prevPartial = prev
      }
    } catch { /* 重算 */ }
  }
  if (useShape) {
    const base = variant.replace(/-shape$/, '') || 'orig'
    const shapePath = join(DATA, 'straighten-shape', `${cityId}.${base}.json`)
    if (!existsSync(shapePath)) return { skip: true, reason: 'no shape file' }
    const shape = JSON.parse(await readFile(shapePath, 'utf8'))
    if (shape.square !== true) return { skip: true, reason: 'square≠true' }
    baseCells = new Map(shape.cellAfter.map(([id, c, r]) => [id, [c, r]]))
    greens = shape.greens ?? []
    if (greens.length) skeleton = applyShapeGreens(sk0, greens)
    const presets = getShapePresets(cityId) ?? []
    frozen = new Set()
    for (const p of presets) {
      for (const id of expandMembers(skeleton, p, greens)) frozen.add(id)
    }
    setFrozen({ ringIds: presets.flatMap((p) => p.stations ?? []), members: frozen })
  } else {
    setFrozen(null)
  }

  process.stdout.write(`… ${diskName}\n`)
  const log = (msg) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}\n`
    process.stdout.write(line)
    try { appendFileSync(join(OUT, '_bake-progress.log'), line) } catch { /* */ }
  }
  log(`start ${diskName}`)
  const g = buildHcGraph(skeleton, baseCells)
  const hc = {
    cellAfter: new Map([...baseCells].map(([id, p]) => [id, [p[0], p[1]]])),
    stats: {
      verts: g.pos.size, segs: g.segs.length,
      hvAfter: countHV(g.pos, g.segs), ms: 0,
      base: useShape ? 'shape' : 'grid',
      ...(useShape ? { shapeFeed: 'llm' } : {}),
    },
  }
  // 續跑：沿用磁碟上已算完的 posts／loops／…
  const posts = {}, endp = {}, line = {}, gather = {}, loops = {}
  if (prevPartial && !force) {
    Object.assign(posts, prevPartial.posts ?? {})
    Object.assign(endp, prevPartial.endp ?? {})
    Object.assign(line, prevPartial.line ?? {})
    Object.assign(gather, prevPartial.gather ?? {})
    Object.assign(loops, prevPartial.loops ?? {})
  }
  const writePartial = async () => {
    const payload = {
      algo: HC_CELLS_ALGO,
      fingerprint,
      cityId,
      variant: diskVariant,
      shapelike: !!useShape,
      hc: { cellAfter: serCells(hc.cellAfter), stats: hc.stats },
      posts: serStageMap(posts),
      layouts: {},
      loops: serStageMap(loops),
      endp: serStageMap(endp),
      line: serStageMap(line),
      gather: serStageMap(gather),
    }
    await mkdir(OUT, { recursive: true })
    await writeFile(diskPath, JSON.stringify(payload))
  }
  if (force) prevPartial = null
  for (const kind of kinds) {
    if (!force && kindDone({ hc, posts, endp, line, gather, loops }, kind)) {
      log(`${kind} resume-skip`)
      continue
    }
    const t0 = Date.now()
    const tick = (s) => log(`${kind}.${s} ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    const post = PAPER_BUILD[kind]
      ? iteratePost(PAPER_BUILD[kind], skeleton, hc.cellAfter, grid.cols, grid.rows)
      : null
    const base = post ? post.cellAfter : hc.cellAfter
    if (post) { posts[kind] = post; tick('post') }
    const e = movewiseStage('endp', skeleton, base, grid.cols, grid.rows)
    endp[kind] = e; tick('endp')
    const l = movewiseStage('line', skeleton, e.cellAfter, e.cols, e.rows)
    line[kind] = l; tick('line')
    const ga = movewiseStage('gather', skeleton, l.cellAfter, l.cols, l.rows)
    gather[kind] = ga; tick('gather')
    loops[kind] = straightenCompactLoop(skeleton, base, grid.cols, grid.rows)
    log(`${kind} done ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    await writePartial()
    tick('saved')
  }
  setFrozen(null)
  return { skip: false, file: diskName, kinds: kinds.length }
}

async function main() {
  const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'))
  // 由少站到多站——全球重算先出小城結果、也較好觀察進度／錯誤
  const systems = [...(index.systems ?? [])].sort(
    (a, b) => (a.station_count ?? 0) - (b.station_count ?? 0)
      || String(a.city ?? '').localeCompare(String(b.city ?? '')),
  )
  let cities = systems.map((s) => s.file.split('/').pop().replace(/\.geojson$/, ''))
  if (only.length) cities = cities.filter((c) => only.includes(c))
  if (shapeOnly) {
    // 規定表＋square 檔（順序沿用上面少→多）
    const withShape = []
    for (const c of cities) {
      if (!getShapePresets(c)) continue
      for (const v of ['orig', 'rot']) {
        const p = join(DATA, 'straighten-shape', `${c}.${v}.json`)
        if (!existsSync(p)) continue
        const j = JSON.parse(await readFile(p, 'utf8'))
        if (j.square === true) withShape.push([c, `${v}-shape`])
      }
    }
    const total = withShape.length
    console.log(`bake shapelike ${total} 件`)
    console.log(`PROGRESS 0/${total} start`)
    let ok = 0, skip = 0, i = 0
    const t0 = Date.now()
    for (const [c, v] of withShape) {
      await waitIfPaused()
      i++
      const tag = `${c}.${v}`
      console.log(`PROGRESS ${i}/${total} ${tag}`)
      try {
        const r = await bakeOne(c, v, { shapelike: true, force })
        if (r.skip) { skip++; console.log(`· ${r.file ?? tag} skip ${r.reason}`); continue }
        ok++
        console.log(`✓ ${r.file}`)
      } catch (e) {
        console.error(`✗ ${tag} ${e.message}`)
      }
    }
    console.log(`完成 ${ok}、跳過 ${skip}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    return
  }

  const jobs = cities.flatMap((c) => ['orig', 'rot'].map((v) => [c, v]))
  const total = jobs.length
  console.log(`bake ${cities.length} 城 × orig/rot（${total} 件，站數少→多）`)
  console.log(`PROGRESS 0/${total} start`)
  let ok = 0, skip = 0, i = 0
  const t0 = Date.now()
  for (const [c, v] of jobs) {
    await waitIfPaused()
    i++
    const tag = `${c}.${v}`
    console.log(`PROGRESS ${i}/${total} ${tag}`)
    try {
      const r = await bakeOne(c, v, { shapelike: false, force })
      if (r.skip) { skip++; console.log(`· ${r.file ?? tag} skip ${r.reason}`); continue }
      ok++
      console.log(`✓ ${r.file}`)
    } catch (e) {
      console.error(`✗ ${tag} ${e.message}`)
    }
  }
  console.log(`完成 ${ok}、跳過 ${skip}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
}

main().catch((e) => { console.error(e); process.exit(1) })
