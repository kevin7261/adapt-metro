// Assemble the motorway networks fetched by fetchHighways.mjs into GeoJSON that
// mirrors the metro schema (see skill highway-osm-fetch), so the same D3 /
// MapLibre renderers and the schematic pipeline consume it unchanged:
//
//   交流道 (highway=motorway_junction)     ≙ metro station  (Point feature)
//   編號高速公路 (highway=motorway, by ref) ≙ metro line     (one feature per ref)
//   交流道依序以直線相接                    ≙ 線壓站點        (segment geometry)
//
// ONE geojson per country (使用者: 台灣只要一個 geojson). Continent/country come
// from the metro anchor cached with each fetch — no geocoding. Each 國道 (ref)
// is a SINGLE continuous line through its interchanges, ordered along the road
// (nearest-neighbour open path + 2-opt), drawn as STRAIGHT interchange-to-
// interchange lines (real road shape used only to find interchanges, never
// drawn). Output → data/highway/{systems,index.json,*.geojson}.
//
//   node scripts/buildHighwayGeojson.mjs
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HIGHWAY = join(ROOT, 'data', 'highway')
const CACHE = join(HIGHWAY, '_cache')
const METRO = join(ROOT, 'data', 'metro')
const MAX_EDGE_M = 30000 // drop adjacency edges longer than this (fake/huge bridge)

// 中文 labels from the metro data (cityNamesZh.json keyed by city slug carries a
// Chinese country + city name), so highway layers show 中文＋English like metro.
// Returns { countryZh: {English country → 中文}, citySlug: {slug → {country,city}} }.
async function zhMaps() {
  const countryZh = {}
  let citySlug = {}
  try {
    const idx = JSON.parse(await readFile(join(METRO, 'index.json'), 'utf8'))
    citySlug = JSON.parse(await readFile(join(ROOT, 'src', 'stores', 'cityNamesZh.json'), 'utf8'))
    for (const s of idx.systems) {
      const slug = s.file.split('/').pop().replace(/\.geojson$/, '')
      if (s.country && citySlug[slug]?.country) countryZh[s.country] = citySlug[slug].country
    }
  } catch { /* labels fall back to English */ }
  return { countryZh, citySlug }
}

// Colour by ROAD LEVEL, not per route (使用者: 同一層同同色, 可參考該國路標選色).
// motorway (國道/Interstate/Autobahn) vs expressway (封閉式快速公路) each get one
// colour, keyed to the country's road-sign scheme where known.
const SIGN_COLORS = {
  Taiwan: { motorway: '#12489b', expressway: '#1f8a4c' },          // 國道藍盾、快速公路綠盾
  Japan: { motorway: '#1f8a4c', expressway: '#1666b0' },           // 高速道路綠、都市高速藍
  China: { motorway: '#12489b', expressway: '#1f8a4c' },           // 国道/高速綠…→用藍/綠對比
  'South Korea': { motorway: '#1f8a4c', expressway: '#1666b0' },   // 고속도로 녹색
  'United States': { motorway: '#0b3d91', expressway: '#1f8a4c' }, // Interstate 藍盾
  Canada: { motorway: '#0b3d91', expressway: '#1f8a4c' },
  Germany: { motorway: '#0061a8', expressway: '#e0a800' },         // Autobahn 藍、Bundesstraße 黃
  'United Kingdom': { motorway: '#0b6cb0', expressway: '#1f8a4c' }, // 藍底 motorway sign
  France: { motorway: '#c0392b', expressway: '#1666b0' },          // autoroute 紅
  Australia: { motorway: '#0b7a3b', expressway: '#12489b' },
  default: { motorway: '#12489b', expressway: '#1f8a4c' },
}
function classColor(country, cls) {
  const t = SIGN_COLORS[country] || SIGN_COLORS.default
  return t[cls] || SIGN_COLORS.default[cls]
}

