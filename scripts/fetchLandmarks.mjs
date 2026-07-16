// Fetch city landmark polygons (rivers / palace / park) as standalone GeoJSON
// under data/metro/landmarks/ — a separate layer from the metro map geojson.
// Does NOT touch the metro pipeline; see .claude/skills/landmark-osm-fetch/SKILL.md.
//
// Usage: node scripts/fetchLandmarks.mjs [cityId ...] [--refresh]
//        (no args = all configured cities)
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as overpass from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SYSTEMS = join(ROOT, 'data', 'metro', 'systems')
const OUT = join(ROOT, 'data', 'metro', 'landmarks')

// Per-city landmark spec.
//  rivers: [names] → these rivers' skeleton polylines (kind river-centerline),
//         from OSM waterway=river centerline ways — rivers are LINES only,
//         no water polygons (使用者 2026-07-16：骨架有 OSM data，不抓面域).
//         一項可為 { name, match: [...] }：同一條河在 OSM 的區段別名
//         （柏林 Spree 的市段叫 Treptower Spree/Müggelspree）聚成同一骨架圖。
//  named: exact-name polygon queries (palace / park), optionally tag-filtered;
//         pickLargest keeps only the largest polygon when the name is ambiguous.
const CITIES = {
  'as-twn-taipei': {
    // 裁切（使用者 2026-07）：基隆河只到汐止、新店溪只到新店、大漢溪只到鶯歌；
    // keep=台北車站（保留靠市中心那段——大漢溪河口在高經度側，不能用預設 min-lon 判side）。
    rivers: ['淡水河',
      { name: '基隆河', match: ['基隆河'], clip: [121.6428, 25.0656], keep: [121.5170, 25.0478] },
      { name: '新店溪', match: ['新店溪'], clip: [121.5423, 24.9577], keep: [121.5170, 25.0478] },
      { name: '大漢溪', match: ['大漢溪'], clip: [121.3454, 24.9541], keep: [121.5170, 25.0478] }],
  },
  'eu-gbr-london': { rivers: ['River Thames'] },
  'eu-ger-berlin': {
    rivers: [
      { name: 'Spree', match: ['Spree', 'Treptower Spree', 'Müggelspree'] },
      { name: 'Spreekanal', match: ['Spreekanal', 'Kupfergraben'] }, // waterway=canal（使用者 2026-07）
    ],
  },
  'eu-aut-vienna': { rivers: ['Donau'] }, // 只要多瑙河主流（使用者 2026-07-16）
  'eu-fra-paris': { rivers: ['La Seine'] },
  'as-kor-seoul': { rivers: ['한강'] },
  'as-chn-shanghai': { rivers: ['黄浦江'] },
  // 皇居本體（way 534754971）不含同在護城河內的東御苑，兩者合成完整皇居面域
  'as-jpn-tokyo': {
    named: [
      { kind: 'palace', name: '皇居' },
      { kind: 'palace', name: '皇居東御苑' },
    ],
  },
  'am-usa-new-york-city': {
    named: [{ kind: 'park', name: 'Central Park', tag: ['leisure', 'park'], pickLargest: true }],
  },
}

const BBOX_MARGIN = 0.05 // fraction of span added on each side
const MIN_CENTERLINE_KM = 1 // drop skeleton fragments below this length
const GAP_BRIDGE_KM = 4 // join same-river main lines whose endpoints are this close
const URBAN_TRIM_KM = 3 // 市區裁切：河流只保留「離任一地鐵站 ≤3km」的最長連續段（使用者 2026-07）

// 市區裁切（使用者：河流只要市區範圍、不是整條）——通用規則：只保留「離任一地鐵站
// ≤ URBAN_TRIM_KM」的**最長連續段**。有顯式 `clip` 的河（台北三條）不套用（範圍已由使用者裁定）。
function trimToUrban(line, stations, lat0) {
  if (!stations.length) return null
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.574
  const r2 = URBAN_TRIM_KM * URBAN_TRIM_KM
  const ok = line.map((p) => stations.some((s) => {
    const dx = (p[0] - s[0]) * kx, dy = (p[1] - s[1]) * ky
    return dx * dx + dy * dy <= r2
  }))
  let bs = 0, be = -1, s = -1
  for (let i = 0; i <= ok.length; i++) {
    if (i < ok.length && ok[i]) { if (s < 0) s = i }
    else if (s >= 0) { if (i - 1 - s > be - bs) { bs = s; be = i - 1 } s = -1 }
  }
  if (be - bs < 1) return null
  return line.slice(bs, be + 1)
}

