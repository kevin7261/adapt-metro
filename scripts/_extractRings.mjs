import { readFile } from 'node:fs/promises'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
const rings = [
  ['as-twn-kaohsiung', 'rm5593997', '高雄環狀輕軌'],
  ['as-jpn-osaka-jr', 'jr10073683', '大阪環状線'],
  ['as-kor-seoul', 'rm7625892', 'Line 2 循環線'],
  ['as-chn-shanghai', 'rm7448424', '4号线（紫）'],
  ['eu-ger-berlin', 'rm7369771', 'Ringbahn S41/S42'],
  ['eu-rus-moscow', 'rm1462012', '5號環線 Koltsevaya'],
  ['eu-rus-moscow', 'rm8119161', '11號大環線 BKL'],
]
const dedupeAdj = (ids) => ids.filter((id, i) => i === 0 || id !== ids[i - 1])
for (const [cityId, routeId, label] of rings) {
  const meta = JSON.parse(await readFile(`data/metro/views/${cityId}.json`, 'utf8'))
  const gj = JSON.parse(await readFile(`data/metro/${meta.file}`, 'utf8'))
  const sk = buildConnectSkeleton(gj)
  const rt = [...sk.routes.values()].find((r) => r.id === routeId)
  const st = dedupeAdj(rt.stations ?? [])
  const closed = st[0] === st[st.length - 1]
  console.log(`\n// ${cityId} — ${label} (${routeId}) ${st.length} 站 ${closed ? '閉合' : '未閉合'}`)
  console.log(`routeId: '${routeId}', label: '${label}', nStations: ${st.length}`)
  // print as compact array
  const lines = []
  for (let i = 0; i < st.length; i += 6) lines.push('  ' + st.slice(i, i + 6).map(s => `'${s}'`).join(', ') + ',')
  console.log('stations: [\n' + lines.join('\n') + '\n],')
}
