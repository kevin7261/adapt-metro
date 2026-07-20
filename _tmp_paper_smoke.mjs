// 煙霧測試：對幾個城市跑七條論文鏈（iteratePost 到不動點）＋ straightenCompactLoop，
// 驗證回傳形狀、確定性與耗時。臨時腳本，測完即刪。
import { readFile } from 'node:fs/promises'
import { geoMercator } from 'd3-geo'
import { buildConnectSkeleton } from './src/stores/skeleton.js'
import { buildSchematicGrid } from './src/stores/schematicGrid.js'
import { buildHillClimb, iteratePost, straightenCompactLoop, countHV, countHVD, buildHcGraph } from './src/stores/hillClimb.js'
import { PAPER_KINDS } from './src/stores/paperAlign.js'

const CITIES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'data/metro/systems/asia/taiwan/as-twn-taipei.geojson',
  'data/metro/systems/europe/france/eu-fra-paris.geojson',
  'data/metro/systems/asia/japan/as-jpn-tokyo.geojson',
]

for (const file of CITIES) {
  const geojson = JSON.parse(await readFile(file, 'utf8'))
  const skeleton = buildConnectSkeleton(geojson)
  const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
  const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
  const ext = [[14, 14], [186, 136]]
  const projection = geoMercator().fitExtent(ext, { type: 'FeatureCollection', features: lineFeats })
  const projById = new Map()
  for (const f of stations) {
    const p = projection(f.geometry.coordinates)
    if (p) projById.set(f.properties.station_id, p)
  }
  for (const c of skeleton.crossings ?? []) {
    const p = projection(c.coord)
    if (p) projById.set(c.id, p)
  }
  const grid = buildSchematicGrid(skeleton, projById, [14, 14, 186, 136])
  const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
  const g0 = buildHcGraph(skeleton, hc.cellAfter)
  console.log(`\n=== ${file.split('/').pop()} — verts ${g0.pos.size}, segs ${g0.segs.length}, grid ${grid.cols}x${grid.rows}, HC hv=${countHV(g0.pos, g0.segs)} hvd=${countHVD(g0.pos, g0.segs)}/${g0.segs.length}`)
  for (const { kind, build } of PAPER_KINDS) {
    const t0 = performance.now()
    let res
    try {
      res = iteratePost(build, skeleton, hc.cellAfter, grid.cols, grid.rows)
    } catch (err) {
      console.log(`  ${kind.padEnd(7)} ✗ ${err.message}\n${err.stack.split('\n').slice(1, 4).join('\n')}`)
      continue
    }
    const t1 = performance.now()
    // 確定性：跑第二次比對輸出
    const res2 = iteratePost(build, skeleton, hc.cellAfter, grid.cols, grid.rows)
    const same = JSON.stringify([...res.cellAfter].sort()) === JSON.stringify([...res2.cellAfter].sort())
    let loopMs = 0, loopInfo = ''
    try {
      const tl = performance.now()
      const comp = straightenCompactLoop(skeleton, res.cellAfter, grid.cols, grid.rows)
      loopMs = performance.now() - tl
      loopInfo = `loop ${comp.cols}x${comp.rows} hv ${comp.stats.hvAfter}/${comp.stats.segs} (${loopMs.toFixed(0)}ms)`
    } catch (err) { loopInfo = `loop ✗ ${err.message}` }
    const s = res.stats
    console.log(`  ${kind.padEnd(7)} hv ${s.hvBefore}→${s.hvAfter}, hvd ${s.hvdBefore ?? '?'}→${s.hvdAfter ?? '?'}, moved ${s.moved}, prop ${s.proposed ?? '?'}, revN ${s.revertedN ?? '?'}, iters ${s.iters}, ${((t1 - t0)).toFixed(0)}ms, det=${same ? 'ok' : 'FAIL'} | ${loopInfo}`)
  }
}
