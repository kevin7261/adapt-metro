// Pre-compute the per-city view thumbnails the galleries render as SVG:
//   • Map Adjust views   → data/metro/map-adjust/<id>.json
//   • Straighten views   → data/metro/straighten/<id>.json（含 LLM 對齊循環，若有 llmviews）
//   • RWD Maps views     → data/metro/rwd-maps/<id>.json（含 LLM compact/rwd）
// plus an index.json catalog in each dir.
//
//   in : data/metro/index.json + data/metro/metro-maps/**/*.geojson
//        + data/metro/straighten-llm/<id>.{orig,rot}.json（可選；有則預算 LLM 縮圖）
//   out: data/metro/map-adjust/<id>.json
//        data/metro/straighten/<id>.json
//        data/metro/rwd-maps/<id>.json
//        data/metro/{views,hcviews,rwdviews}/index.json
//
// The geometry is produced by src/stores/viewGeometry.js — the SAME pure
// stores the live Map Adjust / Hill Climbing tab (D3Tab.vue) uses — so the
// thumbnails match the interactive views. Run after metro:build（與
// scripts/llmAlignBatch.mjs 全球 LLM 對齊之後重跑，畫廊才消「尚未預算」）.
//
//   node scripts/buildViews.mjs
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeCityViews, computeCityHcViews, computeCityRwdViews, HC_VIEW_ORDER, RWD_VIEW_ORDER } from '../src/stores/viewGeometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const OUT = join(BASE, 'map-adjust')
const HC_OUT = join(BASE, 'straighten')
const RWD_OUT = join(BASE, 'rwd-maps')

// Same id the gallery/layer derive from a system file: the basename sans ext.
const idOf = (file) => file.split('/').pop().replace(/\.geojson$/, '')

// 增量重算的指紋：`VIEWS_VERSION:<城市 geojson 內容雜湊>`，寫進每個 view 檔的 `_fp`。
// 重跑時 `_fp` 沒變就沿用舊檔、只重算內容變了的城市（配合 metro:build 串接，等於
// 「某城 metro 資料一重抓/重建 → 該城衍生檔自動重算」）。**改了畫線程式（viewGeometry.js
// 或其相依 store）就把 VIEWS_VERSION 遞增**，強制全部重算（否則 geojson 沒變會誤沿用舊圖）。
const VIEWS_VERSION = 52 // 52: Straighten 畫廊 loop-* 優先畫 straighten-cells（與 D3Tab 一致）。
                         // 51: 直線縮減四方向＋H/V 變多就要移（endp→loop／RWD 重烤）。
                         // 49: RWD 形狀變體預算（frozenIds／shapeLock；square===true 才烤）。
                         // 48: 目錄改名對齊圖層（map-adjust/straighten/rwd-maps）＋base＝格網化後；全量重算。
const strHash = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// 中文城市／國名（cityNamesZh.json，以 geojson stem 為 key）—— 寫進每個 view
// index.json，讓三個視圖畫廊的卡片標題能中英並列（同 loadMetroCatalog）。
const CITY_ZH = JSON.parse(await readFile(join(__dirname, '..', 'src', 'stores', 'cityNamesZh.json'), 'utf8'))

