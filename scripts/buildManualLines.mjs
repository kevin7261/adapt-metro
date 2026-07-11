// 未通車特例線（台北專屬，使用者指定）——把「curated 連續有名站段」＋OSM 線形，
// 插值補齊每站座標，產出 data/metro/_overrides/manual_lines.json 供 buildGeojson 注入。
//
// 只畫「官方已公布站名」的連續段（站名 100% 不變式；「未定/暫定」站不畫、不編造）。
// 站名/站序來自 wiki（agent 查證），座標優先取 OSM 沿線節點、其餘沿 OSM way 線形
// 依站序在相鄰錨點間等分插值。
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 輸入：站單（人工 curated，_overrides）＋ OSM 線形（_cache）；產物 manual_lines.json
const CURATED = join(ROOT, 'data', 'metro', '_overrides', 'manual_curated.json')
const POLYLINES = join(ROOT, 'data', 'metro', '_cache', 'uc_polylines.json')

// 累積弧長參數化：每個 polyline 頂點的 [lon,lat,cumdist]
function cumulative(poly) {
  const out = []
  let d = 0
  for (let i = 0; i < poly.length; i++) {
    if (i > 0) {
      const [x0, y0] = poly[i - 1], [x1, y1] = poly[i]
      const dx = (x1 - x0) * Math.cos((y1 + y0) / 2 * Math.PI / 180)
      d += Math.hypot(dx, y1 - y0)
    }
    out.push([poly[i][0], poly[i][1], d])
  }
  return out
}
// polyline 上離 pt 最近頂點的累積距離
function projectDist(cum, pt) {
  let best = 0, bestD = Infinity
  for (const [x, y, d] of cum) {
    const dx = (x - pt[0]) * Math.cos((y + pt[1]) / 2 * Math.PI / 180)
    const dd = dx * dx + (y - pt[1]) ** 2
    if (dd < bestD) { bestD = dd; best = d }
  }
  return best
}
// 累積距離 d 對應的 polyline 座標（線性內插）
function pointAt(cum, d) {
  if (d <= cum[0][2]) return [cum[0][0], cum[0][1]]
  if (d >= cum[cum.length - 1][2]) return [cum[cum.length - 1][0], cum[cum.length - 1][1]]
  for (let i = 1; i < cum.length; i++) {
    if (cum[i][2] >= d) {
      const t = (d - cum[i - 1][2]) / (cum[i][2] - cum[i - 1][2] || 1)
      return [
        +(cum[i - 1][0] + t * (cum[i][0] - cum[i - 1][0])).toFixed(6),
        +(cum[i - 1][1] + t * (cum[i][1] - cum[i - 1][1])).toFixed(6),
      ]
    }
  }
  return [cum[cum.length - 1][0], cum[cum.length - 1][1]]
}

// 對一段有序站（部分有座標）沿 polyline 插值補齊。錨點＝有座標的站，
// 其定位到 polyline 累積距離；中間 null 站在相鄰錨點的距離區間內等分。
function interpolateStations(stations, poly) {
  const cum = cumulative(poly)
  const anchors = stations.map((s, i) =>
    s.lon != null ? { i, d: projectDist(cum, [s.lon, s.lat]) } : null).filter(Boolean)
  if (anchors.length < 2) throw new Error('need ≥2 anchor stations with coords')
  // 確保錨點沿線距離單調（站序與線形方向一致）；不單調則反轉線形參數
  const asc = anchors[anchors.length - 1].d >= anchors[0].d
  const D = (d) => asc ? d : (cum[cum.length - 1][2] - d)
  const out = stations.map((s) => ({ ...s }))
  for (let a = 0; a < anchors.length - 1; a++) {
    const lo = anchors[a], hi = anchors[a + 1]
    const gap = hi.i - lo.i
    for (let k = 1; k < gap; k++) {
      const frac = k / gap
      const dInterp = lo.d + frac * (hi.d - lo.d)
      const [lon, lat] = pointAt(cum, dInterp)
      out[lo.i + k].lon = lon
      out[lo.i + k].lat = lat
    }
  }
  // 端點外推：末錨點之後 / 首錨點之前的站沿線形按平均站距延伸放置
  const last = anchors[anchors.length - 1], prev = anchors[anchors.length - 2]
  const stepEnd = (last.d - prev.d) / (last.i - prev.i)
  for (let i = last.i + 1; i < stations.length; i++) {
    const [lon, lat] = pointAt(cum, last.d + stepEnd * (i - last.i))
    out[i].lon = lon; out[i].lat = lat
  }
  const first = anchors[0], second = anchors[1]
  const stepStart = (second.d - first.d) / (second.i - first.i)
  for (let i = first.i - 1; i >= 0; i--) {
    const [lon, lat] = pointAt(cum, first.d - stepStart * (first.i - i))
    out[i].lon = lon; out[i].lat = lat
  }
  void D
  return out
}

async function main() {
  const polys = JSON.parse(await readFile(POLYLINES, 'utf8'))
  const curated = JSON.parse(await readFile(CURATED, 'utf8'))
  const lines = []
  for (const line of curated.lines) {
    const poly = polys[line.polyline_key].polyline
    const filled = interpolateStations(line.stations, poly)
    const missing = filled.filter((s) => s.lon == null)
    if (missing.length) throw new Error(`${line.ref}: ${missing.length} stations still lack coords`)
    lines.push({
      ref: line.ref, name: line.name, name_en: line.name_en, colour: line.colour,
      city: 'Taipei', country: 'Taiwan', continent: 'asia',
      network: line.network || '臺北捷運', wikipedia: line.wikipedia || null,
      variant: line.variant, closed: !!line.closed,
      stations: filled.map((s) => ({
        code: s.code, name: s.name_zh, name_en: s.name_en,
        lon: s.lon, lat: s.lat,
      })),
    })
    console.log(`${line.ref} ${line.name}: ${filled.length} stations (${line.stations.filter((s) => s.lon != null).length} anchors + interpolated)`)
  }
  const outPath = join(ROOT, 'data', 'metro', '_overrides', 'manual_lines.json')
  await writeFile(outPath, JSON.stringify({
    _comment: '未通車特例線（台北，使用者指定）。只含官方已公布站名的連續段；站名來自 wiki、座標由 OSM 線形插值（scripts/buildManualLines.mjs）。buildGeojson 注入為 status=under_construction 的線。官方公布新站名後補 manual_curated.json 重跑。',
    lines,
  }, null, 1))
  console.log(`wrote ${lines.length} manual lines -> ${outPath}`)
}
main().catch((e) => { console.error(e.message); process.exit(1) })
