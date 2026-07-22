// Diagnostic for route-llm-shape reverts: mirror the batch-trial construction in
// applyShapeLlmTargets and print the EXACT new crossing pairs (stable indices;
// R-prefix = ring station), plus inside/outside classification of non-ring verts.
//   node scripts/_shapeDiag.mjs <cityId> <orig|rot> <moves.json>
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, setSpanCap } from '../src/stores/hillClimb.js'
import { shapeLlmContext } from '../src/stores/paper/shape.js'

setSpanCap(+(process.env.LLM_SPAN_CAP ?? 3) || 3)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'straighten-shape')
const [cityId, variant = 'orig', movesPath] = process.argv.slice(2)

const meta = JSON.parse(await readFile(join(DATA, 'map-adjust', `${cityId}.json`), 'utf8'))
const geojson = JSON.parse(await readFile(join(DATA, meta.file), 'utf8'))
const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }
const tilt = computeOrientation(geojson).tilt
const skeleton = buildConnectSkeleton(geojson)
const angle = variant === 'rot' && Math.abs(tilt) >= 0.5 ? tilt : 0
const projection = geoMercator().angle(angle).fitExtent([[24, 24], [1176, 776]], fitFC)
const projById = new Map()
for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
const gridCells = grid.cellOf
const { pos: gp, segs: gseg } = buildHcGraph(skeleton, gridCells)
const fingerprint = { verts: gp.size, segs: gseg.length, cols: grid.cols, rows: grid.rows }
let saved = null
const outFile = join(OUT, `${cityId}.${variant}.json`)
if (existsSync(outFile)) {
  saved = JSON.parse(await readFile(outFile, 'utf8'))
  if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fingerprint)) saved = null
}
const baseCells = saved ? new Map(saved.cellAfter.map(([id, c, r]) => [id, [c, r]]))
  : new Map([...gridCells].map(([id, p]) => [id, [...p]]))
const ids = [...baseCells.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))

const ctx = shapeLlmContext(skeleton, baseCells, grid.cols, grid.rows, cityId)
const ringIds = new Set(ctx.cutIds)
const ringSet = ctx.cutIds
const spec = JSON.parse(await readFile(movesPath, 'utf8'))

