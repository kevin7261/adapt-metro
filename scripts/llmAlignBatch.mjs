// 全球 LLM 自動對齊批次——為每個城市的原始／旋轉各算一次自動對齊，
// 寫入 data/metro/straighten-llm/<city>.<variant>.json（與 route-llm-align /
// llmAlign.mjs apply 同格式），讓 Straighten／RWD 畫廊的 LLM 對齊格不再空白。
//
// 策略＝skill route-llm-align 的短距啟發式（非 headless Claude）：能 H/V 優先、
// 45° 次之；提 ±1～3 格移動 → applyLlmTargets（同硬規則＋scoreAlign）→
// 收斂或上限 10 輪。已有結果檔且 fingerprint 相符則跳過（加 --force 重算）。
//
//   node scripts/llmAlignBatch.mjs              # 缺檔才算
//   node scripts/llmAlignBatch.mjs --force      # 全部重算
//   node scripts/llmAlignBatch.mjs as-twn-taipei # 只算一城
//   node scripts/llmAlignBatch.mjs --limit 20   # 只算前 N 個缺檔任務
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import {
  buildHcGraph, applyLlmTargets, setSpanCap, countHVD, gridLayoutFingerprint,
} from '../src/stores/hillClimb.js'

setSpanCap(+(process.env.LLM_SPAN_CAP ?? 3) || 3)

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'straighten-llm')
const MODEL = 'batch-hvd' // 啟發式批次；有 headless Claude 結果檔時本腳本預設不覆寫
const MAX_ROUNDS = 10
const MAX_STEP = 3

const args = process.argv.slice(2)
const force = args.includes('--force')
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? Math.max(1, +args[limitIdx + 1] || 0) : 0
const onlyCity = args.find((a) => !a.startsWith('--') && a !== String(limit || ''))

function isHV(A, B) {
  return (A[0] === B[0]) !== (A[1] === B[1])
}

// 回傳把 b 對齊到 a 的目標座標。優先序（使用者裁決）：①能 H/V 就 H/V（平手偏垂直）
// ②否則近對角 → 45° ③偏軸 → H/V。距離超過 MAX_STEP 則沿該方向只走 MAX_STEP。
function alignTarget(A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  const adx = Math.abs(dx), ady = Math.abs(dy)
  if (adx === 0 && ady === 0) return null
  if (isHV(A, B)) return null // 已 H/V
  let tc = B[0], tr = B[1]
  const canV = adx > 0 && adx <= MAX_STEP // 對齊 col → 垂直
  const canH = ady > 0 && ady <= MAX_STEP // 對齊 row → 水平
  if (canV || canH) {
    if (canV && canH) {
      if (adx < ady) tc = A[0]
      else if (ady < adx) tr = A[1]
      else tc = A[0] // 等距：優先垂直
    } else if (canV) tc = A[0]
    else tr = A[1]
  } else if (Math.abs(adx - ady) <= Math.max(1, Math.floor(Math.min(adx, ady) * 0.35))) {
    // 近對角且無法一步成 H/V → 收成 45°
    const t = Math.min(adx, ady)
    tc = A[0] + Math.sign(dx || 1) * t
    tr = A[1] + Math.sign(dy || 1) * t
  } else if (ady < adx) {
    tr = A[1]
  } else {
    tc = A[0]
  }
  let dc = tc - B[0], dr = tr - B[1]
  if (Math.abs(dc) > MAX_STEP) dc = Math.sign(dc) * MAX_STEP
  if (Math.abs(dr) > MAX_STEP) dr = Math.sign(dr) * MAX_STEP
  tc = B[0] + dc
  tr = B[1] + dr
  if (tc === B[0] && tr === B[1]) return null
  return [tc, tr]
}

