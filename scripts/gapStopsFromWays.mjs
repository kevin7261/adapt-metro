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

// 依成員順序把 way 幾何接成一條折線（端點相接就翻轉，接不上就直接續接）
function chainWays(ways) {
  const line = []
  for (const w of ways) {
    let pts = w.geometry
    if (!pts?.length) continue
    if (line.length) {
      const tail = line[line.length - 1]
      const near = (p, q) => Math.abs(p.lat - q.lat) < 1e-6 && Math.abs(p.lon - q.lon) < 1e-6
      // 起點對不上、但終點對得上 → 這條 way 是反向的
      if (!near(tail, pts[0]) && near(tail, pts[pts.length - 1])) pts = [...pts].reverse()
    } else if (ways.length > 1 && ways[1]?.geometry?.length) {
      // 第一條 way 的方向由與第二條的接點決定
      const nxt = ways[1].geometry
      const ends = [pts[0], pts[pts.length - 1]]
      const d = (p, q) => Math.hypot(p.lat - q.lat, p.lon - q.lon)
      const dHead = Math.min(d(ends[0], nxt[0]), d(ends[0], nxt[nxt.length - 1]))
      const dTail = Math.min(d(ends[1], nxt[0]), d(ends[1], nxt[nxt.length - 1]))
      if (dHead < dTail) pts = [...pts].reverse()
    }
    for (const p of pts) line.push(p)
  }
  return line
}

/**
 * 對 routeIds 內「沒有 node 成員」的 relation 合成 stop 序。
 * @param {number[]} routeIds 這座城市留下的 route relation id
 * @param {{id:number,lat:number,lon:number}[]} stations 站點候選（乾淨站源）
 * @param {number} maxM 站點到線的最大垂距（公尺）
 * @returns {Map<number, {type:'node',ref:number,role:'stop'}[]>} relation id → 合成成員序
 */
export async function synthStopsFromWays(routeIds, stations, maxM = 150) {
  const out = new Map()
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
      const line = chainWays(ways)
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
        if (best) hits.push({ id: s.id, at: best.at })
      }
      hits.sort((a, b) => a.at - b.at)
      if (hits.length >= 2)
        out.set(rel.id, hits.map((h) => ({ type: 'node', ref: h.id, role: 'stop' })))
    }
  }
  return out
}
