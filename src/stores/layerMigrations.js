// Session／圖層名稱 migration（純函式）——從 mapStore 抽出，方便單獨閱讀與測試。
import CITY_ZH from './cityNamesZh.json'
import { RWD_COMPACTS } from '../lib/rwdCompacts.js'

// Display name for a metro system = Chinese 城市・國名 (from cityNamesZh.json,
// keyed by the geojson file stem; 中點分隔，與 Info tab 城市標題一致)。
export function metroDisplayName(id) {
  const zh = CITY_ZH[id]
  if (zh) return `${zh.city}・${zh.country}`
  // 圖層顯示名一定要中文（使用者規則）：合併系統（-jr／-lm）若漏建中文名，退回 base
  // 城市中文名＋後綴，**絕不**顯示英文 slug。
  const m = /^(.+)-(jr|lm)$/.exec(id)
  const b = m && CITY_ZH[m[1]]
  if (b) return `${b.city}${m[2] === 'lm' ? '＋地標' : '＋線'}・${b.country}`
  return id
}

export const variantLabel = (v) => (v === 'rot' ? '旋轉' : '原始')

// Recover the metro geojson stem from a legacy prefixed name
// ("rwd-hc-d3-am-mex-mexico-city-orig" → "am-mex-mexico-city").
function legacyMetroId(name) {
  if (typeof name !== 'string') return null
  const stem = name.replace(/^(rwd-)?(hc-)?(d3-)?/, '').replace(/-(orig|rot)$/, '')
  return CITY_ZH[stem] ? stem : null
}

// One-time migration for sessions saved before layer names dropped their type
// prefixes. Idempotent.
export function migrateLayerNames(layers) {
  const byId = new Map(layers.map((l) => [l.id, l]))
  // 2026-07: Railways / Highways groups folded into Raw Maps.
  for (const l of layers) {
    if (l.groupId === 'railway-maps' || l.groupId === 'highway-maps') l.groupId = 'metro-maps'
  }
  for (const l of layers) {
    if (l.type === 'metro' && CITY_ZH[l.id]) {
      l.countryZh ??= CITY_ZH[l.id].country
      l.cityZh ??= CITY_ZH[l.id].city
    }
  }
  const nameOf = (l) => {
    if (!l) return undefined
    if (l.railway) return l.countryZh ?? l.name
    if (l.highway) return l.cityZh ?? l.countryZh ?? l.name
    if (l.type === 'metro') return metroDisplayName(l.id)
    const src = l.sourceLayerId ? byId.get(l.sourceLayerId) : null
    const base = src ? nameOf(src) : (legacyMetroId(l.name) ? metroDisplayName(legacyMetroId(l.name)) : null)
    if (base == null) return l.name
    if (l.type === 'hillclimb') return `${base}（${variantLabel(l.variant)}）`
    return base
  }
  for (const l of layers) l.name = nameOf(l)
  return layers
}

// 補齊 Straighten ×2 ＋ RWD ×18；沒建過 Map Adjust 的城市不強加。Idempotent。
export function backfillCityChains(layers) {
  const nextId = (prefix) => {
    let n = 1
    while (layers.some((l) => l.id === `${prefix}-${n}`)) n++
    return `${prefix}-${n}`
  }
  for (const metro of [...layers]) {
    if (metro.type !== 'metro' || metro.railway || metro.highway) continue
    const d3 = layers.find((l) => l.type === 'd3' && l.sourceLayerId === metro.id)
    if (!d3) continue
    const hcOf = {}
    for (const v of ['orig', 'rot']) {
      let hc = layers.find((l) => l.type === 'hillclimb' && l.sourceLayerId === d3.id && l.variant === v)
      if (!hc) {
        hc = {
          id: nextId('hc-view'), name: `${d3.name}（${variantLabel(v)}）`, type: 'hillclimb',
          groupId: 'hillclimb', sourceLayerId: d3.id, variant: v, visible: true, opacity: 1,
        }
        layers.push(hc)
      }
      hcOf[v] = hc
    }
    for (const v of ['orig', 'rot']) for (const c of RWD_COMPACTS) {
      if (!layers.some((l) => l.type === 'rwd' && l.sourceLayerId === hcOf[v].id && l.compact === c)) {
        layers.push({
          id: nextId('rwd-view'), name: hcOf[v].name, type: 'rwd',
          groupId: 'rwd', sourceLayerId: hcOf[v].id, compact: c, visible: true, opacity: 1,
        })
      }
    }
  }
  return layers
}
