// scratch: 在 base 之上做「兩步」搜尋——先走一步可暫時變差的移動，再在其鄰域找補回
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geoMercator } from 'd3-geo'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, iteratePost, applyLlmTargets, straightenCompactLoop, setSpanCap, makeMover } from '../src/stores/hillClimb.js'
import { PAPER_BUILD } from '../src/stores/paperAlign.js'

setSpanCap(3)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const cityId = 'as-jpn-tokyo-jr', compact = 'stroke'
const meta = JSON.parse(await readFile(join(DATA, 'map-adjust', `${cityId}.json`), 'utf8'))
const geojson = JSON.parse(await readFile(join(DATA, meta.file), 'utf8'))
const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }
const skeleton = buildConnectSkeleton(geojson)
const projection = geoMercator().angle(0).fitExtent([[24, 24], [1176, 776]], fitFC)
const projById = new Map()
for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
const baseCells = iteratePost(PAPER_BUILD[compact], skeleton, grid.cellOf, grid.cols, grid.rows).cellAfter
const comp = straightenCompactLoop(skeleton, baseCells, grid.cols, grid.rows)
const cells = comp.cellAfter
const nC = comp.cols, nR = comp.rows
const idsSorted = [...cells.keys()].sort()
const nameById = new Map(stations.map((f) => [f.properties.station_id, f.properties.station_name_local || f.properties.station_name || f.properties.station_id]))

const seed = JSON.parse(await readFile(join(__dirname, process.argv[2] ?? 'mv_base.json'), 'utf8'))
const start = applyLlmTargets(skeleton, cells, nC, nR, Object.entries(seed.moves).map(([i, t]) => [idsSorted[+i], t])).cellAfter
const pos = new Map([...start].map(([id, p]) => [id, [p[0], p[1]]]))
const { segs, inc } = buildHcGraph(skeleton, pos)
const M = makeMover(pos, segs, inc, nC, nR)
const other = (s, u) => (s.a === u ? s.b : s.a)
const dirOf = (A, B) => {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  if (dy === 0) return 'H'; if (dx === 0) return 'V'
  if (Math.abs(dx) === Math.abs(dy)) return 'D45'; return 'other'
}
function score(p) {
  let h = 0, v = 0, d = 0
  for (const s of segs) { const k = dirOf(p.get(s.a), p.get(s.b)); if (k === 'H') h++; else if (k === 'V') v++; else if (k === 'D45') d++ }
  let a = 0
  for (const [u, list] of inc) {
    const P = p.get(u)
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const s = segs[list[i]], t = segs[list[j]]
      if (![...(s.routes ?? [])].some((r) => (t.routes ?? new Set()).has(r))) continue
      const A = p.get(other(s, u)), C = p.get(other(t, u))
      if ((A[0] - P[0]) * (C[0] - P[0]) + (A[1] - P[1]) * (C[1] - P[1]) > 0) a++
    }
  }
  return { hv: h + v, d45: d, acute: a }
}
const key = (s) => -s.acute * 1e12 + s.hv * 1e6 + s.d45
const origOf = new Map([...cells].map(([id, p]) => [id, p]))
const R = 2, MAXDEV = 5
const ok = (v, P) => Math.max(Math.abs(P[0] - origOf.get(v)[0]), Math.abs(P[1] - origOf.get(v)[1])) <= MAXDEV
let cur = score(pos)
console.error('start', JSON.stringify(cur))
for (let round = 0; round < 8; round++) {
  let best = null
  const verts = [...pos.keys()]
  for (const v of verts) {
    const save = pos.get(v)
    for (let dc = -R; dc <= R; dc++) for (let dr = -R; dr <= R; dr++) {
      if (!dc && !dr) continue
      const P = [save[0] + dc, save[1] + dr]
      if (!ok(v, P) || !M.validMove(v, P)) continue
      M.applyMove(v, P)
      const s1 = score(pos)
      if (s1.acute <= cur.acute && s1.hv >= cur.hv - 2) {
        if (key(s1) > key(cur) && (!best || key(s1) > key(best.s))) best = { steps: [[v, P]], s: s1 }
        // 第二步：只在 v 與其鄰居上找
        const cand = new Set([v])
        for (const si of inc.get(v)) cand.add(other(segs[si], v))
        for (const w of cand) {
          const sw = pos.get(w)
          for (let dc2 = -R; dc2 <= R; dc2++) for (let dr2 = -R; dr2 <= R; dr2++) {
            if (!dc2 && !dr2) continue
            const Q = [sw[0] + dc2, sw[1] + dr2]
            if (!ok(w, Q) || !M.validMove(w, Q)) continue
            M.applyMove(w, Q)
            const s2 = score(pos)
            if (key(s2) > key(cur) && (!best || key(s2) > key(best.s))) best = { steps: [[v, P], [w, Q]], s: s2 }
            M.applyMove(w, sw)
          }
        }
      }
      M.applyMove(v, save)
    }
  }
  if (!best) break
  for (const [v, P] of best.steps) M.applyMove(v, P)
  cur = best.s
  console.error('round', round, best.steps.map(([v, P]) => `${nameById.get(v) ?? '×'}→${P}`).join(' + '), JSON.stringify(cur))
}
const out = {}
idsSorted.forEach((id, i) => {
  const p = pos.get(id), o = origOf.get(id)
  if (p[0] !== o[0] || p[1] !== o[1]) out[String(i)] = [p[0], p[1]]
})
console.log(JSON.stringify({ moves: out }))
