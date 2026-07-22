import { readFile } from 'node:fs/promises'
import { computeCityHcViews } from '../src/stores/viewGeometry.js'
for (const city of ['as-jpn-tokyo','as-sgp-singapore','eu-rus-moscow']) {
  const gj = JSON.parse(await readFile('data/metro/'+JSON.parse(await readFile('data/metro/map-adjust/'+city+'.json','utf8')).file,'utf8'))
  let shp=null; try { shp = JSON.parse(await readFile('data/metro/straighten-shape/'+city+'.orig.json','utf8')) } catch {}
  const t0 = Date.now()
  const r = computeCityHcViews(gj, { cityId:city, shapeByVariant:{orig:shp,rot:null}, llmByVariant:{} })
  const sv = Object.keys(r.views).filter(k=>/-shape$/.test(k))
  console.log(city, 'done in', Date.now()-t0, 'ms | shape views:', sv.length)
}