async function findCityFile(id) {
  const stack = [SYSTEMS]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === `${id}.geojson`) return p
    }
  }
  throw new Error(`city file not found for ${id}`)
}

function* walkCoords(g) {
  if (!g) return
  const { type, coordinates } = g
  if (type === 'Point') yield coordinates
  else if (type === 'LineString' || type === 'MultiPoint') yield* coordinates
  else if (type === 'MultiLineString' || type === 'Polygon') {
    for (const r of coordinates) yield* r
  } else if (type === 'MultiPolygon') {
    for (const poly of coordinates) for (const r of poly) yield* r
  }
}

function networkBbox(cityGeojson) {
  let S = 90, N = -90, W = 180, E = -180
  for (const f of cityGeojson.features) {
    for (const [x, y] of walkCoords(f.geometry)) {
      if (y < S) S = y
      if (y > N) N = y
      if (x < W) W = x
      if (x > E) E = x
    }
  }
  const my = (N - S) * BBOX_MARGIN
  const mx = (E - W) * BBOX_MARGIN
  return [S - my, W - mx, N + my, E + mx].map((v) => +v.toFixed(4))
}

// ---- polygon assembly ----------------------------------------------------
const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`

function stitchRings(parts) {
  // parts: array of [[lon,lat],...] open/closed way geometries → closed rings
  const pool = parts.map((p) => p.slice())
  const rings = []
  while (pool.length) {
    let ring = pool.shift()
    let guard = pool.length + 2
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard-- > 0) {
      const end = key(ring[ring.length - 1])
      const i = pool.findIndex((c) => key(c[0]) === end || key(c[c.length - 1]) === end)
      if (i < 0) break
      const c = pool.splice(i, 1)[0]
      ring = ring.concat(key(c[0]) === end ? c.slice(1) : c.reverse().slice(1))
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring)
  }
  return rings
}

function ringAreaKm2(ring) {
  const lat0 = (ring[0][1] * Math.PI) / 180
  const kx = 111.32 * Math.cos(lat0)
  const ky = 110.574
  let s = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    s += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky)
  }
  return Math.abs(s) / 2
}

function pointInRing([px, py], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const rnd = (v) => +v.toFixed(5)
const roundRing = (r) => r.map((p) => [rnd(p[0]), rnd(p[1])])

// element (way with geometry, or relation with member geometries) → {geometry, area}
function elementToPolygon(el) {
  if (el.type === 'way') {
    if (!el.geometry || el.geometry.length < 4) return null
    const ring = el.geometry.map((g) => [g.lon, g.lat])
    if (key(ring[0]) !== key(ring[ring.length - 1])) return null
    return {
      geometry: { type: 'Polygon', coordinates: [roundRing(ring)] },
      area: ringAreaKm2(ring),
    }
  }
  if (el.type === 'relation') {
    const ways = (el.members || []).filter((m) => m.type === 'way' && m.geometry?.length > 1)
    const outers = stitchRings(
      ways.filter((m) => m.role !== 'inner').map((m) => m.geometry.map((g) => [g.lon, g.lat])))
    const inners = stitchRings(
      ways.filter((m) => m.role === 'inner').map((m) => m.geometry.map((g) => [g.lon, g.lat])))
    if (!outers.length) return null
    const polys = outers.map((o) => [o])
    for (const inner of inners) {
      const host = polys.find(([o]) => pointInRing(inner[0], o))
      if (host) host.push(inner)
    }
    let area = 0
    for (const [outer, ...holes] of polys) {
      area += ringAreaKm2(outer)
      for (const h of holes) area -= ringAreaKm2(h)
    }
    const coords = polys.map((rings) => rings.map(roundRing))
    return {
      geometry: coords.length === 1
        ? { type: 'Polygon', coordinates: coords[0] }
        : { type: 'MultiPolygon', coordinates: coords },
      area,
    }
  }
  return null
}

function toFeatures(elements, kind, { minKm2 = 0 } = {}) {
  const relMemberWays = new Set()
  for (const el of elements) {
    if (el.type !== 'relation') continue
    for (const m of el.members || []) if (m.type === 'way') relMemberWays.add(m.ref)
  }
  const feats = []
  for (const el of elements) {
    if (el.type === 'way' && relMemberWays.has(el.id)) continue
    const poly = elementToPolygon(el)
    if (!poly || poly.area < minKm2) continue
    const t = el.tags || {}
    feats.push({
      type: 'Feature',
      properties: {
        landmark_id: `${el.type[0]}${el.id}`,
        kind,
        name: t.name ?? null,
        name_en: t['name:en'] ?? null,
        osm_type: el.type,
        osm_id: el.id,
        area_km2: +poly.area.toFixed(4),
      },
      geometry: poly.geometry,
    })
  }
  return feats.sort((a, b) => b.properties.area_km2 - a.properties.area_km2)
}

// ---- queries ---------------------------------------------------------------
const bboxStr = ([S, W, N, E]) => `${S},${W},${N},${E}`

// waterway 收 river＋canal——canal 用於運河/引水渠（柏林 Spreekanal＝waterway=canal）。
// 靠 name 精確比對限縮，故放寬 waterway 不會誤收其他城市的無關運河。
const centerlineQuery = (bbox, names) => `[out:json][timeout:120];
way["waterway"~"^(river|canal)$"]["name"~"^(${names.join('|')})$"](${bboxStr(bbox)});
out geom;`

function lineLengthKm(line) {
  let s = 0
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i - 1]
    const [x2, y2] = line[i]
    const kx = 111.32 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180)
    s += Math.hypot((x2 - x1) * kx, (y2 - y1) * 110.574)
  }
  return s
}

// rivers 名單項正規化：字串 → { name, match: [name] }。
const normRivers = (rivers) => rivers.map((r) => (typeof r === 'string' ? { name: r, match: [r] } : r))

// rivers 名單城市的「河流骨架」：OSM 人工維護的 waterway=river 中心線。
// 同名 way 直接縫端點會被辮狀水道（河中島側汊，同名）切成幾十段
// （泰晤士河實測 42 段），所以改建無向圖：每個連通分量取「最長路徑」
// （雙次 Dijkstra 求 graph diameter）當主線，側汊不進骨架。
function centerlineFeatures(elements, rivers) {
  const canonical = new Map() // OSM 名（含區段別名）→ 名單主名
  const clipByName = new Map() // 主名 → [lon,lat] 裁切點（河流只保留到此點的主段）
  for (const r of normRivers(rivers)) {
    for (const m of r.match) canonical.set(m, r.name)
    if (r.clip) clipByName.set(r.name, { clip: r.clip, keep: r.keep ?? null })
  }
  // 在最近的折點把河流截斷，**保留靠 keep 點（市中心/河口）那一段**，丟掉往上游的尾。
  // keep 由 rivers 設定項的 `keep:[lon,lat]` 指定（台北＝台北車站）；未指定退回「含最低經度端」
  // （基隆河河口在低經度側適用；大漢溪河口在高經度側、上游往鶯歌是低經度——必須用 keep 判side）。
  const clipLine = (line, [clon, clat], keepPt) => {
    let ci = 0, cd = Infinity
    line.forEach((p, i) => { const d = (p[0] - clon) ** 2 + (p[1] - clat) ** 2; if (d < cd) { cd = d; ci = i } })
    const a = line.slice(0, ci + 1), b = line.slice(ci)
    if (keepPt) {
      const near = (seg) => Math.min(...seg.map((p) => (p[0] - keepPt[0]) ** 2 + (p[1] - keepPt[1]) ** 2))
      return near(a) <= near(b) ? a : b
    }
    const minLon = (seg) => Math.min(...seg.map((p) => p[0]))
    return minLon(a) <= minLon(b) ? a : b
  }
  const byName = new Map()
  for (const el of elements) {
    const n = canonical.get(el.tags?.name)
    if (!n || !el.geometry?.length) continue
    if (!byName.has(n)) byName.set(n, { parts: [], ids: [] })
    byName.get(n).parts.push(el.geometry.map((g) => [g.lon, g.lat]))
    byName.get(n).ids.push(el.id)
  }
  const feats = []
  for (const [name, { parts, ids }] of byName) {
    // 無向圖：節點＝座標 key，邊＝way 相鄰兩點（權重＝距離 km）
    const adj = new Map() // key -> Map(neighborKey -> weight)
    const pos = new Map() // key -> [lon,lat]
    const link = (a, b, w) => {
      if (!adj.has(a)) adj.set(a, new Map())
      adj.get(a).set(b, w)
    }
    for (const part of parts) {
      for (let i = 1; i < part.length; i++) {
        const a = key(part[i - 1])
        const b = key(part[i])
        if (a === b) continue
        pos.set(a, part[i - 1])
        pos.set(b, part[i])
        const w = lineLengthKm([part[i - 1], part[i]])
        link(a, b, w)
        link(b, a, w)
      }
    }
    // Dijkstra（單源最遠點＋前驅），binary min-heap＋lazy deletion
    const dijkstra = (src, nodes) => {
      const dist = new Map([[src, 0]])
      const prev = new Map()
      const heap = [[0, src]] // [dist, key]
      const up = (i) => {
        while (i > 0) {
          const p = (i - 1) >> 1
          if (heap[p][0] <= heap[i][0]) break
          ;[heap[p], heap[i]] = [heap[i], heap[p]]
          i = p
        }
      }
      const down = () => {
        let i = 0
        for (;;) {
          let m = i
          const l = 2 * i + 1
          const r = l + 1
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r
          if (m === i) break
          ;[heap[m], heap[i]] = [heap[i], heap[m]]
          i = m
        }
      }
      while (heap.length) {
        const [d, u] = heap[0]
        const last = heap.pop()
        if (heap.length) { heap[0] = last; down() }
        if (d > (dist.get(u) ?? Infinity)) continue
        for (const [v, w] of adj.get(u) ?? []) {
          const nd = d + w
          if (nd < (dist.get(v) ?? Infinity)) {
            dist.set(v, nd)
            prev.set(v, u)
            heap.push([nd, v])
            up(heap.length - 1)
          }
        }
      }
      let far = src
      let fd = 0
      for (const [k, d] of dist) {
        if (nodes.has(k) && d > fd) { fd = d; far = k }
      }
      return { far, prev }
    }
    // 連通分量 → 每分量的 diameter path
    const seen = new Set()
    const lines = []
    for (const start of adj.keys()) {
      if (seen.has(start)) continue
      const comp = new Set()
      const stack = [start]
      while (stack.length) {
        const u = stack.pop()
        if (comp.has(u)) continue
        comp.add(u)
        seen.add(u)
        for (const v of adj.get(u).keys()) if (!comp.has(v)) stack.push(v)
      }
      const { far: a } = dijkstra(start, comp)
      const { far: b, prev } = dijkstra(a, comp)
      const path = []
      for (let u = b; u !== undefined; u = prev.get(u)) path.push(pos.get(u))
      if (path.length >= 2 && lineLengthKm(path) >= MIN_CENTERLINE_KM) lines.push(path)
    }
    // 縫隙橋接：穿湖段（waterway=flowline/無名 way，柏林 Müggelsee 實測）等會把
    // 主線切成數段——端點距離 ≤ GAP_BRIDGE_KM 的段落串成一條（直線跨接）。
    // 順序在 <1 km 碎段剔除之後，小側汊才不會被接進主線。
    for (;;) {
      let best = null
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          for (const ei of [0, 1]) {
            for (const ej of [0, 1]) {
              const pa = ei ? lines[i][lines[i].length - 1] : lines[i][0]
              const pb = ej ? lines[j][lines[j].length - 1] : lines[j][0]
              const d = lineLengthKm([pa, pb])
              if (d <= GAP_BRIDGE_KM && (!best || d < best.d)) best = { d, i, j, ei, ej }
            }
          }
        }
      }
      if (!best) break
      const a = best.ei ? lines[best.i] : lines[best.i].slice().reverse() // 接點在 a 尾
      const b = best.ej ? lines[best.j].slice().reverse() : lines[best.j] // 接點在 b 頭
      lines[best.i] = a.concat(b)
      lines.splice(best.j, 1)
    }
    const clipCfg = clipByName.get(name)
    lines.sort((x, y) => lineLengthKm(y) - lineLengthKm(x))
    lines.forEach((line0, i) => {
      const line = clipCfg ? clipLine(line0, clipCfg.clip, clipCfg.keep) : line0
      feats.push({
        type: 'Feature',
        properties: {
          landmark_id: `cl-${name}-${i}`,
          kind: 'river-centerline',
          name,
          name_en: null,
          osm_type: 'way',
          osm_ids: ids,
          length_km: +lineLengthKm(line).toFixed(2),
        },
        geometry: { type: 'LineString', coordinates: roundRing(line) },
      })
    })
  }
  return feats
}

const namedQuery = (bbox, spec) => {
  const tag = spec.tag ? `["${spec.tag[0]}"="${spec.tag[1]}"]` : ''
  return `[out:json][timeout:120];
