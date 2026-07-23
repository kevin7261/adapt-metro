// 由「軌道 way 幾何 ＋ 站點座標」合成 route relation 的停靠序（gap 專用）。
//
// 為什麼需要：buildGeojson 的路線幾何＝route relation 的**有序 node 成員**（停靠點）。
// 少數城市的 OSM route relation 只掛 way（軌道），一個 stop/platform 節點都沒有：
//   * 阿德萊德 Adelaide Metro 全部 21 條 route（node 成員 0）
//   * 亞歷山卓電車 21 條 route（21 條合計只有 7 個 node 成員）
// 這種 relation 進管線會變成「沒有站的線」被丟掉（阿德萊德只剩 3 條電車、亞歷山卓
// 只剩 4 站）。這裡在**抓取端**依 way 幾何把站點投影回線上、依里程排序，合成出
// 等價的 stop 成員序寫進 gap_geom_*，下游管線完全不必特例。
//
// 判準：站點到折線的垂距 ≤ MAX_M（預設 150 m，站體/月台中心與軌道中心線的合理誤差），
// 依投影里程排序；同一站只取最近的一次投影。
import * as overpass from './overpass.mjs'

const R = 6371000
const toRad = (d) => (d * Math.PI) / 180
// 局部平面近似（城市尺度誤差可忽略）：以 lat0 為基準把經緯度換成公尺
const projector = (lat0) => {
  const kx = (Math.PI / 180) * R * Math.cos(toRad(lat0))
  const ky = (Math.PI / 180) * R
  return ([lon, lat]) => [lon * kx, lat * ky]
}

// 點到線段的距離與投影參數
function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1]
  const L2 = vx * vx + vy * vy
  let t = L2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = a[0] + t * vx, cy = a[1] + t * vy
  return { d: Math.hypot(p[0] - cx, p[1] - cy), t }
}

