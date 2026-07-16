// One-off additive builder: 「城市＋地標」combined systems.
//
// 使用者裁決（2026-07，最終版）：**河流就是 network 的一條線**——不再是特殊的地標 overlay。
// 本檔把每條河流「轉成真正的網路路線」：
//   · 河流折線簡化成**站級顯著點**（端點、跨河匯流點、主要轉折；相對 DP 容差 0.10）——
//     跟地鐵一樣「每個頂點都是站」（本資料的線幾何本來就＝站點依序連線，不留中間折點）。
//   · 產出**真的車站 Point features**（帶 `river: true` 旗標，地圖不畫站圈、D3 依骨架分類
//     只顯示 藍端點/紅匯流/粉紅轉折/黃交叉，黑不畫）＋**真的路段 feature**（routes[] schema
//     與地鐵完全相同，route_id=`river:{landmark_id}`、色 #00E5FF）。
//   · 跨河匯流＝兩條河共用同一個車站節點 → 骨架 degree≥3 自然變紅。
//   · 皇居/公園面域仍是地標 overlay（不轉網路）；河流 LineString 地標**不再輸出**。
// 這樣骨架/交叉/格網化/爬山（Straighten）/RWD 全部把河流當一般線處理——**零特例**。
//
// 來源：data/metro/landmarks/**（fetchLandmarks.mjs 產生，仍是地標資料的產地）。
// 產出：data/metro/systems/**/{slug}-lm.geojson ＋ index.json ＋ cityNamesZh.json。
//
//   node scripts/buildLandmarkCombined.mjs
//
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const METRO = join(__dirname, '..', 'data', 'metro')

const RIVER_COLOR = '#00E5FF' // 瑩光天藍（使用者指定）
const DP_TOL_KM = 0.2         // 絕對 DP：偏離弦線 > 0.2 km 才留轉折（站級簡化、保河形——
                              // 相對容差在長河會失效：大漢溪整體平緩弧、最大偏移 <10% 弦長，
                              // 曾被縮成頭尾 2 點直線＝「不像原始資料」）
const JUNCTION_KM = 0.15      // 河流端點離另一條河 ≤150m 視為匯流

// 遞迴列出 landmarks 下所有 .geojson（相對 landmarks/ 的路徑）
async function listLandmarks(dir, base = dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) await listLandmarks(p, base, out)
    else if (ent.name.endsWith('.geojson')) out.push(p.slice(base.length + 1))
  }
  return out
}

// ---- 幾何（經度依中緯度縮放的平面近似）----
const kmXY = (lat0) => {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180)
  return (p) => [p[0] * kx, p[1] * 110.574]
}
function distKm(a, b, toXY) {
  const A = toXY(a), B = toXY(b)
  return Math.hypot(A[0] - B[0], A[1] - B[1])
}
// 絕對 DP：保留「垂距 > tolKm（公里）」的最遠內點，遞迴兩半。索引寫進 keep（Set）。
function dpRec(pts, i0, i1, tolKm, keep, toXY) {
  if (i1 <= i0 + 1) return
  const A = toXY(pts[i0]), B = toXY(pts[i1])
  const dx = B[0] - A[0], dy = B[1] - A[1]
  const chord = Math.hypot(dx, dy)
  let maxD = -1, maxI = -1
  for (let i = i0 + 1; i < i1; i++) {
    const P = toXY(pts[i])
    const d = chord < 1e-9
      ? Math.hypot(P[0] - A[0], P[1] - A[1])
      : Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / chord
    if (d > maxD) { maxD = d; maxI = i }
  }
  if (maxI < 0) return
  if (maxD > tolKm) {
    keep.add(maxI)
    dpRec(pts, i0, maxI, tolKm, keep, toXY)
    dpRec(pts, maxI, i1, tolKm, keep, toXY)
  }
}

