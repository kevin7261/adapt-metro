// Pre-compute the per-city view thumbnails the galleries render as SVG:
//   • 8 Map Adjust views   → data/metro/views/<id>.json
//   • 12 Hill Climbing views → data/metro/hcviews/<id>.json
// plus an index.json catalog in each dir.
//
//   in : data/metro/index.json + data/metro/systems/**/*.geojson
//   out: data/metro/views/<id>.json     (原始/旋轉/骨架化/格網化前後 ×…)
//        data/metro/hcviews/<id>.json    (格網化後/Hill Climbing/4 循環 hc/rect/align/ilp)
//        data/metro/{views,hcviews}/index.json
//
// The geometry is produced by src/stores/viewGeometry.js — the SAME pure
// stores the live Map Adjust / Hill Climbing tab (D3Tab.vue) uses — so the
// thumbnails match the interactive views. Run after metro:build.
//
//   node scripts/buildViews.mjs
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeCityViews, computeCityHcViews, computeCityRwdViews, HC_VIEW_ORDER, RWD_VIEW_ORDER } from '../src/stores/viewGeometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const OUT = join(BASE, 'views')
const HC_OUT = join(BASE, 'hcviews')
const RWD_OUT = join(BASE, 'rwdviews')

// Same id the gallery/layer derive from a system file: the basename sans ext.
const idOf = (file) => file.split('/').pop().replace(/\.geojson$/, '')

// 增量重算的指紋：`VIEWS_VERSION:<城市 geojson 內容雜湊>`，寫進每個 view 檔的 `_fp`。
// 重跑時 `_fp` 沒變就沿用舊檔、只重算內容變了的城市（配合 metro:build 串接，等於
// 「某城 metro 資料一重抓/重建 → 該城衍生檔自動重算」）。**改了畫線程式（viewGeometry.js
// 或其相依 store）就把 VIEWS_VERSION 遞增**，強制全部重算（否則 geojson 沒變會誤沿用舊圖）。
const VIEWS_VERSION = 31 // 31: 河流全點保留（-lm 檔）＋骨架河流粉紅改絕對 0.2km 容差（巴黎長弦案）。
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
  const systems = index.systems ?? []
  if (!systems.length) {
    console.error('index.json 沒有 systems[]，請先跑 npm run metro:build')
    process.exit(1)
  }

  // 增量：不清空目錄（保留 _fp 未變、可沿用的舊檔）；只確保目錄存在。
  // 已移除的城市留下的殘檔在最後依 currentIds 清掉。
  await mkdir(OUT, { recursive: true })
  await mkdir(HC_OUT, { recursive: true })
  await mkdir(RWD_OUT, { recursive: true })
  const currentIds = new Set(systems.map((sys) => idOf(sys.file)))

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

  // 一型一城：`_fp` 未變就沿用舊檔（讀回 meta 進 catalog）、否則重算並寫入 `_fp`。
  // 回傳 'reused' | 'built'；丟出例外交給呼叫端記 failure。
  async function buildOrReuse(dir, computeFn, cat, sys, id, geojson, fp, withStats) {
    const outPath = join(dir, `${id}.json`)
    try {
      const existing = JSON.parse(await readFile(outPath, 'utf8'))
      if (existing._fp === fp) {
        cat.push({
          id, file: sys.file, city: sys.city, country: sys.country,
          cityZh: CITY_ZH[id]?.city ?? sys.city, countryZh: CITY_ZH[id]?.country ?? sys.country,
          continent: sys.continent, line_count: sys.line_count, station_count: sys.station_count,
          tilt: existing.tilt, canRotate: existing.canRotate,
        })
        return 'reused'
      }
    } catch { /* 無舊檔／壞檔／舊格式無 _fp → 重算 */ }
    const r = computeFn(geojson)
    const out = { ...meta(sys, id, r), W: r.W, H: r.H, views: r.views, _fp: fp }
    if (withStats) out.stats = r.stats
    await writeFile(outPath, JSON.stringify(out))
    cat.push(meta(sys, id, r))
    return 'built'
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

    // 8 Map Adjust views
    try {
      (await buildOrReuse(OUT, computeCityViews, catalog, sys, id, geojson, fp, false)) === 'reused' ? reused++ : rebuilt++
      ok++
    } catch (err) {
      failures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }

    // 12 Hill Climbing views（視圖畫廊：原始＋旋轉 × 格網化後/Hill Climbing＋4 循環）
    try {
      // fp 加演算法版本後綴：HC 畫廊＝原始＋旋轉 兩 variant × 6 階段（格網化後/
      // Hill Climbing＋4 個循環結果 straightenCompactLoop，2026-07），純資料指紋
      // 不會觸發重算，靠這個後綴強制重建（views/rwdviews 內容未變、沿用快取）。
      (await buildOrReuse(HC_OUT, computeCityHcViews, hcCatalog, sys, id, geojson, `${fp}:hc-loop-v3`, true)) === 'reused' ? reused++ : rebuilt++
      hcOk++
    } catch (err) {
      hcFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }

    // 16 RWD Maps views (原始＋旋轉 × 4 縮減網格變體 × 縮減網格|RWD 路網)
    try {
      // fp 加演算法版本後綴：RWD 縮圖建立在 straightenCompactLoop（端+直+中+縮
      // 循環）上，且加上旋轉 variant（2026-07），純資料指紋不會觸發重算，靠這個
      // 後綴強制全量重建。
      (await buildOrReuse(RWD_OUT, computeCityRwdViews, rwdCatalog, sys, id, geojson, `${fp}:rwd-loop-v5`, false)) === 'reused' ? reused++ : rebuilt++
      rwdOk++
    } catch (err) {
      rwdFailures.push({ id, city: sys.city, error: String(err?.message ?? err) })
    }
  }

  // 清掉已移除城市的殘檔（currentIds 之外的 <id>.json）。
  let pruned = 0
  for (const dir of [OUT, HC_OUT, RWD_OUT]) {
    let names
    try { names = await readdir(dir) } catch { continue }
    for (const n of names) {
      if (n === 'index.json' || !n.endsWith('.json')) continue
      if (!currentIds.has(n.replace(/\.json$/, ''))) { await rm(join(dir, n), { force: true }); pruned++ }
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
    view_ids: HC_VIEW_ORDER,
    system_count: hcCatalog.length,
    systems: hcCatalog,
  }))
  await writeFile(join(RWD_OUT, 'index.json'), JSON.stringify({
    generated_from: 'scripts/buildViews.mjs',
    view_ids: RWD_VIEW_ORDER,
    system_count: rwdCatalog.length,
    systems: rwdCatalog,
  }))

  console.log(`views:   ${ok}/${systems.length} 城市 → data/metro/views/`)
  console.log(`hcviews: ${hcOk}/${systems.length} 城市 → data/metro/hcviews/`)
  console.log(`rwdviews: ${rwdOk}/${systems.length} 城市 → data/metro/rwdviews/`)
  console.log(`增量：重算 ${rebuilt} 檔、沿用 ${reused} 檔${pruned ? `、清除 ${pruned} 殘檔` : ''}（VIEWS_VERSION=${VIEWS_VERSION}）`)
  for (const f of failures) console.log(`  ✗ views   ${f.id} (${f.city}) — ${f.error}`)
  for (const f of hcFailures) console.log(`  ✗ hcviews ${f.id} (${f.city}) — ${f.error}`)
  for (const f of rwdFailures) console.log(`  ✗ rwdviews ${f.id} (${f.city}) — ${f.error}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