// 已 H/V 段的鎖：V 鎖 col、H 鎖 row。45° 不鎖——允許再升格成 H/V。
function buildLocks(segs, cells) {
  const lockCol = new Set()
  const lockRow = new Set()
  for (const s of segs) {
    const A = cells.get(s.a), B = cells.get(s.b)
    if (!A || !B) continue
    const dc = B[0] - A[0], dr = B[1] - A[1]
    if ((A[0] === B[0]) !== (A[1] === B[1])) {
      if (dc === 0) { lockCol.add(s.a); lockCol.add(s.b) }
      else { lockRow.add(s.a); lockRow.add(s.b) }
    }
  }
  return { lockCol, lockRow }
}

function proposeMoves(segs, cells, cols, rows) {
  const locks = buildLocks(segs, cells)
  const moves = new Map() // id → [c,r]
  const occupied = new Set([...cells].map(([, p]) => `${p[0]},${p[1]}`))

  const trySet = (id, t) => {
    if (!t) return false
    const [c, r] = t
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false
    const key = `${c},${r}`
    const cur = cells.get(id)
    if (cur[0] === c && cur[1] === r) return false
    if (occupied.has(key) && !(cur[0] === c && cur[1] === r)) return false
    if (locks.lockCol.has(id) && c !== cur[0]) return false
    if (locks.lockRow.has(id) && r !== cur[1]) return false
    occupied.delete(`${cur[0]},${cur[1]}`)
    occupied.add(key)
    moves.set(id, [c, r])
    return true
  }

  // 非 H/V 段都進場（含已是 45°——優先升格成 H/V）；短移動優先
  const off = []
  for (const s of segs) {
    const A = cells.get(s.a), B = cells.get(s.b)
    if (isHV(A, B)) continue
    const adx = Math.abs(A[0] - B[0]), ady = Math.abs(A[1] - B[1])
    const cost = Math.min(adx, ady) + Math.abs(adx - ady)
    off.push({ s, cost })
  }
  off.sort((a, b) => a.cost - b.cost)

  for (const { s } of off) {
    if (moves.has(s.a) || moves.has(s.b)) continue
    const A = moves.get(s.a) ?? cells.get(s.a)
    const B = moves.get(s.b) ?? cells.get(s.b)
    if (trySet(s.b, alignTarget(A, B))) continue
    if (trySet(s.a, alignTarget(B, A))) continue
  }
  return moves
}

async function loadCity(cityId, variant) {
  const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'))
  const sys = (index.systems ?? []).find((s) => (s.file || '').split('/').pop()?.replace(/\.geojson$/, '') === cityId)
  if (!sys) throw new Error(`index.json 找不到城市 ${cityId}`)
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
  const fingerprint = gridLayoutFingerprint(skeleton, grid.cellOf, grid.cols, grid.rows)
  return { skeleton, grid, fingerprint }
}