const { pos: pos0map, segs: segs0 } = buildHcGraph(skeleton, baseCells)
const clone = (m) => new Map([...m].map(([id, p]) => [id, [...p]]))
const ekey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`)

// --- insert greens (mirror splitSegAt) ---
let pos = clone(pos0map)
let segs = segs0.map((s) => ({ a: s.a, b: s.b }))
const pkey = segs.map((s) => ekey(s.a, s.b))
const cl = (c, lim) => Math.max(0, Math.min(lim - 1, c))
let gi = 0
const greens = []
for (const g of (spec.greens ?? [])) {
  if (greens.length >= 4) break
  const a = ids[+g.a], b = ids[+g.b]
  const si = segs.findIndex((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))
  if (si < 0) { console.log(`green rejected (no direct seg): a=${g.a} b=${g.b}`); continue }
  const gid = `shape-g${gi++}`
  const parent = pkey[si]
  const c = cl(g.cell[0], grid.cols), r = cl(g.cell[1], grid.rows)
  pos.set(gid, [c, r])
  segs[si] = { a: segs[si].a, b: gid }
  segs.push({ a: gid, b: segs[si].__b ?? b })
  // fix: split a-b into a-gid and gid-b
  segs[si] = { a, b: gid }
  segs[segs.length - 1] = { a: gid, b }
  pkey.push(parent)
  greens.push({ id: gid, a, b, c, r })
}
const geo = clone(pos)

// --- apply targets ---
const isGreen = (id) => String(id).startsWith('shape-g')
const targets = new Map()
for (const [i, t] of Object.entries(spec.moves ?? {})) {
  const id = ids[+i]
  if (!id || isGreen(id)) continue
  targets.set(id, [cl(t[0], grid.cols), cl(t[1], grid.rows)])
}
const frozen = new Set([...targets.keys(), ...greens.map((g) => g.id)])
const trial = clone(geo)
for (const [id, t] of targets) trial.set(id, t)
// resolveCellClashes (simplified, mirrors shape.js)
const ckey = (c, r) => `${c},${r}`
for (let round = 0; round < 40; round++) {
  const byCell = new Map()
  let clash = false
  for (const [id, p] of trial) { const k = ckey(p[0], p[1]); if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(id) }
  for (const arr of byCell.values()) {
    if (arr.length < 2) continue
    clash = true
    const movers = arr.filter((id) => !frozen.has(id))
    const victims = movers.length ? movers : arr.slice(1)
    for (const id of victims) {
      const p = trial.get(id); let found = null
      for (let rad = 1; rad <= 10 && !found; rad++)
        for (let dc = -rad; dc <= rad && !found; dc++)
          for (let dr = -rad; dr <= rad && !found; dr++) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
            const c = Math.max(0, Math.min(grid.cols - 1, p[0] + dc)), r = Math.max(0, Math.min(grid.rows - 1, p[1] + dr))
            const k = ckey(c, r); let occ = false
            for (const [, q] of trial) if (q[0] === c && q[1] === r) { occ = true; break }
            if (!occ) found = [c, r]
          }
      if (found) trial.set(id, found)
    }
  }
  if (!clash) break
}

const segIntersect = (a, b, c, d) => {
  const cr = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}
const lbl = (id) => {
  if (isGreen(id)) return `G${id.replace('shape-g', '')}`
  const i = idxOf.get(id)
  return (ringIds.has(id) ? 'R' : '') + i
}
const crossKeys = (posMap, sgs, keyOf) => {
  const pairs = []
  for (let i = 0; i < sgs.length; i++) {
    const A = posMap.get(sgs[i].a), B = posMap.get(sgs[i].b)
    if (!A || !B) continue
    for (let j = i + 1; j < sgs.length; j++) {
      const s = sgs[i], t = sgs[j]
      if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) continue
      const ki = keyOf(i), kj = keyOf(j)
      if (ki === kj) continue
      const C = posMap.get(t.a), D = posMap.get(t.b)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) pairs.push({ i, j, ki, kj, ekey: ki < kj ? `${ki}#${kj}` : `${kj}#${ki}` })
    }
  }
  return pairs
}
const baseKeyArr = segs0.map((s) => ekey(s.a, s.b))
const basePairs = crossKeys(pos0map, segs0.map((s) => ({ a: s.a, b: s.b })), (i) => baseKeyArr[i])
const baseSet = new Set(basePairs.map((p) => p.ekey))
const candPairs = crossKeys(trial, segs, (i) => pkey[i])
const newPairs = candPairs.filter((p) => !baseSet.has(p.ekey))

console.log(`base crosses: ${basePairs.length}  candidate crosses: ${candPairs.length}  NEW: ${newPairs.length}`)
const seen = new Set()
for (const p of newPairs) {
  const s = segs[p.i], t = segs[p.j]
  const desc = `${lbl(s.a)}-${lbl(s.b)}  ✕  ${lbl(t.a)}-${lbl(t.b)}`
  if (seen.has(desc)) continue
  seen.add(desc)
  const pa = trial.get(s.a), pb = trial.get(s.b), pc = trial.get(t.a), pd = trial.get(t.b)
  console.log(`  NEW ✕  [${lbl(s.a)}(${pa})–${lbl(s.b)}(${pb})]  x  [${lbl(t.a)}(${pc})–${lbl(t.b)}(${pd})]`)
}