const key = (x, y) => `${x.toFixed(7)},${y.toFixed(7)}`
function haversine(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const isCJK = (c) => /Taiwan|China|Hong Kong|Macau/i.test(c)
const isJP = (c) => /Japan/i.test(c)
function nameFor(tags, country) {
  if (!tags) return null
  const zh = tags['name:zh'] || tags['name:zh-Hant'] || tags['name:zh-Hans']
  if (isCJK(country)) return zh || tags.name || tags['name:en'] || null
  if (isJP(country)) return tags['name:ja'] || tags.name || null
  return tags['name:en'] || tags.name || zh || null
}
function refLabel(tags, country) {
  const zh = tags['ref:zh'], en = tags['ref:en'], ja = tags['ref:ja']
  const fallback = `Motorway ${tags.ref}`
  if (isCJK(country)) return zh || en || nameFor(tags, country) || fallback
  if (isJP(country)) return ja || en || zh || fallback
  return en || zh || nameFor(tags, country) || fallback
}

// Chain a ref's motorway ways into maximal polylines by shared endpoints (used
// only to discover which interchanges belong to the ref, not for drawing).
function buildPolylines(ways) {
  const segs = ways.map((w) => (w.geometry || []).map((g) => [g.lon, g.lat]))
    .filter((s) => s.length >= 2)
  const endMap = new Map()
  const push = (k, i) => { if (!endMap.has(k)) endMap.set(k, []); endMap.get(k).push(i) }
  segs.forEach((s, i) => { push(key(...s[0]), i); push(key(...s[s.length - 1]), i) })
  const used = new Array(segs.length).fill(false)
  const polylines = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    let poly = segs[i].slice()
    for (const dir of ['tail', 'head']) {
      let grew = true
      while (grew) {
        grew = false
        const anchor = dir === 'tail' ? poly[poly.length - 1] : poly[0]
        const ak = key(...anchor)
        for (const j of endMap.get(ak) || []) {
          if (used[j]) continue
          const s = segs[j]
          const headMatch = key(...s[0]) === ak
          const tailMatch = key(...s[s.length - 1]) === ak
          if (!headMatch && !tailMatch) continue
          const ordered = headMatch ? s : s.slice().reverse()
          if (dir === 'tail') poly = poly.concat(ordered.slice(1))
          else poly = ordered.slice().reverse().slice(0, -1).concat(poly)
          used[j] = true; grew = true; break
        }
      }
    }
    polylines.push(poly)
  }
  return polylines
}