// 河流 → 站級點序（端點＋匯流強制保留、主要轉折 DP 保留）＋跨河匯流共點
function riversToRoutes(riverFeats, slug, city, country) {
  if (!riverFeats.length) return { stations: [], segments: [] }
  const lat0 = riverFeats[0].geometry.coordinates[0][1]
  const toXY = kmXY(lat0)
  const rivers = riverFeats.map((f) => ({
    name: f.properties.name,
    nameEn: f.properties.name_en ?? null,
    lmId: f.properties.landmark_id,
    coords: f.geometry.coordinates.map((c) => c.slice()),
    forced: new Set(), // 匯流點索引（強制保留）
  }))
  // 匯流：A 的端點 ≤150m 於 B 的某折點 → A 端點吸到 B 折點座標（共點）、B 強制保留該折點
  for (const A of rivers) {
    for (const endIdx of [0, A.coords.length - 1]) {
      const e = A.coords[endIdx]
      for (const B of rivers) {
        if (B === A) continue
        let bi = -1, bd = Infinity
        B.coords.forEach((c, i) => { const d = distKm(e, c, toXY); if (d < bd) { bd = d; bi = i } })
        if (bi >= 0 && bd <= JUNCTION_KM) {
          A.coords[endIdx] = B.coords[bi].slice() // 共點（座標完全一致 → 共站）
          B.forced.add(bi)
        }
      }
    }
  }
  // 每條河：端點＋匯流＋DP 轉折 → 站序
  const stationByKey = new Map() // 座標鍵 → station feature（跨河共站）
  const stations = [], segments = []
  let seq = 0
  for (const r of rivers) {
    const keep = new Set([0, r.coords.length - 1, ...r.forced])
    const idxs = [...keep].sort((a, b) => a - b)
    for (let k = 1; k < idxs.length; k++) dpRec(r.coords, idxs[k - 1], idxs[k], DP_TOL_KM, keep, toXY)
    const kept = [...keep].sort((a, b) => a - b).map((i) => r.coords[i])
    if (kept.length < 2) continue
    const stList = kept.map((c) => {
      const key = `${c[0].toFixed(6)},${c[1].toFixed(6)}`
      let st = stationByKey.get(key)
      if (!st) {
        st = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c },
          properties: {
            station_id: `nrv${slug}-${seq++}`,
            station_name: r.name, station_name_local: r.name, station_name_en: r.nameEn,
            network: null, network_local: null, operator: null, city, country,
            lines: [r.name], wikidata: null, wikipedia: null,
            merged_from: 1, merged_names: null, is_terminus: false, codes: null,
            routes: [{ ref: null, name: r.name }],
            pass_count: 0, station_degree: 0, is_interchange: false, station_role: 'normal',
            river: true, // 河流站點旗標：地圖不畫站圈、D3 依骨架分類只畫顯著點
          },
        }
        stationByKey.set(key, st)
        stations.push(st)
      } else if (!st.properties.lines.includes(r.name)) {
        // 匯流共站：兩條河共用一個節點
        st.properties.lines.push(r.name)
        st.properties.routes.push({ ref: null, name: r.name })
      }
      return st
    })
    segments.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: [stList.map((s) => s.geometry.coordinates)] },
      properties: {
        seg_id: `${slug}-river-${segments.length}`,
        routes: [{
          route_id: `river:${r.lmId}`,
          route_name: r.name, route_name_local: r.name, route_name_en: r.nameEn,
          route_ref: null, route_color: RIVER_COLOR,
          network: null, network_local: null, operator: null,
          wikidata: null, wikipedia: null, osm_route_ids: [],
          status: null, order_suspect: 0, river: true,
          stations: stList.map((s) => ({ station_id: s.properties.station_id, station_name: s.properties.station_name })),
        }],
        route_count: 1, route_refs: [], route_colors: [RIVER_COLOR],
        city, country, river: true,
      },
    })
  }
  return { stations, segments }
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
  // 河流 → 網路路線；面域（皇居/公園）仍是地標 overlay
  const riverFeats = lm.features.filter((f) => f.geometry.type === 'LineString' && /river/.test(f.properties.kind || ''))
  const areaFeats = lm.features.filter((f) => !riverFeats.includes(f))
  const rv = riversToRoutes(riverFeats, slug, cityEn, m.country)

  const combined = {
    type: 'FeatureCollection',
    metro_system: {
      ...m,
      city: cityEn,
      combined_landmark: true,
      landmark_count: lm.features.length,
      landmark_kinds: [...new Set(lm.features.map((f) => f.properties.kind))],
      combined_note: `Metro（${m.city}）＋ 地標（河流＝網路路線 ${rv.segments.length} 條／面域 ${areaFeats.length} 項；一次性附加）`,
      audit: null,
    },
    // metro features → 河流網路（站＋段）→ 面域地標
    features: [...base.features, ...rv.stations, ...rv.segments, ...areaFeats],
  }

  const outRel = rel.replace(/\.geojson$/, '-lm.geojson')
  await writeFile(join(METRO, 'systems', outRel), JSON.stringify(combined))
  console.log(`wrote systems/${outRel}  (metro ${base.features.length} + river ${rv.segments.length}線/${rv.stations.length}點 + 面域 ${areaFeats.length})`)

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