(
  way["name"="${spec.name}"]${tag}(${bboxStr(bbox)});
  relation["name"="${spec.name}"]${tag}(${bboxStr(bbox)});
);
out geom;`
}

// ---- main ------------------------------------------------------------------
const argv = process.argv.slice(2)
const refresh = argv.includes('--refresh')
const wanted = argv.filter((a) => !a.startsWith('--'))
const ids = wanted.length ? wanted : Object.keys(CITIES)

for (const id of ids) {
  const spec = CITIES[id]
  if (!spec) {
    console.error(`[skip] ${id}: not in CITIES config`)
    continue
  }
  const cityPath = await findCityFile(id)
  const city = JSON.parse(await readFile(cityPath, 'utf8'))
  const bbox = networkBbox(city)
  console.log(`\n=== ${id} bbox=${bboxStr(bbox)}`)

  const features = []
  const kinds = []
  if (spec.rivers?.length) {
    const clCache = `landmarks_${id}_river_centerlines_v2.json`
    if (refresh) await rm(join(overpass.CACHE, clCache), { force: true })
    // 中心線 bbox 每邊多放 0.03°（~3 km）：河道彎出網絡 bbox 再彎回來時
    // （泰晤士河南界實測）主線才不會被切成多段。
    const clBbox = [bbox[0] - 0.03, bbox[1] - 0.03, bbox[2] + 0.03, bbox[3] + 0.03]
    const allNames = normRivers(spec.rivers).flatMap((r) => r.match)
    const cl = await overpass.query(centerlineQuery(clBbox, allNames), { cacheName: clCache })
    const clFeats = centerlineFeatures(cl.elements || [], spec.rivers)
    // 市區裁切（顯式 clip 的河不套用）
    const clippedNames = new Set(normRivers(spec.rivers).filter((r) => r.clip).map((r) => r.name))
    const stationPts = city.features.filter((f) => f.geometry?.type === 'Point').map((f) => f.geometry.coordinates)
    for (const f of clFeats) {
      if (clippedNames.has(f.properties.name)) continue
      const t = trimToUrban(f.geometry.coordinates, stationPts, bbox[0])
      if (t && t.length >= 2) {
        f.geometry.coordinates = t
        f.properties.length_km = +lineLengthKm(t).toFixed(2)
      }
    }
    if (!clFeats.length) console.error(`  [warn] rivers [${allNames.join('/')}]: no centerline found`)
    else console.log(`  skeleton: ${clFeats.length} lines (` +
      clFeats.map((f) => `${f.properties.name} ${f.properties.length_km}km`).join(', ') + ')')
    features.push(...clFeats)
    if (clFeats.length) kinds.push('river-centerline')
  }
  for (const named of spec.named || []) {
    const cacheName = `landmarks_${id}_${named.kind}_${named.name.replace(/[^\p{L}\p{N}]+/gu, '_')}.json`
    if (refresh) await rm(join(overpass.CACHE, cacheName), { force: true })
    const data = await overpass.query(namedQuery(bbox, named), { cacheName })
    let feats = toFeatures(data.elements || [], named.kind)
    if (named.pickLargest && feats.length > 1) feats = [feats[0]]
    if (!feats.length) console.error(`  [warn] ${named.kind} "${named.name}": no polygon found`)
    else console.log(`  ${named.kind} "${named.name}": ${feats.length} polygon(s), ` +
      `${feats[0].properties.area_km2} km²`)
    features.push(...feats)
    if (!kinds.includes(named.kind)) kinds.push(named.kind)
  }

  const ms = city.metro_system || {}
  const relPath = cityPath.slice(SYSTEMS.length + 1) // continent/country/id.geojson
  const outPath = join(OUT, relPath)
  await mkdir(dirname(outPath), { recursive: true })
  const out = {
    type: 'FeatureCollection',
    landmark_system: {
      continent: ms.continent ?? null,
      country: ms.country ?? null,
      city: ms.city ?? null,
      city_id: id,
      kinds,
      bbox,
      source: 'OpenStreetMap via Overpass API ' +
        '(river skeletons: waterway=river centerlines, graph-diameter main line; ' +
        'named landmarks: exact-name polygon query)',
      generated_at: new Date().toISOString().slice(0, 10),
      landmark_count: features.length,
    },
    features,
  }
  await writeFile(outPath, JSON.stringify(out))
  console.log(`  wrote ${relPath} (${features.length} features)`)
}
