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
const VIEWS_VERSION = 48 // 48: 目錄改名對齊圖層（map-adjust/straighten/rwd-maps）＋base＝格網化後；全量重算。
                         // 47: 直線演算法／循環 base＝格網化後（不再吃 HC）。
                         // 45: 全球 views/hcviews/rwdviews 強制重算（與 LLM 成方無關；llmshapes 已清空）。
                         // 43: ⑨ Shape-Guided 對齊論文 Smooth（固定 Ωc 最近點＋硬投影；非弧長）。
                         // 41: ⑨ Shape-Guided 形狀庫只留方形（拿掉圓）。
                         // 40: ⑨ Shape-Guided 形狀庫收成圓／方兩種（拿掉愛心／體育場）。
                         // 39: 新增論文⑨ Shape-Guided（kind shape）——自動選路＋
                         //     內建形狀（圓/愛心/體育場/方）、不適合略過；HC/RWD
                         //     畫廊每 variant +2 視圖（loop-shape / compact+rwd-shape）。
                         // 38: 論文忠實度校正（使用者：初步直線化與直線演算法一律照
                         //     data/thesis 的論文說明，不自創）——②冷卻改論文表 4
                         //     （R 8→1、最多 5 輪、總適應度收斂）＋§6.2 折彎群集；
                         //     ①具名筆畫優先＋4 主方向 H/V 先試斜線備援＋論文錨點規則；
                         //     ③⑧ 段長下限＝H3 最短邊長 hops；④改論文原力式＋PrEd
                         //     8 區域上限；⑥改論文成本常數（c_45/c_90/c_135/c_h/c_m）
                         //     ＋dangling 排程；⑦補最大彎角 90°/最小 link 長/ε 由資料定。
                         // 37: 使用者要求全球全部重算（鏈名帶論文圈號①〜⑧定案後的
                         //     全量基準版；演算法與 36 相同）。
                         // 36: 直線鏈改為與論文一一對應的 9 條（①〜⑧＋LLM）——
                         //     移除自創的 align/ilp 鏈，rect 併入論文②；HC 畫廊
                         //     13→11 視圖/variant、RWD 畫廊 22→18 視圖/variant，全城重算。
                         // 35: 新增七條論文直線鏈（stroke/milp/sat/force/lsq/octi/path，
                         //     src/stores/paperAlign.js）——HC 畫廊 6→13 視圖/variant、
                         //     RWD 畫廊 8→22 視圖/variant，全城重算。
                         // 34: RWD 畫線器 deskew-v18——「能 45 就不用 22.5」補強：joint 重算
                         //     依 (skew, 折數) 取捨＋收尾 deskewPass 把走廊空出後的 22.5 段
                         //     升回 45 級（全 234 城 22.5 腿 341→316、cross/forced 不變）。
                         // 33: RWD 畫線器 joint-cross-v17——交叉對聯合重算改直接偵測真交叉
                         //     （與 forced 旗標脫鉤）＋成對 rip＋A* 升級（含解鎖直線讓路）。
                         //     全 234 城交叉對 139→112、forced 164→132、折數僅 +0.1%。
                         // 32: RWD 畫線器 skew-mix-v16——16 方向補 45＋22.5 混合／雙折 22.5
                         //     候選家族、A* 樓梯→45 後處理（destairPass）、pickBest 補
                         //     路徑總長最弱 tie-break（全 234 城 forced 208→164、樓梯 26→8）。
                         // 31: 河流全點保留（-lm 檔）＋骨架河流粉紅改絕對 0.2km 容差（巴黎長弦案）。
                         // 30: 格網化吸附後修復（repairOcclusions，大邱重疊案——排名吸附不再產出
                         //     壓點/交叉/共線重疊）＋ validShift ③′ 變形段檢查＋compactGridSafe。
                         // 29: 移除深色線 halo（使用者 2026-07-17：知道黑線在深背景看不見即可，
                         // 不要描邊改回去）——v28 檔內含 halo 線條需全量重算掉
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
    o: null, r: null, og: 0, rg: 0, om: null, rm: null,
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
    }))
    const llmOpts = { llmByVariant, shapeByVariant, cityId: id }

    // 8 Map Adjust views
    try {
      (await buildOrReuse(OUT, computeCityViews, catalog, sys, id, geojson, fp, false)) === 'reused' ? reused++ : rebuilt++
      ok++
    } catch (err) {
      failures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }

    // Hill Climbing／Straighten 畫廊（含 LLM 對齊循環，有 llmviews 才寫入）
    try {
      // fp 加演算法版本後綴 + llm／shape 指紋：結果更新 → 該城縮圖重算。
      // 無成方的城可沿用舊 _fp（無 :shape=）；有 llmshapes 的城因 shapeFp 變而重算。
      const hcFp = `${fp}:hc-loop-v4:llm=${llmFp}:shape=${shapeFp}`
      ;(await buildOrReuse(HC_OUT, computeCityHcViews, hcCatalog, sys, id, geojson, hcFp, true, llmOpts, shapeFp)) === 'reused' ? reused++ : rebuilt++
      hcOk++
    } catch (err) {
      hcFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }

    // RWD Maps views（含 LLM 對齊 compact/rwd，有 llmviews 才寫入）
    try {
      const rwdFp = `${fp}:rwd-loop-v6:llm=${llmFp}:shape=${shapeFp}`
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