async function main() {
  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const allSystems = index.systems ?? []
  // 可選：node scripts/buildViews.mjs [cityId…] 只重算指定城（例成方城）。
  const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith('-')))
  const systems = allSystems.filter((sys) => !only.size || only.has(idOf(sys.file)))
  if (!systems.length) {
    console.error(only.size
      ? `找不到指定城市：${[...only].join(', ')}`
      : 'index.json 沒有 systems[]，請先跑 npm run metro:build')
    process.exit(1)
  }
  if (only.size) console.log(`只重算 ${systems.length} 城：${systems.map((s) => idOf(s.file)).join(', ')}`)

  // 增量：不清空目錄（保留 _fp 未變、可沿用的舊檔）；只確保目錄存在。
  // 已移除的城市留下的殘檔在最後依 currentIds 清掉（全量 catalog，非 only 子集）。
  await mkdir(OUT, { recursive: true })
  await mkdir(HC_OUT, { recursive: true })
  await mkdir(RWD_OUT, { recursive: true })
  const currentIds = new Set(allSystems.map((sys) => idOf(sys.file)))

  const catalog = []
  const hcCatalog = []
  const rwdCatalog = []
  let ok = 0
  let hcOk = 0
  let rwdOk = 0
  let reused = 0   // 沿用（_fp 未變）的檔數（三型合計）
  let rebuilt = 0  // 重算的檔數（三型合計）
  const failures = []
  const hcFailures = []
  const rwdFailures = []

  const meta = (sys, id, r) => ({
    id,
    file: sys.file,
    city: sys.city,
    country: sys.country,
    cityZh: CITY_ZH[id]?.city ?? sys.city,
    countryZh: CITY_ZH[id]?.country ?? sys.country,
    continent: sys.continent,
    line_count: sys.line_count,
    station_count: sys.station_count,
    tilt: +r.tilt.toFixed(2),
    canRotate: r.canRotate,
  })

  // 無 llmshapes 時的 shape 指紋——舊檔 _fp 尚無 `:shape=` 後綴時，若本城也無
  // 成方結果，視為同等（避免為了加 shape= 後綴而全量重算 240 城）。
  const EMPTY_SHAPE_FP = strHash(JSON.stringify({
    o: null, r: null, og: 0, rg: 0, om: null, rm: null, os: false, rs: false,
  }))

  // 一型一城：`_fp` 未變就沿用舊檔（讀回 meta 進 catalog）、否則重算並寫入 `_fp`。
  // 回傳 'reused' | 'built'；丟出例外交給呼叫端記 failure。
  // computeOpts 傳給 computeFn（例：llmByVariant 讓 HC/RWD 預算 LLM 對齊縮圖）。
  async function buildOrReuse(dir, computeFn, cat, sys, id, geojson, fp, withStats, computeOpts, shapeFp = null) {
    const outPath = join(dir, `${id}.json`)
    try {
      const existing = JSON.parse(await readFile(outPath, 'utf8'))
      const legacyOk = shapeFp === EMPTY_SHAPE_FP
        && typeof existing._fp === 'string'
        && !existing._fp.includes(':shape=')
        && fp === `${existing._fp}:shape=${shapeFp}`
      if (existing._fp === fp || legacyOk) {
        cat.push({
          id, file: sys.file, city: sys.city, country: sys.country,
          cityZh: CITY_ZH[id]?.city ?? sys.city, countryZh: CITY_ZH[id]?.country ?? sys.country,
          continent: sys.continent, line_count: sys.line_count, station_count: sys.station_count,
          tilt: existing.tilt, canRotate: existing.canRotate,
        })
        return 'reused'
      }
    } catch { /* 無舊檔／壞檔／舊格式無 _fp → 重算 */ }
    const t0 = Date.now()
    const r = computeFn(geojson, computeOpts)
    const ms = Date.now() - t0
    const out = { ...meta(sys, id, r), W: r.W, H: r.H, views: r.views, _fp: fp }
    if (withStats) out.stats = r.stats
    await writeFile(outPath, JSON.stringify(out))
    cat.push(meta(sys, id, r))
    const total = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
    if (withStats) console.log(`  ✓ ${id}  ${total}`)
    return 'built'
  }

  async function readLlm(id, variant) {
    try {
      return JSON.parse(await readFile(join(BASE, 'straighten-llm', `${id}.${variant}.json`), 'utf8'))
    } catch { return null }
  }
  async function readShape(id, variant) {
    try {
      return JSON.parse(await readFile(join(BASE, 'straighten-shape', `${id}.${variant}.json`), 'utf8'))
    } catch { return null }
  }
  // straighten-cells（與 D3Tab「重新計算」同一份）——有則畫廊 loop-* 直接畫它，
  // 保證縮圖＝點進去看到的真結果。
  async function readCells(id, variant, shapelike = false) {
    const name = `${id}.${variant}${shapelike ? '.shapelike' : ''}.json`
    try {
      return JSON.parse(await readFile(join(BASE, 'straighten-cells', name), 'utf8'))
    } catch { return null }
  }

  for (const sys of systems) {
    const id = idOf(sys.file)
    let raw, geojson
    try {
      raw = await readFile(join(BASE, sys.file), 'utf8')
      geojson = JSON.parse(raw)
    } catch (err) {
      failures.push({ id, city: sys.city, error: String(err?.message ?? err) })
      hcFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
      continue
    }
    const fp = `${VIEWS_VERSION}:${strHash(raw)}` // 內容一變指紋就變 → 該城三型全部重算
    // LLM 對齊結果納入 HC/RWD 指紋：llmviews 一寫入／更新就重算該城縮圖（消「尚未預算」）。
    const llmByVariant = { orig: await readLlm(id, 'orig'), rot: await readLlm(id, 'rot') }
    const llmFp = strHash(JSON.stringify({
      orig: llmByVariant.orig?.fingerprint ?? null,
      rot: llmByVariant.rot?.fingerprint ?? null,
      oHv: llmByVariant.orig?.hvAfter ?? null,
      rHv: llmByVariant.rot?.hvAfter ?? null,
      oMv: llmByVariant.orig?.moved ?? null,
      rMv: llmByVariant.rot?.moved ?? null,
    }))
    // LLM 成方結果（llmshapes）→ 畫廊形狀變體縮圖（loop-*-shape／rwd-*-shape）。
    const shapeByVariant = { orig: await readShape(id, 'orig'), rot: await readShape(id, 'rot') }
    const shapeFp = strHash(JSON.stringify({
      o: shapeByVariant.orig?.fingerprint ?? null, r: shapeByVariant.rot?.fingerprint ?? null,
      og: (shapeByVariant.orig?.greens ?? []).length, rg: (shapeByVariant.rot?.greens ?? []).length,
      om: shapeByVariant.orig?.moved ?? null, rm: shapeByVariant.rot?.moved ?? null,
      os: shapeByVariant.orig?.square === true, rs: shapeByVariant.rot?.square === true,
    }))
    const cellsByVariant = {
      orig: await readCells(id, 'orig'),
      rot: await readCells(id, 'rot'),
      'orig-shape': await readCells(id, 'orig-shape', true),
      'rot-shape': await readCells(id, 'rot-shape', true),
    }
    const cellsFp = strHash(JSON.stringify({
      o: cellsByVariant.orig?.fingerprint ?? null,
      r: cellsByVariant.rot?.fingerprint ?? null,
      os: cellsByVariant['orig-shape']?.fingerprint ?? null,
      rs: cellsByVariant['rot-shape']?.fingerprint ?? null,
      oAlgo: cellsByVariant.orig?.algo ?? null,
      // loop 尺寸一變（演算法改）就重烤縮圖
      oLoop: Object.fromEntries(Object.entries(cellsByVariant.orig?.loops ?? {}).map(([k, L]) => [k, [L?.cols, L?.rows]])),
      rLoop: Object.fromEntries(Object.entries(cellsByVariant.rot?.loops ?? {}).map(([k, L]) => [k, [L?.cols, L?.rows]])),
    }))
    const llmOpts = { llmByVariant, shapeByVariant, cellsByVariant, cityId: id }

    // 8 Map Adjust views
    try {
      (await buildOrReuse(OUT, computeCityViews, catalog, sys, id, geojson, fp, false)) === 'reused' ? reused++ : rebuilt++
      ok++
    } catch (err) {
      failures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }

    // Hill Climbing／Straighten 畫廊（含 LLM 對齊循環，有 llmviews 才寫入）
    try {
      // fp 加演算法版本後綴 + llm／shape／cells 指紋：cells 更新 → 縮圖跟真結果走。
      const hcFp = `${fp}:hc-loop-v6:llm=${llmFp}:shape=${shapeFp}:cells=${cellsFp}`
      ;(await buildOrReuse(HC_OUT, computeCityHcViews, hcCatalog, sys, id, geojson, hcFp, true, llmOpts, shapeFp)) === 'reused' ? reused++ : rebuilt++
      hcOk++
    } catch (err) {
      hcFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }

    // RWD Maps views（含 LLM 對齊 compact/rwd，有 llmviews 才寫入）
    try {
      const rwdFp = `${fp}:rwd-loop-v7:llm=${llmFp}:shape=${shapeFp}`
      ;(await buildOrReuse(RWD_OUT, computeCityRwdViews, rwdCatalog, sys, id, geojson, rwdFp, false, llmOpts, shapeFp)) === 'reused' ? reused++ : rebuilt++
      rwdOk++
    } catch (err) {
      rwdFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }
  }

  // 清掉已移除城市的殘檔（currentIds 之外的 <id>.json）。只重算子集時不剪枝。
  let pruned = 0
  if (!only.size) {
    for (const dir of [OUT, HC_OUT, RWD_OUT]) {
      let names
      try { names = await readdir(dir) } catch { continue }
      for (const n of names) {
        if (n === 'index.json' || !n.endsWith('.json')) continue
        if (!currentIds.has(n.replace(/\.json$/, ''))) { await rm(join(dir, n), { force: true }); pruned++ }
      }
    }
  }

  // 全量：catalog 即全部；子集：與既有 index 合併（只覆寫重算的城）。
  async function mergeCatalog(dir, built, viewIds) {
    let systems = built
    if (only.size) {
      let prev = []
      try { prev = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).systems ?? [] } catch { /* */ }
      const byId = new Map(prev.map((s) => [s.id, s]))
      for (const s of built) byId.set(s.id, s)
      systems = allSystems.map((sys) => byId.get(idOf(sys.file))).filter(Boolean)
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.json'), JSON.stringify({
      generated_from: 'scripts/buildViews.mjs',
      view_ids: viewIds,
      system_count: systems.length,
      systems,
    }))
  }
  await mergeCatalog(OUT, catalog, ['original', 'rotated', 'skeleton', 'rotated-skeleton',
    'grid-orig-pre', 'grid-orig-post', 'grid-rot-pre', 'grid-rot-post'])
  await mergeCatalog(HC_OUT, hcCatalog, HC_VIEW_ORDER)
  await mergeCatalog(RWD_OUT, rwdCatalog, RWD_VIEW_ORDER)

  console.log(`views:   ${ok}/${systems.length} 城市 → data/metro/map-adjust/`)
  console.log(`hcviews: ${hcOk}/${systems.length} 城市 → data/metro/straighten/`)
  console.log(`rwdviews: ${rwdOk}/${systems.length} 城市 → data/metro/rwd-maps/`)
  console.log(`增量：重算 ${rebuilt} 檔、沿用 ${reused} 檔${pruned ? `、清除 ${pruned} 殘檔` : ''}（VIEWS_VERSION=${VIEWS_VERSION}）`)
  for (const f of failures) console.log(`  ✗ views   ${f.id} (${f.city}) — ${f.error}`)
  for (const f of hcFailures) console.log(`  ✗ hcviews ${f.id} (${f.city}) — ${f.error}`)
  for (const f of rwdFailures) console.log(`  ✗ rwdviews ${f.id} (${f.city}) — ${f.error}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
