// One-off additive builder: 「城市＋地標」combined systems.
//
// 使用者裁決（2026-07）：把有河流/地標的城市，做成「城市＋地標」的合併 geojson——
// metro 的路線/車站 features ＋ 地標 features（河流骨架線、皇居/公園面域）合在同一個
// FeatureCollection，成為**全新的系統檔**（概念同 東京＋山手 的 buildJrCombined）：
//   · 不動原本城市的 geojson（base metro 檔照舊）。
//   · 前端不再單獨載入地標 overlay geojson——地標 features 內嵌在合併檔裡，由 LayerTab
//     以 `landmark_id` 辨識、用地標樣式（fill/骨架線＋hover/highlight/物件 tab）渲染。
//
// 來源：data/metro/landmarks/**（由 fetchLandmarks.mjs 產生，仍是地標資料的產地）。
// 產出：data/metro/systems/**/{slug}-lm.geojson ＋ index.json ＋ cityNamesZh.json 新條目。
//
//   node scripts/buildLandmarkCombined.mjs
//
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const METRO = join(__dirname, '..', 'data', 'metro')

// 遞迴列出 landmarks 下所有 .geojson（相對 landmarks/ 的路徑）
async function listLandmarks(dir, base = dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) await listLandmarks(p, base, out)
    else if (ent.name.endsWith('.geojson')) out.push(p.slice(base.length + 1))
  }
  return out
}

const entries = []
const zhPath = join(__dirname, '..', 'src', 'stores', 'cityNamesZh.json')
const zh = JSON.parse(await readFile(zhPath, 'utf8'))

const rels = await listLandmarks(join(METRO, 'landmarks'))
for (const rel of rels) {
  const slug = basename(rel, '.geojson')
  const basePath = join(METRO, 'systems', rel)
  let base
  try { base = JSON.parse(await readFile(basePath, 'utf8')) }
  catch { console.log(`[skip] ${slug}: no base metro ${rel}`); continue }
  const lm = JSON.parse(await readFile(join(METRO, 'landmarks', rel), 'utf8'))

  const m = base.metro_system
  const cityEn = `${m.city} + Landmark`
  const combined = {
    type: 'FeatureCollection',
    metro_system: {
      ...m,
      city: cityEn,
      combined_landmark: true,
      landmark_count: lm.features.length,
      landmark_kinds: [...new Set(lm.features.map((f) => f.properties.kind))],
      combined_note: `Metro（${m.city}）＋ 地標（河流骨架／皇居・公園，${lm.features.length} 項；一次性附加）`,
      audit: null,
    },
    // metro features 在前、地標 features 在後（前端用 landmark_id 辨識地標）
    features: [...base.features, ...lm.features],
  }

  const outRel = rel.replace(/\.geojson$/, '-lm.geojson')
  await writeFile(join(METRO, 'systems', outRel), JSON.stringify(combined))
  console.log(`wrote systems/${outRel}  (metro ${base.features.length} + landmark ${lm.features.length})`)

  entries.push({
    file: `systems/${outRel}`,
    continent: m.continent, country: m.country, city: cityEn,
    osm_networks: m.osm_networks, operator: m.operator,
    official_website: m.official_website, official_map: m.official_map,
    wikidata: m.wikidata, line_count: m.line_count,
    segment_count: m.segment_count, station_count: m.station_count,
    audit: null,
  })
  // 中文名：城市＋地標（沿用 base 的 cityZh）
  const bz = zh[slug]
  zh[`${slug}-lm`] = { country: bz?.country ?? m.country, city: `${bz?.city ?? m.city}＋地標` }
}

// index.json：附加新系統（已存在則覆蓋）
const idxPath = join(METRO, 'index.json')
const idx = JSON.parse(await readFile(idxPath, 'utf8'))
for (const e of entries) {
  const at = idx.systems.findIndex((s) => s.file === e.file)
  if (at >= 0) idx.systems[at] = e
  else idx.systems.push(e)
}
idx.system_count = idx.systems.length
await writeFile(idxPath, JSON.stringify(idx, null, 2))
await writeFile(zhPath, JSON.stringify(zh, null, 2) + '\n')
console.log(`\nindex.json: ${idx.systems.length} systems; added ${entries.length} 城市＋地標`)
