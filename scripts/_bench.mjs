// 論文①〜⑧的速度/效果量測（給 tab 加註「快/中/慢・好/中/差」用）。
// 兩種脈絡：A = 直接餵「格網化後」（初步直線化群組的比較視圖）
//           B = 接在 ②Hill Climbing 之後（直線演算法群組）
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHillClimb, buildHcGraph, countHV, countHVD, iteratePost } from '../src/stores/hillClimb.js'
import { PAPER_KINDS } from '../src/stores/paperAlign.js'

const files = process.argv.slice(2)
const agg = new Map(PAPER_KINDS.map((p) => [p.kind, { zh: p.zh, msA: 0, msB: 0, gA: 0, gB: 0, hvA: 0, hvB: 0, n: 0 }]))
for (const file of files) {
  const gj = JSON.parse(await readFile(file, 'utf8'))
  const W = 200, H = 150, pad = 14
  const stations = gj.features.filter((f) => f.geometry?.type === 'Point')
  const lineFeats = gj.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
  const skeleton = buildConnectSkeleton(gj)
  const projection = geoMercator().angle(0).fitExtent([[pad, pad], [W - pad, H - pad]],
    { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : gj.features })
  const projById = new Map()
  for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
  for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
  const grid = buildSchematicGrid(skeleton, projById, [pad, pad, W - pad, H - pad])
  const sc = (cells) => { const { pos, segs } = buildHcGraph(skeleton, cells); return [countHV(pos, segs), countHVD(pos, segs), segs.length] }
  const [, , nseg] = sc(grid.cellOf)
  if (!nseg) continue
  const t0 = Date.now()
  const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
  const hcMs = Date.now() - t0
  const [hvHc, hvdHc] = sc(hc.cellAfter)
  console.log(`# ${file.split('/').pop()} segs=${nseg} 初步直線化 ${hvHc}/${hvdHc} ${hcMs}ms`)
  for (const { kind, build } of PAPER_KINDS) {
    let t = Date.now()
    const a = iteratePost(build, skeleton, grid.cellOf, grid.cols, grid.rows)
    const msA = Date.now() - t
    const [hvA, hvdA] = sc(a.cellAfter)
    t = Date.now()
    const b = iteratePost(build, skeleton, hc.cellAfter, grid.cols, grid.rows)
    const msB = Date.now() - t
    const [hvB, hvdB] = sc(b.cellAfter)
    const r = agg.get(kind)
    r.n++; r.msA += msA; r.msB += msB
    r.gA += (hvdA - 0) / nseg; r.hvA += hvA / nseg
    r.gB += (hvdB - hvdHc) / nseg; r.hvB += (hvB - hvHc) / nseg
  }
}
console.log('\nkind      A:ms  A:HV%  A:HVD%   B:ms  B:ΔHV%  B:ΔHVD%')
for (const [kind, r] of agg) {
  const p = (x) => (100 * x / r.n).toFixed(1).padStart(6)
  const m = (x) => Math.round(x / r.n).toString().padStart(5)
  console.log(`${kind.padEnd(8)}${m(r.msA)}${p(r.hvA)}${p(r.gA)}  ${m(r.msB)}${p(r.hvB)}${p(r.gB)}   ${r.zh}`)
}
void readdir; void join
