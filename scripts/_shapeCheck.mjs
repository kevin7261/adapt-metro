// Fast oracle: mirror applyShapeLlmTargets batch gates against the CURRENT
// persisted base (data/metro/llmshapes/<city>.<variant>.json) or grid-post.
// Reports crossings / cellClash / ptOverlap / badEdgeOrder with labels so a
// candidate moves.json can be tuned to batch-clean BEFORE spending an apply.
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
const cityId = process.argv[2] || 'as-jpn-tokyo-jr'
const variant = process.argv[3] || 'orig'
const candPath = process.argv[4]
const outFile = join(DATA, 'llmshapes', `${cityId}.${variant}.json`)

const meta = JSON.parse(await readFile(join(DATA, 'views', `${cityId}.json`), 'utf8'))
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
const cols = grid.cols, rows = grid.rows
const { pos: gp, segs: segs0 } = buildHcGraph(skeleton, grid.cellOf)
const fingerprint = { verts: gp.size, segs: segs0.length, cols, rows }
let saved = null
if (existsSync(outFile)) {
  saved = JSON.parse(await readFile(outFile, 'utf8'))
  if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fingerprint)) saved = null
}
const baseCells = saved
  ? new Map(saved.cellAfter.map(([id, c, r]) => [id, [c, r]]))
  : new Map([...grid.cellOf].map(([id, p]) => [id, [...p]]))
