// 新舊 stores 管線輸出比對：同一份城市 geojson，跑 computeCityViews /
// computeCityHcViews / computeCityRwdViews，JSON 深度比對（逐位元）。
import fs from 'fs'
import * as oldVG from './old-stores/viewGeometry.js'
import * as newVG from '../src/stores/viewGeometry.js'

const cities = process.argv.slice(2)
let allOk = true
for (const city of cities) {
  const gj = JSON.parse(fs.readFileSync(city))
  for (const fn of ['computeCityViews', 'computeCityHcViews', 'computeCityRwdViews']) {
    const a = JSON.stringify(oldVG[fn](gj))
    const b = JSON.stringify(newVG[fn](gj))
    const ok = a === b
    allOk &&= ok
    console.log(`${city.split('/').pop()} ${fn}: ${ok ? 'IDENTICAL' : `DIFF (old ${a.length}B vs new ${b.length}B)`}`)
    if (!ok) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) { console.log('  first diff @', i, JSON.stringify(a.slice(Math.max(0,i-60), i+60)), '\n  vs', JSON.stringify(b.slice(Math.max(0,i-60), i+60))); break }
      }
    }
  }
}
process.exit(allOk ? 0 : 1)