// 把 way 幾何接成一條折線。**不能照成員順序串**——上游的 way 成員常不是地理連續的
// （阿德萊德 Outer Harbor 線的成員順序會讓折線先跳到 Osborne 支線再折回市區，站序就
// 變成「Peterhead → Osborne → Outer Harbor → Adelaide → …」）。改以端點建圖後貪婪走訪：
// 從度數 1 的端點出發沿相接的 way 一路走，取覆蓋最長的一條路徑（分支的短枝略過）。
function stitchWays(ways) {
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`
  const ends = ways.map((w) => [key(w.geometry[0]), key(w.geometry[w.geometry.length - 1])])
  const adj = new Map()
  ends.forEach(([a, b], i) => {
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a).push(i)
    adj.get(b).push(i)
  })
  const walk = (startNode) => {
    const used = new Array(ways.length).fill(false)
    const pts = []
    let node = startNode
    for (;;) {
      const next = (adj.get(node) ?? []).find((i) => !used[i])
      if (next == null) break
      used[next] = true
      const [a, b] = ends[next]
      const forward = a === node
      const g = forward ? ways[next].geometry : [...ways[next].geometry].reverse()
      for (const p of g) pts.push(p)
      node = forward ? b : a
    }
    return { pts, used }
  }
  // 起點候選：度數 1 的端點（線的兩端）；全是環就從任一 way 的頭開始
  const starts = [...adj.entries()].filter(([, v]) => v.length === 1).map(([k]) => k)
  const cands = starts.length ? starts : (ends.length ? [ends[0][0]] : [])
  let best = { pts: [], used: null }
  for (const s of cands) {
    const r = walk(s)
    if (r.pts.length > best.pts.length) best = r
  }
  if (!best.pts.length) return []
  // 貪婪走訪會在岔道／複線分歧處停住，剩下的 way 常是同一條線的後半段（威靈頓
  // Kapiti 線就斷在 Pukerua Bay）。把還沒用到的 way 依「與目前鏈尾最近」逐段接上，
  // 直到接不動為止——只補接得起來的（>2 km 視為不同段，不接）。
  const remaining = ways.map((w, i) => i).filter((i) => !best.used[i])
  const dKm = (a, b) => {
    const dx = (a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
    return Math.sqrt(dx * dx + (a.lat - b.lat) ** 2) * 111
  }
  let guard = remaining.length + 2
  while (remaining.length && guard-- > 0) {
    const tail = best.pts[best.pts.length - 1]
    const head = best.pts[0]
    let pick = null
    for (const i of remaining) {
      const g = ways[i].geometry
      for (const [end, rev] of [[g[0], false], [g[g.length - 1], true]]) {
        // 接在鏈尾或鏈頭都可以——只接尾端會把「市中心那一段」錯接到郊區端之後
        // （威靈頓 Kapiti 線曾變成 …Pukerua Bay → Kenepuru → Wellington）
        for (const at of ['tail', 'head']) {
          const d = dKm(at === 'tail' ? tail : head, end)
          if (!pick || d < pick.d) pick = { i, rev, d, at }
        }
      }
    }
    // 只補「真的接得上」的缺口（<300 m，多半是缺一小段連接 way）——放到 2 km 會把
    // 相隔一站以上的另一段硬接上，路段聯集就會斷開（verify 的 broken_routes）。
    if (!pick || pick.d > 0.3) break
    // 複線／對向軌的 way 會與既有鏈平行重疊，接上去會讓同一站被走第二次
    // （威靈頓 Kapiti 線尾端冒出 Kenepuru → Redwood）。中點離既有鏈 <120 m 視為
    // 重疊軌（同一條線的對向軌約 5–20 m），丟棄不接；門檻放太大會把「市中心那一段」
    // 也當成重疊丟掉（威靈頓 Kapiti 線的 Wellington–Takapu Road 段）。
    {
      const g0 = ways[pick.i].geometry
      const mid = g0[Math.floor(g0.length / 2)]
      let near = Infinity
      for (let k = 0; k < best.pts.length; k += Math.max(1, Math.floor(best.pts.length / 400)))
        near = Math.min(near, dKm(mid, best.pts[k]))
      if (near < 0.12) { remaining.splice(remaining.indexOf(pick.i), 1); continue }
    }
    const g = pick.rev ? [...ways[pick.i].geometry].reverse() : ways[pick.i].geometry
    if (pick.at === 'tail') for (const pt of g) best.pts.push(pt)
    else best.pts.unshift(...[...g].reverse())
    remaining.splice(remaining.indexOf(pick.i), 1)
  }
  return best.pts
}

/**
 * 對 routeIds 內「沒有 node 成員」的 relation 合成 stop 序。
 * @param {number[]} routeIds 這座城市留下的 route relation id
 * @param {{id:number,lat:number,lon:number}[]} stations 站點候選（乾淨站源）
 * @param {number} maxM 站點到線的最大垂距（公尺）
 * @returns {Map<number, {type:'node',ref:number,role:'stop'}[]>} relation id → 合成成員序
 */
const JUNK_STATION = /miniature|museum|heritage|tourist|模型|觀光/i
export async function synthStopsFromWays(routeIds, stationsIn, maxM = 150) {
  const out = new Map()
  // 投影是「幾何就近」，會把貼著路線的非本線站點也吸進來（威靈頓 Kapiti 線旁的
  // Aotea Lagoon Miniature Railway）——先濾掉迷你／博物館／觀光鐵道。
  const stations = stationsIn.filter((s) =>
    !JUNK_STATION.test(`${s.tags?.name ?? ''} ${s.tags?.station ?? ''} ${s.tags?.operator ?? ''}`))
  if (!routeIds.length || !stations.length) return out
  for (let i = 0; i < routeIds.length; i += 60) {
    const chunk = routeIds.slice(i, i + 60)
    const q = `[out:json][timeout:300];relation(id:${chunk.join(',')})->.r;.r out body;way(r.r);out geom;`
    const d = await overpass.query(q, { timeout: 300000, maxAttempts: 6 })
    const wayGeom = new Map()
    const rels = []
    for (const e of d.elements ?? []) {
      if (e.type === 'way') wayGeom.set(e.id, e.geometry)
      else if (e.type === 'relation') rels.push(e)
    }
    for (const rel of rels) {
      const ways = (rel.members ?? []).filter((m) => m.type === 'way')
        .map((m) => ({ id: m.ref, geometry: wayGeom.get(m.ref) }))
        .filter((w) => w.geometry?.length)
      if (!ways.length) continue
      const line = stitchWays(ways)
      if (line.length < 2) continue
      const proj = projector(line[0].lat)
      const pts = line.map((p) => proj([p.lon, p.lat]))
      // 累積里程
      const acc = [0]
      for (let k = 1; k < pts.length; k++)
        acc.push(acc[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
      const hits = []
      for (const s of stations) {
        const p = proj([s.lon, s.lat])
        let best = null
        for (let k = 1; k < pts.length; k++) {
          const { d: dist, t } = segDist(p, pts[k - 1], pts[k])
          if (dist > maxM) continue
          const at = acc[k - 1] + t * (acc[k] - acc[k - 1])
          if (!best || dist < best.d) best = { d: dist, at }
        }
        if (best) hits.push({ id: s.id, at: best.at, d: best.d, name: s.tags?.name ?? `n${s.id}` })
      }
      // 同名站只留投影距離最近的一個——複線/月台各自是獨立 station 節點時，同一站
      // 會在兩條平行軌上各投影一次，序列尾端就冒出「…Pukerua Bay → Kenepuru →
      // Redwood」這種重複（buildGeojson 的同名合併是在站層，救不了 route 的停靠序）。
      const bestByName = new Map()
      for (const h of hits) {
        const prev = bestByName.get(h.name)
        if (!prev || h.d < prev.d) bestByName.set(h.name, h)
      }
      hits.length = 0
      hits.push(...bestByName.values())
      hits.sort((a, b) => a.at - b.at)
      if (hits.length >= 2)
        out.set(rel.id, hits.map((h) => ({ type: 'node', ref: h.id, role: 'stop' })))
    }
  }
  return out
}
