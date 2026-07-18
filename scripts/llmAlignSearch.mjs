// throwaway search harness: reuse llmAlign loading, brute-force candidate moves
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHillClimb, buildHcGraph, applyLlmTargets } from '../src/stores/hillClimb.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'llmviews')
const cityId = 'as-jpn-tokyo-jr', variant = 'orig'
const outFile = join(OUT, `${cityId}.${variant}.prompt.json`)

const meta = JSON.parse(await readFile(join(DATA, 'views', `${cityId}.json`), 'utf8'))
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
const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
const saved = JSON.parse(await readFile(outFile, 'utf8'))
const baseCells = new Map(saved.cellAfter.map(([id, c, r]) => [id, [c, r]]))
const ids = [...baseCells.keys()].sort()
const { segs } = buildHcGraph(skeleton, baseCells)
const hvOf = (cells) => { let n=0; for (const s of segs){const A=cells.get(s.a),B=cells.get(s.b); if((A[0]===B[0])!==(A[1]===B[1]))n++} return n }
const hvdOf = (cells) => { let n=0; for (const s of segs){const A=cells.get(s.a),B=cells.get(s.b);const dc=Math.abs(A[0]-B[0]),dr=Math.abs(A[1]-B[1]); if((dc===0)!==(dr===0)||(dc===dr&&dc!==0))n++} return n }
const HV0 = hvOf(baseCells), HVD0 = hvdOf(baseCells)
console.error('base hv', HV0, 'hvd', HVD0)

// try a set of {idx: [c,r]} moves, return resulting hv/hvd/reverted
function trial(movesByIdx) {
  const entries = Object.entries(movesByIdx).map(([i, t]) => [ids[+i], t])
  const res = applyLlmTargets(skeleton, baseCells, grid.cols, grid.rows, entries)
  return { hv: res.stats.hvAfter, hvd: res.stats.hvdAfter, reverted: res.stats.reverted,
           cells: res.cellAfter }
}

// parse args: "search <idxCsv>" scans single moves in radius; "try <json>" tests a set
const mode = process.argv[2]
if (mode === 'try') {
  const mv = JSON.parse(process.argv[3])
  const r = trial(mv)
  console.log(JSON.stringify({ ...r, dHv: r.hv - HV0, dHvd: r.hvd - HVD0, cells: undefined }))
} else if (mode === 'search') {
  const targetIdxs = process.argv[3].split(',').map(Number)
  const RAD = Number(process.argv[4] ?? 3)
  const verts = new Map(ids.map((id, i) => [i, baseCells.get(id)]))
  const hits = []
  for (const idx of targetIdxs) {
    const [c0, r0] = verts.get(idx)
    for (let dc = -RAD; dc <= RAD; dc++) for (let dr = -RAD; dr <= RAD; dr++) {
      if (!dc && !dr) continue
      const c = c0 + dc, r = r0 + dr
      const res = trial({ [idx]: [c, r] })
      if (!res.reverted && (res.hv > HV0 || (res.hv === HV0 && res.hvd > HVD0))) {
        // check it actually moved
        const got = res.cells.get(ids[idx])
        if (got[0] === c && got[1] === r) hits.push({ idx, to: [c, r], hv: res.hv, hvd: res.hvd, dHv: res.hv - HV0, dHvd: res.hvd - HVD0 })
      }
    }
  }
  hits.sort((a, b) => (b.dHv - a.dHv) || (b.dHvd - a.dHvd))
  console.log(JSON.stringify(hits, null, 0))
}