// ---- per-system assembly (a system = a country, or a metro area for big ones)
// wikiRefs = _overrides/wiki_mileage_tw.json 的 refs（台灣各路的 wiki 交流道里程表，
// 使用者：用 wiki 查哩程）——名稱吻合者以 wiki 公里數為權威（覆蓋出口編號、補服務區）。
function buildSystem(raw, { countryZh, cityZh, wikiRefs } = {}) {
  const { continent, country } = raw
  const slug = raw.slug || raw.cc
  const city = raw.city || country      // country name (country-unit) or metro city
  countryZh = countryZh ?? country
  cityZh = cityZh ?? city
  const ways = raw.elements.filter((e) => e.type === 'way' && e.tags?.ref)
  const junctions = raw.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'motorway_junction')

  // Group ways into roads by ref. A way SHARED by concurrent roads is tagged with
  // BOTH refs joined by ";" or "," (OSM convention, e.g. 上海 "G1503;S20") — split
  // it so the way joins EACH road's group. Otherwise "G1503;S20" becomes a bogus
  // third road that overlaps G1503 and S20 → the whole corridor drawn 2-3× (使用者:
  // 一堆路線重覆). Global edge-dedup then draws the shared segment once.
  const splitRefs = (r) => String(r).split(/\s*[;,]\s*/).map((s) => s.trim()).filter(Boolean)
  const byRef = new Map()
  for (const w of ways) {
    for (const r of splitRefs(w.tags.ref)) {
      if (!byRef.has(r)) byRef.set(r, [])
      byRef.get(r).push(w)
    }
  }

  // Merge junction nodes into ONE interchange point (使用者: 同一個交流道只能有
  // 一個點在中間；單一路線只能一條線). The many carriageway / on-off-ramp / A-B
  // sub-nodes of one interchange must all collapse, else they draw as multiple
  // points and parallel duplicate lines. Merge two junctions if:
  //   · same interchange NAME within 2.5 km (named interchanges: NB/SB/系統), or
  //   · same EXIT-NUMBER BASE within 2 km — US exits 36/36A/36B (letters/suffix
  //     stripped → "36") are the SAME interchange but are usually unnamed, or
  //   · simply within 250 m (unnamed carriageway pairs / dense ramp clusters).
  const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  // 出口編號 base：只去尾碼字母（36A→36），**保留「高架」等前綴**——高架25（環北）
  // 與地面 25（台北交流道）是不同交流道，砍成同 base 會被誤併吞站。
  const exitBase = (t) => { const s = String(t?.ref ?? '').trim().replace(/[A-Za-z]+$/, ''); return s || null }
  // 節點→所屬道路（掃 way 幾何頂點）：出口編號在「不同路」會撞號（台62 大華系統
  // exit 5 vs 國1 五堵 exit 5）——base 合併必須同路才准。
  const tmpCoord = new Map()
  junctions.forEach((j, i) => tmpCoord.set(key(j.lon, j.lat), i))
  const nodeRoads = new Map()
  for (const w of ways) for (const r of splitRefs(w.tags.ref)) for (const g of (w.geometry || [])) {
    const ji = tmpCoord.get(key(g.lon, g.lat))
    if (ji !== undefined) { if (!nodeRoads.has(ji)) nodeRoads.set(ji, new Set()); nodeRoads.get(ji).add(r) }
  }
  const shareRoad = (i, k) => {
    const a = nodeRoads.get(i), b = nodeRoads.get(k)
    if (!a || !b) return false
    for (const r of a) if (b.has(r)) return true
    return false
  }
  const parent = junctions.map((_, i) => i)
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a }
  const union = (a, b) => { parent[find(a)] = find(b) }
  const named = junctions.map((j) => ({ name: nameFor(j.tags, country), base: exitBase(j.tags), lon: j.lon, lat: j.lat }))
  for (let i = 0; i < junctions.length; i++) {
    for (let k = i + 1; k < junctions.length; k++) {
      const dd = haversine([named[i].lon, named[i].lat], [named[k].lon, named[k].lat])
      const sameName = named[i].name && named[k].name && norm(named[i].name) === norm(named[k].name)
      const sameBase = named[i].base && named[i].base === named[k].base && shareRoad(i, k)
      // 同名＋同出口編號＋同路＝同一交流道的南北匝道群，可以離很遠（楠梓/太平 ~3km）
      if ((sameName && sameBase && dd < 6000) || (sameName && dd < 2500) || (sameBase && dd < 2000) || dd < 250) union(i, k)
    }
  }
  const ic = new Map()
  junctions.forEach((j, i) => {
    const r = find(i)
    if (!ic.has(r)) ic.set(r, { members: [], names: new Map(), lons: [], lats: [], exitRefs: new Set(), wikidata: null, wikipedia: null })
    const e = ic.get(r)
    e.members.push(i); e.lons.push(j.lon); e.lats.push(j.lat)
    const nm = nameFor(j.tags, country)
    if (nm) e.names.set(norm(nm), nm)
    if (j.tags.ref) e.exitRefs.add(j.tags.ref)
    if (j.tags.wikidata && !e.wikidata) e.wikidata = j.tags.wikidata
    if (j.tags.wikipedia && !e.wikipedia) e.wikipedia = j.tags.wikipedia
  })
  const jIdxToIc = new Map()
  for (const [, e] of ic) {
    e.lon = e.lons.reduce((a, b) => a + b, 0) / e.lons.length
    e.lat = e.lats.reduce((a, b) => a + b, 0) / e.lats.length
    e.id = `n${Math.min(...e.members.map((i) => junctions[i].id))}`
    e.name = [...e.names.values()][0] || `交流道 ${[...e.exitRefs][0] ?? ''}`.trim() || e.id
    for (const i of e.members) jIdxToIc.set(i, find(i))
  }
  const coordToJ = new Map()
  junctions.forEach((j, i) => coordToJ.set(key(j.lon, j.lat), i))

  // ONE ORDERED SEQUENCE PER REF (使用者: 路要整條同一條線，跟 metro map 一樣) —
  // a road is a single linear sequence of its interchanges, drawn by connecting
  // consecutive ones. This makes same-ref parallel chains (國道1號主線 vs 汐止五股
  // 高架, both ref=1) IMPOSSIBLE to braid: elevated-only interchanges are inserted
  // into the mainline order instead of forming a second chain.
  //   · Ordering: by 里程 mileage when ≥60% of the interchanges carry one (Taiwan
  //     exit numbers = km posts, US = mileposts; validated strictly monotonic);
  //     interchanges without mileage are inserted at the minimal-detour position.
  //   · Fallback (no exit numbering): walk the longest road-adjacent chain as the
  //     spine, then insert every remaining interchange by minimal detour.
  //   · Draw consecutive pairs, cap MAX_EDGE_M (real gap → break, never a
  //     city-spanning straight line); close the loop for ring roads whose ends
  //     are road-adjacent.
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const icDist = (a, b) => { const ea = ic.get(a), eb = ic.get(b); return haversine([ea.lon, ea.lat], [eb.lon, eb.lat]) }
  // 里程（mileage）: numeric part of the exit ref (36A → 36); null when absent.
  const mileageOf = (e) => {
    for (const r of e.exitRefs) { const m = String(r).match(/\d+(\.\d+)?/); if (m) return Number(m[0]) }
    return null
  }
  // Insert x into seq at the position adding the least length (prepend/append/interior).
  const insertByDetour = (seq, x) => {
    if (seq.length < 2) { seq.push(x); return }
    let bestI = -1, bestCost = Infinity
    for (let i = 0; i + 1 < seq.length; i++) {
      const cost = icDist(seq[i], x) + icDist(x, seq[i + 1]) - icDist(seq[i], seq[i + 1])
      if (cost < bestCost) { bestCost = cost; bestI = i }
    }
    const d0 = icDist(x, seq[0]), d1 = icDist(x, seq[seq.length - 1])
    if (d0 < bestCost && d0 <= d1) seq.unshift(x)
    else if (d1 < bestCost) seq.push(x)
    else seq.splice(bestI + 1, 0, x)
  }

  const refEdges = new Map()    // ref → [[rootA, rootB] …] consecutive pairs of the sequence
  const refStations = new Map() // ref → the ordered sequence (route.stations / Object tab)
  const neigh = new Map(), icRefs = new Map()
  const addRef = (root, ref) => { if (!icRefs.has(root)) icRefs.set(root, new Set()); icRefs.get(root).add(ref) }
  const link = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); if (!m.has(b)) m.set(b, new Set()); m.get(a).add(b); m.get(b).add(a) }
  const refMileage = new Map() // ref → Map(root → 該路自己的里程)
  for (const [ref, refWays] of byRef) {
    // roots on this ref + raw road adjacency (used for spine fallback & loop
    // closure) + PER-REF mileage. 里程必須取「這條路 way 上的節點」的出口編號：
    // 系統交流道合併了多條路的節點，全域 mileageOf 會拿到別條路的編號（機場系統
    // 在國道1號是 52K，卻拿到國道2號的 8）→ 排序整條路飛來飛去（使用者：還是全錯）。
    const roots = new Set(), adjPairs = new Set(), adj = new Map()
    const mByRoot = new Map()
    for (const poly of buildPolylines(refWays)) {
      const hits = []
      for (const v of poly) {
        const jIdx = coordToJ.get(key(v[0], v[1]))
        if (jIdx !== undefined && jIdxToIc.has(jIdx)) {
          const root = jIdxToIc.get(jIdx)
          hits.push(root)
          const mm = String(junctions[jIdx].tags.ref ?? '').match(/\d+(\.\d+)?/)
          if (mm) {
            const v2 = Number(mm[0])
            if (!mByRoot.has(root) || v2 < mByRoot.get(root)) mByRoot.set(root, v2)
          }
        }
      }
      const chain = hits.filter((r, n) => n === 0 || r !== hits[n - 1])
      for (const r of chain) roots.add(r)
      for (let n = 0; n + 1 < chain.length; n++) {
        if (chain[n] === chain[n + 1]) continue
        adjPairs.add(ekey(chain[n], chain[n + 1])); link(adj, chain[n], chain[n + 1])
      }
    }
    // wiki 里程覆蓋（權威）：正規化名稱比對，含兩種別名變體——去「高架道路」前綴、
    // 去型式尾綴的基底名（瑞隆路「出口匝道」＝wiki 瑞隆路「交流道」、下塔悠同）。
    // 命中者用 wiki 公里數——修正出口編號誤差、補無出口編號的服務區/休息站。
    const wl = wikiRefs?.[ref]?.list
    if (wl) {
      const baseOf = (s) => s.replace(/(系統交流道|出口匝道|交流道|服務區|休息站|轉接道|端)$/, '')
      const wm = new Map(), wb = new Map()
      for (const r of wl) {
        wm.set(norm(r.name), r.km)
        const b = norm(baseOf(r.name))
        if (b) wb.set(b, wb.has(b) ? null : r.km) // 基底撞名（模糊）→ 作廢
      }
      for (const root of roots) {
        const nm = norm(ic.get(root).name).replace(/^高架道路/, '')
        const hit = wm.get(nm) ?? wb.get(norm(baseOf(ic.get(root).name)).replace(/^高架道路/, ''))
        if (hit != null) mByRoot.set(root, hit)
      }
    }
    refMileage.set(ref, mByRoot)
    if (!roots.size) { refEdges.set(ref, []); refStations.set(ref, []); continue }

    const items = [...roots].map((root) => ({ root, m: mByRoot.get(root) ?? null }))
    const withM = items.filter((i) => i.m != null)
    let seq
    if (withM.length >= 2 && withM.length >= items.length * 0.6) {
      // mileage-ordered spine, others inserted by minimal detour
      seq = withM.sort((a, b) => a.m - b.m).map((i) => i.root)
      for (const i of items) if (i.m == null) insertByDetour(seq, i.root)
    } else {
      // spine = endpoint walk of the LARGEST adjacency component
      const visited = new Set(); let spine = []
      for (const start of adj.keys()) {
        if (visited.has(start)) continue
        const comp = []; const stack = [start]; const seen = new Set([start])
        while (stack.length) { const n = stack.pop(); comp.push(n); for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); stack.push(m) } }
        for (const n of comp) visited.add(n)
        const endpoint = comp.find((n) => (adj.get(n)?.size ?? 0) === 1) ?? comp[0]
        const walk = []; const used = new Set(); let cur = endpoint
        while (cur !== undefined && !used.has(cur)) {
          used.add(cur); walk.push(cur)
          cur = [...(adj.get(cur) || [])].find((m) => !used.has(m))
        }
        if (walk.length > spine.length) spine = walk
      }
      seq = spine.length ? spine : [[...roots][0]]
      for (const r of roots) if (!seq.includes(r)) insertByDetour(seq, r)
    }

    // consecutive pairs → edges (cap = real-gap break); ring closure if the two
    // ends are road-adjacent (環線 like G1503 上海繞城)
    const edges = []
    for (let n = 0; n + 1 < seq.length; n++) {
      if (icDist(seq[n], seq[n + 1]) <= MAX_EDGE_M) edges.push([seq[n], seq[n + 1]])
    }
    if (seq.length > 2 && adjPairs.has(ekey(seq[0], seq[seq.length - 1])) &&
        icDist(seq[0], seq[seq.length - 1]) <= MAX_EDGE_M) {
      edges.push([seq[seq.length - 1], seq[0]])
    }
    for (const [a, b] of edges) { link(neigh, a, b); addRef(a, ref); addRef(b, ref) }
    refEdges.set(ref, edges)
    refStations.set(ref, seq)
  }

  const refTags = new Map()
  const refClass = new Map() // ref → 'motorway' | 'expressway'
  for (const [ref, refWays] of byRef) {
    refTags.set(ref, refWays.slice().sort((x, y) => Object.keys(y.tags).length - Object.keys(x.tags).length)[0].tags)
    refClass.set(ref, refWays.some((w) => w.tags.highway === 'motorway') ? 'motorway' : 'expressway')
  }
  const routeMeta = (ref) => {
    const t = refTags.get(ref)
    const cls = refClass.get(ref)
    // The way's ref tags may be the joined "G1503;S20" — this road is only `ref`,
    // so a combined label falls back to the clean split ref.
    const clean = (s) => (s && !/[;,]/.test(s) ? s : null)
    const name = clean(refLabel(t, country)) || ref
    return {
      route_id: `hw-${slug}-${ref}`,
      route_name: name,
      route_name_local: clean(t['ref:zh']) || clean(t['name:zh']) || clean(t.name) || name,
      route_ref: ref,
      route_color: classColor(country, cls), // colour by road level, not per route
      road_class: cls,                        // 'motorway' | 'expressway'
      network: t.network || `${country} ${cls === 'motorway' ? 'Motorways' : 'Expressways'}`,
      network_local: t['network:zh'] || null,
      operator: t.operator || null,
      wikidata: t.wikidata || null,
      wikipedia: t.wikipedia || null,
      status: null,
      order_suspect: 0,
    }
  }
  // (filtered to drawn interchanges — usedIc is populated before any call)
  // mileage = 該路自己的里程（refMileage），不是合併節點隨便一個出口編號
  const refStationList = (ref) => (refStations.get(ref) || []).filter((r) => usedIc.has(r)).map((root) => {
    const e = ic.get(root)
    return { station_id: e.id, station_name: e.name, mileage: refMileage.get(ref)?.get(root) ?? null }
  })

  const features = []
  // orphan-drop: only interchanges that sit on a DRAWN edge (an interchange cut
  // off by the gap cap has no edge → not emitted, matching metro's rule)
  const usedIc = new Set()
  for (const edges of refEdges.values()) for (const [a, b] of edges) { usedIc.add(a); usedIc.add(b) }
  for (const root of usedIc) {
    const e = ic.get(root)
    const refs = [...(icRefs.get(root) || [])].sort()
    const degree = neigh.get(root)?.size ?? 0
    const isInter = refs.length >= 2 || degree > 2
    const isTerm = degree === 1
    features.push({
      type: 'Feature',
      properties: {
        station_id: e.id, station_name: e.name, station_name_local: e.name,
        network: `${country} Motorways`, network_local: null, operator: null,
        city, country,
        lines: refs.map((r) => routeMeta(r).route_name),
        line_ids: refs.map((r) => `hw-${slug}-${r}`),
        line_names: refs.map((r) => routeMeta(r).route_name),
        exit_refs: [...e.exitRefs].sort(),
        mileage: mileageOf(e),
        station_role: isInter ? 'interchange' : (isTerm ? 'terminus' : 'normal'),
        station_degree: degree, is_interchange: isInter, is_terminus: isTerm,
        merged_from: e.members.length,
        merged_names: e.names.size > 1 ? [...e.names.values()] : null,
        wikidata: e.wikidata, wikipedia: e.wikipedia,
      },
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
    })
  }
  // ONE segment feature per UNIQUE interchange-pair edge (global dedup across
  // roads, like metro path-segmentation): a corridor shared by concurrent roads
  // is drawn ONCE, not once per road. Each segment = a straight 2-point line
  // between the two merged interchange dots; a road's full path = every segment
  // whose `routes` include it (same class colour → reads as one continuous line).
  const globalEdges = new Map()
  for (const [ref, edges] of refEdges) for (const [a, b] of edges) {
    const k = ekey(a, b)
    if (!globalEdges.has(k)) globalEdges.set(k, { a, b, refs: [] })
    if (!globalEdges.get(k).refs.includes(ref)) globalEdges.get(k).refs.push(ref)
  }
  let segN = 0
  for (const { a, b, refs } of globalEdges.values()) {
    const routes = refs.map((ref) => ({ ...routeMeta(ref), stations: refStationList(ref), pass_stations: [] }))
    const colors = routes.map((r) => r.route_color)
    const ea = ic.get(a), eb = ic.get(b)
    features.push({
      type: 'Feature',
      properties: {
        seg_id: `${slug}-${segN++}`,
        routes, route_count: routes.length, route_refs: refs,
        route_colors: colors, route_color: colors[0],
        city, country,
      },
      geometry: { type: 'MultiLineString', coordinates: [[[ea.lon, ea.lat], [eb.lon, eb.lat]]] },
    })
  }
  const segTotal = globalEdges.size
  const refCount = [...refEdges.values()].filter((e) => e.length).length
  const meta = {
    continent, country, country_zh: countryZh, city, city_zh: cityZh, unit: raw.unit || 'country',
    osm_networks: [...byRef.keys()].sort(),
    operator: null,
    line_count: refCount, segment_count: segTotal,
    station_count: usedIc.size, interchange_count: usedIc.size,
  }
  return {
    type: 'FeatureCollection',
    highway_system: meta,
    metro_system: { ...meta, kind: 'highway' },
    features,
  }
}