async function runOne(cityId, variant) {
  const outFile = join(OUT, `${cityId}.${variant}.json`)
  const { skeleton, grid, fingerprint } = await loadCity(cityId, variant)

  if (!force && existsSync(outFile)) {
    try {
      const saved = JSON.parse(await readFile(outFile, 'utf8'))
      if (JSON.stringify(saved.fingerprint) === JSON.stringify(fingerprint)) {
        return { skip: true, reason: 'exists' }
      }
    } catch { /* stale / corrupt → rebuild */ }
  }

  // base＝格網化後
  let cells = new Map([...grid.cellOf].map(([id, p]) => [id, [p[0], p[1]]]))
  const { segs } = buildHcGraph(skeleton, cells)
  const transcript = []
  let rounds = 0
  const hvd0 = countHVD(cells, segs)
  const t0 = performance.now()

  for (let r = 0; r < MAX_ROUNDS; r++) {
    const { segs: liveSegs } = buildHcGraph(skeleton, cells)
    const proposed = proposeMoves(liveSegs, cells, grid.cols, grid.rows)
    if (!proposed.size) break
    const targetEntries = [...proposed]
    const res = applyLlmTargets(skeleton, cells, grid.cols, grid.rows, targetEntries)
    rounds++
    transcript.push({
      round: rounds,
      note: `batch 啟發式：提案 ${proposed.size} 點短距對齊（H/V/對角）`,
      proposed: proposed.size,
      hv: `${res.stats.hvBefore} → ${res.stats.hvAfter}`,
      hvd: `${res.stats.hvdBefore} → ${res.stats.hvdAfter}`,
      rejected: res.stats.reverted ? proposed.size : Math.max(0, proposed.size - res.stats.moved),
    })
    cells = res.cellAfter
    if (res.stats.reverted || res.stats.hvdAfter <= res.stats.hvdBefore) break
    if (!res.stats.moved) break
  }

  // 0 offSeg／無進步也寫檔——畫廊要有「最初結果」、不能空白
  if (rounds === 0) {
    transcript.push({
      round: null,
      note: 'batch：格網化後已無未對齊段（或無可採短距移動）——存格網化後作最初結果',
      proposed: 0,
      hv: `${fingerprint.hvStart} → ${fingerprint.hvStart}`,
      rejected: 0,
    })
  }

  let movedVsBase = 0
  for (const [id, p] of cells) {
    const q = grid.cellOf.get(id)
    if (q && (q[0] !== p[0] || q[1] !== p[1])) movedVsBase++
  }
  const { segs: finalSegs } = buildHcGraph(skeleton, cells)
  const hvAfter = (() => {
    let n = 0
    for (const s of finalSegs) {
      const A = cells.get(s.a), B = cells.get(s.b)
      if ((A[0] === B[0]) !== (A[1] === B[1])) n++
    }
    return n
  })()
  const hvdAfter = countHVD(cells, finalSegs)

  const elapsedMs = Math.max(1, Math.round(performance.now() - t0))
  await mkdir(OUT, { recursive: true })
  await writeFile(outFile, JSON.stringify({
    fingerprint,
    model: MODEL,
    rounds,
    elapsedMs, // 面板「執行時間」讀這個（與 claudeSkillTrigger 同源欄位）
    prompt: '全球批次啟發式自動對齊（scripts/llmAlignBatch.mjs／batch-hvd）——非 headless Claude；原始／旋轉各算一次最初結果',
    transcript,
    hvBefore: fingerprint.hvStart,
    hvAfter,
    hvdBefore: hvd0,
    hvdAfter,
    segs: finalSegs.length,
    moved: movedVsBase,
    cellAfter: [...cells].map(([id, [c, r]]) => [id, c, r]),
  }))
  return {
    skip: false,
    rounds,
    elapsedMs,
    hv: `${fingerprint.hvStart}→${hvAfter}`,
    hvd: `${hvd0}→${hvdAfter}`,
    moved: movedVsBase,
  }
}

async function main() {
  const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'))
  const viewFiles = (index.systems ?? [])
    .map((s) => (s.file || '').split('/').pop()?.replace(/\.geojson$/, ''))
    .filter(Boolean)
    .sort()
  const cities = onlyCity ? viewFiles.filter((c) => c === onlyCity) : viewFiles
  if (onlyCity && !cities.length) {
    console.error(`找不到城市 ${onlyCity}`)
    process.exit(1)
  }

  const jobs = []
  for (const c of cities) {
    for (const v of ['orig', 'rot']) jobs.push([c, v])
  }

  let done = 0, skipped = 0, failed = 0
  const t0 = Date.now()
  for (const [c, v] of jobs) {
    if (limit && done >= limit) break
    try {
      const r = await runOne(c, v)
      if (r.skip) {
        skipped++
        continue
      }
      done++
      console.log(`✓ ${c}.${v}  rounds=${r.rounds}  ${r.elapsedMs}ms  hv ${r.hv}  hvd ${r.hvd}  moved=${r.moved}`)
    } catch (err) {
      failed++
      console.error(`✗ ${c}.${v}  ${err?.message ?? err}`)
    }
  }
  console.log(`\n完成：寫入 ${done}、跳過 ${skipped}、失敗 ${failed}／共 ${jobs.length}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
}

main().catch((e) => { console.error(e); process.exit(1) })