// --- point overlap (cell clash + station-on-foreign-seg) ---
const orient = (a, b, p) => Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]))
const onCellSeg = (p, a, b) => orient(a, b, p) === 0
  && Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0])
  && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
{
  const seen = new Map()
  for (const [id, p] of trial) { const k = ckey(p[0], p[1]); if (seen.has(k)) console.log(`CELL CLASH: ${lbl(id)} & ${lbl(seen.get(k))} both at ${p}`); else seen.set(k, id) }
  for (const [id, p] of trial) for (const s of segs) {
    if (s.a === id || s.b === id) continue
    const A = trial.get(s.a), B = trial.get(s.b); if (!A || !B) continue
    if ((p[0] === A[0] && p[1] === A[1]) || (p[0] === B[0] && p[1] === B[1])) continue
    if (onCellSeg(p, A, B)) console.log(`POINT-ON-SEG: ${lbl(id)}(${p}) on ${lbl(s.a)}(${A})-${lbl(s.b)}(${B})`)
  }
}

// --- 360deg winding-order (edgeOrdersMatch geo vs trial) ---
{
  const inc = new Map()
  for (let si = 0; si < segs.length; si++) { const s = segs[si]; if (!inc.has(s.a)) inc.set(s.a, []); if (!inc.has(s.b)) inc.set(s.b, []); inc.get(s.a).push(si); inc.get(s.b).push(si) }
  const farNbr = (u, si, at) => {
    let prev = u, cur = segs[si].a === u ? segs[si].b : segs[si].a, guard = 0
    while (isGreen(cur) && guard++ < 32) {
      const nxt = (inc.get(cur) ?? []).map((sj) => segs[sj].a === cur ? segs[sj].b : segs[sj].a).filter((id) => id !== prev)
      if (!nxt.length) break; prev = cur; cur = nxt[0]
    }
    return cur
  }
  const orderIds = (posMap) => {
    const out = new Map()
    for (const [u, list] of inc) {
      if ((list?.length ?? 0) < 3 || !posMap.has(u)) continue
      const pu = posMap.get(u); if (!pu) continue
      const items = []
      for (const si of list) { const oid = farNbr(u, si, (id) => posMap.get(id)); const o = posMap.get(oid); if (!o || (o[0] === pu[0] && o[1] === pu[1])) continue; items.push([Math.atan2(o[1] - pu[1], o[0] - pu[0]), oid]) }
      items.sort((p, q) => p[0] - q[0] || String(p[1]).localeCompare(String(q[1])))
      out.set(u, items.map((it) => it[1]))
    }
    return out
  }
  const cyclicEqual = (a, b) => { if (a.length !== b.length) return false; if (!a.length) return true; const st = b.indexOf(a[0]); if (st < 0) return false; for (let i = 1; i < a.length; i++) if (a[i] !== b[(st + i) % b.length]) return false; return true }
  const oa = orderIds(geo), ob = orderIds(trial)
  let nbad = 0
  for (const [u, seqA] of oa) { const seqB = ob.get(u); if (!seqB || !cyclicEqual(seqA, seqB)) { nbad++; console.log(`WINDING FLIP @ ${lbl(u)}: base[${seqA.map(lbl)}] -> cand[${(seqB ?? []).map(lbl)}]`) } }
  console.log(`winding flips: ${nbad}`)
}

// classify non-ring verts inside/outside ring polygon (using base positions)
const ringPoly = ringSet.map((id) => pos0map.get(id))
const inside = (pt) => {
  let c = false
  for (let i = 0, j = ringPoly.length - 1; i < ringPoly.length; j = i++) {
    const xi = ringPoly[i][0], yi = ringPoly[i][1], xj = ringPoly[j][0], yj = ringPoly[j][1]
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) c = !c
  }
  return c
}
const outs = []
for (const id of ids) {
  if (ringIds.has(id)) continue
  const p = pos0map.get(id)
  if (!inside(p)) outs.push(`${idxOf.get(id)}(${p})`)
}
console.log(`non-ring OUTSIDE ring (base): ${outs.join('  ')}`)