const ids = [...baseCells.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const idOf = (i) => ids[i]
// rebuild pos0/segs from baseCells
const { pos: pos0b, segs: segsB } = buildHcGraph(skeleton, baseCells)
const pos0 = pos0b
const ctx = shapeLlmContext(skeleton, baseCells, cols, rows, cityId)
const ringSet = new Set(ctx.cutIds)

const ckey = (c, r) => `${c},${r}`
const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
const onCellSeg = (p, a, b) => orient(a, b, p) === 0 && Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
function segIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
  return (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
}
function rebuildInc(segs) { const inc = new Map(); for (let si = 0; si < segs.length; si++) { const s = segs[si]; if (!inc.has(s.a)) inc.set(s.a, []); if (!inc.has(s.b)) inc.set(s.b, []); inc.get(s.a).push(si); inc.get(s.b).push(si) } return inc }
function cyclicEqual(a, b) { if (a.length !== b.length) return false; if (!a.length) return true; const st = b.indexOf(a[0]); if (st < 0) return false; for (let i = 1; i < a.length; i++) if (a[i] !== b[(st + i) % b.length]) return false; return true }
const isGreen = (id) => String(id).startsWith('g')
function orderIds(inc, segs, posMap) {
  const farNbr = (u, si) => { const s0 = segs[si]; let prev = u, cur = s0.a === u ? s0.b : s0.a, g = 0; while (isGreen(cur) && g++ < 32) { const nxt = (inc.get(cur) ?? []).map((sj) => { const s = segs[sj]; return s.a === cur ? s.b : s.a }).filter((id) => id !== prev); if (!nxt.length) break; prev = cur; cur = nxt[0] } return cur }
  const out = new Map()
  for (const [u, list] of inc) { if ((list?.length ?? 0) < 3) continue; if (!posMap.has(u)) continue; const pu = posMap.get(u); const items = []; for (const si of list) { const oid = farNbr(u, si); const o = posMap.get(oid); if (!o || (o[0] === pu[0] && o[1] === pu[1])) continue; items.push([Math.atan2(o[1] - pu[1], o[0] - pu[0]), oid]) } items.sort((p, q) => p[0] - q[0] || String(p[1]).localeCompare(String(q[1]))); out.set(u, items.map((it) => it[1])) }
  return out
}
function lbl(id) { if (isGreen(id)) return id; const i = idxOf.get(id); return `${ringSet.has(id) ? 'R' : '.'}i${i}` }

const cand = JSON.parse(await readFile(candPath, 'utf8'))
let segs = segsB.map((s) => ({ ...s }))
const geo = new Map([...pos0].map(([id, p]) => [id, [...p]]))
let gi = 0
for (const g of (cand.greens ?? [])) { const a = idOf(+g.a), b = idOf(+g.b); const si = segs.findIndex((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a)); if (si < 0) { console.log('GREEN MISSING (no direct seg)', g); continue } const gid = `g${gi++}`; geo.set(gid, [g.cell[0], g.cell[1]]); const old = segs[si]; segs.splice(si, 1, { a: old.a, b: gid }, { a: gid, b: old.b }) }
const inc = rebuildInc(segs)
const frozen = new Set()
for (const i of Object.keys(cand.moves ?? {})) frozen.add(idOf(+i))
for (let k = 0; k < gi; k++) frozen.add(`g${k}`)
const trial = new Map([...geo].map(([id, p]) => [id, [...p]]))
for (const [i, t] of Object.entries(cand.moves ?? {})) trial.set(idOf(+i), [t[0], t[1]])
function occ(m) { const s = new Set(); for (const [, p] of m) s.add(ckey(p[0], p[1])); return s }
for (let round = 0; round < 40; round++) { const byCell = new Map(); let clash = false; for (const [id, p] of trial) { const k = ckey(p[0], p[1]); if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(id) } for (const arr of byCell.values()) { if (arr.length < 2) continue; clash = true; const movers = arr.filter((id) => !frozen.has(id)); const victims = movers.length ? movers : arr.slice(1); for (const id of victims) { const p = trial.get(id); let found = null; for (let rad = 1; rad <= 10 && !found; rad++)for (let dc = -rad; dc <= rad && !found; dc++)for (let dr = -rad; dr <= rad && !found; dr++) { if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue; const c = Math.max(0, Math.min(cols - 1, p[0] + dc)); const r = Math.max(0, Math.min(rows - 1, p[1] + dr)); if (occ(trial).has(ckey(c, r))) continue; found = [c, r] } if (found) trial.set(id, found) } } if (!clash) break }

let cellClash = false; { const s = new Set(); for (const [, p] of trial) { const k = ckey(p[0], p[1]); if (s.has(k)) { cellClash = true; break } s.add(k) } }
let ptOverlap = null
outer: for (const [id, p] of trial) { for (const s of segs) { if (s.a === id || s.b === id) continue; const A = trial.get(s.a), B = trial.get(s.b); if (!A || !B) continue; if ((p[0] === A[0] && p[1] === A[1]) || (p[0] === B[0] && p[1] === B[1])) continue; if (onCellSeg(p, A, B)) { ptOverlap = `${lbl(id)} on ${lbl(s.a)}-${lbl(s.b)}`; break outer } } }
let cross = 0; const xpairs = []; for (let i = 0; i < segs.length; i++) { const A = trial.get(segs[i].a), B = trial.get(segs[i].b); if (!A || !B) continue; for (let j = i + 1; j < segs.length; j++) { if (segs[i].a === segs[j].a || segs[i].a === segs[j].b || segs[i].b === segs[j].a || segs[i].b === segs[j].b) continue; const C = trial.get(segs[j].a), D = trial.get(segs[j].b); if (!C || !D) continue; if (segIntersect(A, B, C, D)) { cross++; xpairs.push(`${lbl(segs[i].a)}-${lbl(segs[i].b)} X ${lbl(segs[j].a)}-${lbl(segs[j].b)}`) } } }
const cross0 = (() => { let n = 0; for (let i = 0; i < segsB.length; i++) { const A = pos0.get(segsB[i].a), B = pos0.get(segsB[i].b); if (!A || !B) continue; for (let j = i + 1; j < segsB.length; j++) { if (segsB[i].a === segsB[j].a || segsB[i].a === segsB[j].b || segsB[i].b === segsB[j].a || segsB[i].b === segsB[j].b) continue; const C = pos0.get(segsB[j].a), D = pos0.get(segsB[j].b); if (!C || !D) continue; if (segIntersect(A, B, C, D)) n++ } } return n })()
const oa = orderIds(inc, segs, geo), ob = orderIds(inc, segs, trial)
const badOrder = []
for (const [u, seqA] of oa) { const seqB = ob.get(u); if (!seqB || !cyclicEqual(seqA, seqB)) badOrder.push(lbl(u)) }
for (const p of xpairs.slice(0, 30)) console.log('  X', p)
console.log(`cross0=${cross0} -> cross=${cross} ${cross <= cross0 ? 'OK' : 'FAIL(+)'} | cellClash: ${cellClash} | ptOverlap: ${ptOverlap || 'none'} | badEdgeOrder: ${badOrder.length ? badOrder.join(',') : 'none'}`)
for (const u of badOrder.slice(0, 10)) { const id = [...geo.keys()].find((x) => lbl(x) === u); console.log('  ', u, 'geo:', oa.get(id).map(lbl).join(' '), '=> trial:', ob.get(id).map(lbl).join(' ')) }
const wouldBatch = cross <= cross0 && !cellClash && !ptOverlap && badOrder.length === 0
console.log('WOULD BATCH:', wouldBatch)
