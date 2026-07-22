// 預寫 data/metro/straighten-cells——與 D3Tab「重新計算」同內容（base＋①〜⑧ post／
// endp／line／gather／loop）。開分頁只讀檔、不現場重算。
//
//   node scripts/bakeHcCells.mjs                         # 全城 orig+rot
//   node scripts/bakeHcCells.mjs as-chn-beijing          # 一城
//   node scripts/bakeHcCells.mjs --shape                 # 只 bake 成方成功（square）的 shapelike
//   node scripts/bakeHcCells.mjs --shape as-twn-kaohsiung
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
// 不 import straightenCells.js（會拖進瀏覽器 assetUrl）；指紋／algo 常數在此對齊。
// 寫入的是預計算結果（cellAfter），不是 network 快取。
const HC_CELLS_ALGO = 'hccells-v6'
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
    out[k] = {
      cellAfter: serCells(e.cellAfter),
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
  if (!force && existsSync(diskPath)) {
    try {
      const prev = JSON.parse(await readFile(diskPath, 'utf8'))
      const need = ['hc', ...PAPER_KINDS.map((p) => p.kind)]
      const hasFlow = need.every((k) =>
        (k === 'hc' || prev.posts?.[k]?.cellAfter) &&
        prev.loops?.[k]?.cellAfter &&
        prev.endp?.[k]?.cellAfter &&
        prev.line?.[k]?.cellAfter &&
        prev.gather?.[k]?.cellAfter)
      if (prev.algo === HC_CELLS_ALGO && prev.fingerprint === fingerprint && prev.hc?.cellAfter && hasFlow) {
        return { skip: true, reason: 'fresh', file: diskName }
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
  const posts = {}, endp = {}, line = {}, gather = {}, loops = {}
  const kinds = ['hc', ...PAPER_KINDS.map((p) => p.kind)]
  for (const kind of kinds) {
    const t0 = Date.now()
    const post = PAPER_BUILD[kind]
      ? iteratePost(PAPER_BUILD[kind], skeleton, hc.cellAfter, grid.cols, grid.rows)
      : null
    const base = post ? post.cellAfter : hc.cellAfter
    if (post) posts[kind] = post
    const e = movewiseStage('endp', skeleton, base, grid.cols, grid.rows)
    endp[kind] = e
    const l = movewiseStage('line', skeleton, e.cellAfter, e.cols, e.rows)
    line[kind] = l
    const ga = movewiseStage('gather', skeleton, l.cellAfter, l.cols, l.rows)
    gather[kind] = ga
    loops[kind] = straightenCompactLoop(skeleton, base, grid.cols, grid.rows)
    process.stdout.write(`  ${kind} ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
  }
  setFrozen(null)

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
  return { skip: false, file: diskName, kinds: kinds.length }
}

async function main() {
  const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'))
  let cities = (index.systems ?? []).map((s) => s.file.split('/').pop().replace(/\.geojson$/, ''))
  if (only.length) cities = cities.filter((c) => only.includes(c))
  if (shapeOnly) {
    // 規定表＋square 檔
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
    console.log(`bake shapelike ${withShape.length} 件`)
    let ok = 0, skip = 0
    const t0 = Date.now()
    for (const [c, v] of withShape) {
      try {
        const r = await bakeOne(c, v, { shapelike: true, force })
        if (r.skip) { skip++; console.log(`· ${r.file ?? `${c}.${v}`} skip ${r.reason}`); continue }
        ok++
        console.log(`✓ ${r.file}`)
      } catch (e) {
        console.error(`✗ ${c}.${v} ${e.message}`)
      }
    }
    console.log(`完成 ${ok}、跳過 ${skip}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    return
  }

  console.log(`bake ${cities.length} 城 × orig/rot`)
  let ok = 0, skip = 0
  const t0 = Date.now()
  for (const c of cities) {
    for (const v of ['orig', 'rot']) {
      try {
        const r = await bakeOne(c, v, { shapelike: false, force })
        if (r.skip) { skip++; console.log(`· ${r.file ?? `${c}.${v}`} skip ${r.reason}`); continue }
        ok++
        console.log(`✓ ${r.file}`)
      } catch (e) {
        console.error(`✗ ${c}.${v} ${e.message}`)
      }
    }
  }
  console.log(`完成 ${ok}、跳過 ${skip}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
}

main().catch((e) => { console.error(e); process.exit(1) })