const CONTINENT_DIR = {
  asia: 'asia', europe: 'europe', africa: 'africa', oceania: 'oceania',
  'north-america': 'americas', 'south-america': 'americas', americas: 'americas',
}
function countrySlug(country) {
  return country.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

async function main() {
  // optional CLI filter（逗號分隔 slug 子字串）——目前範圍＝台灣（使用者：只要台灣，
  // 國外不用），npm highway:build 傳 "as-twn"；外國快取保留在 _cache 但不組檔。
  const filters = (process.argv[2] ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  let files
  try { files = (await readdir(CACHE)).filter((f) => f.startsWith('hw_') && f.endsWith('.json')) }
  catch { files = [] }
  if (filters.length) files = files.filter((f) => filters.some((x) => f.toLowerCase().includes(x)))
  if (!files.length) { console.error('no fetched systems in data/highway/_cache — run npm run highway:fetch first'); process.exit(1) }

  const { countryZh: cMap, citySlug } = await zhMaps()
  // 台灣 wiki 里程表（scripts/fetchWikiHighwayTw.mjs 產出；無檔則跳過）
  let wikiTw = null
  try { wikiTw = JSON.parse(await readFile(join(HIGHWAY, '_overrides', 'wiki_mileage_tw.json'), 'utf8')).refs } catch { /* optional */ }
  const allLines = [], allIc = [], systems = []
  let lineTotal = 0, stationTotal = 0
  for (const f of files.sort()) {
    const raw = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    const slug = raw.slug || raw.cc
    const countryZh = cMap[raw.country] ?? raw.country
    // metro-unit files (big countries) get a 中文 city name; country-unit → country
    const cityZh = raw.unit === 'metro' ? (citySlug[slug]?.city ?? raw.city) : countryZh
    const fc = buildSystem(raw, { countryZh, cityZh, wikiRefs: raw.country === 'Taiwan' ? wikiTw : null })
    if (!fc.features.length) { console.log(`  ${slug}: 0 features, skip`); continue }
    const cont = CONTINENT_DIR[raw.continent] || 'other'
    const rel = `systems/${cont}/${countrySlug(raw.country)}/${slug}.geojson`
    await mkdir(dirname(join(HIGHWAY, rel)), { recursive: true })
    await writeFile(join(HIGHWAY, rel), JSON.stringify(fc))
    const m = fc.highway_system
    systems.push({
      file: rel, continent: raw.continent, country: raw.country, country_zh: m.country_zh,
      city: m.city, city_zh: m.city_zh, unit: m.unit,
      osm_networks: m.osm_networks, operator: m.operator,
      line_count: m.line_count, segment_count: m.segment_count, station_count: m.station_count,
    })
    lineTotal += m.line_count; stationTotal += m.station_count
    for (const feat of fc.features) (feat.geometry.type === 'Point' ? allIc : allLines).push(feat)
    console.log(`  ${slug} (${m.city_zh}): ${m.line_count} motorways, ${m.station_count} interchanges`)
  }

  await writeFile(join(HIGHWAY, 'highway_lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allLines }))
  await writeFile(join(HIGHWAY, 'highway_interchanges.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allIc }))
  await writeFile(join(HIGHWAY, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap highway=motorway + motorway_junction; one file per country, anchored on data/metro',
    system_count: systems.length, line_total: lineTotal, station_total: stationTotal, systems,
  }, null, 1))
  console.log(`\ndone: ${systems.length} countries, ${lineTotal} motorways, ${stationTotal} interchanges`)
}

main().catch((e) => { console.error(e); process.exit(1) })
