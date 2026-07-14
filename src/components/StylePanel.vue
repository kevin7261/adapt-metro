<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { marked } from 'marked'
import { useMapStore } from '../stores/mapStore'
import { layerData } from '../stores/layerData'
import { prettyContinent, continentZh, loadMapsIndex } from '../stores/metroCatalog'
import { assetUrl } from '../lib/assetUrl'
import { computeOrientation } from '../stores/orientation'
import { computePassThrough } from '../stores/skeleton'
import OrientationRose from './OrientationRose.vue'
import MIcon from './MIcon.vue'

// The layer this tab edits — passed in by LayerTab.
const props = defineProps({
  layer: { type: Object, required: true },
  // LLM 對齊 provenance (the llmview file: model / prompt / per-round
  // transcript / finalOutput) — passed by D3Tab for Hill Climbing views;
  // when present, an extra「LLM對齊」tab appears after Object.
  llmRecord: { type: Object, default: null },
  // Run controls, wired to D3Tab's headless trigger: whether a run is in
  // flight, and whether this view has a city id to run against.
  llmRunning: { type: Boolean, default: false },
  llmCanRun: { type: Boolean, default: false },
  // LLM 調整（RWD Maps「AI 改網格長寬」，skill route-llm-grid）：結果檔
  // （model / userPrompt / note / colW / rowW）＋run 控制——D3Tab 對 RWD 視圖
  // 傳入；「LLM調整」tab 對 rwd 常駐（輸入一句話就從這裡觸發）。
  gridRecord: { type: Object, default: null },
  gridRunning: { type: Boolean, default: false },
  gridCanRun: { type: Boolean, default: false },
  // 'd3' when shown inside a Map Adjust (D3.js) tab — Info then documents the
  // skeleton rules instead of the audit verdict.
  context: { type: String, default: 'map' },
  // Which D3 view this is: 'map-adjust' | 'hillclimb' | 'rwd' (D3Tab sets it),
  // or 'metro' for the MapLibre tab. Orientation shows only for metro maps and
  // Map Adjust; the skeleton rules only for Map Adjust.
  viewKind: { type: String, default: 'metro' },
  // RWD Maps 權重驅動版面（論文 §九）：目前模式（'uniform' | 'weight'），tab 在物件之後。
  weightMode: { type: String, default: 'uniform' },
  weightAuto: { type: Boolean, default: false }, // 每 5 秒自動重抽是否開啟
  showWeights: { type: Boolean, default: true },  // 是否顯示 weight 數字
  hideStops: { type: Boolean, default: false },  // 自動隱藏白點
  minStopPx: { type: Number, default: 5 },       // 最小站距門檻（pt），站距 < 此值才刪
  stopStat: { type: Object, default: null },     // { high, wide, hidden, hiddenNames, hiddenMaxT }
})
const emit = defineEmits(['run-llm', 'run-grid', 'weight-mode', 'weight-random', 'weight-auto', 'hide-stops', 'min-stop-px', 'show-weights'])
const llmUserPrompt = ref('')
const gridUserPrompt = ref('')
const isD3 = computed(() => props.context === 'd3')
const isMapAdjust = computed(() => isD3.value && props.viewKind === 'map-adjust')
// Orientation rose: metro maps (MapLibre) + Map Adjust only, not HC / RWD.
const showOrientation = computed(() => !isD3.value || isMapAdjust.value)

const open = ref(true)
const width = ref(300)

// Panel sections — the LLM對齊 tab appears only once a run has produced a
// record (llmRecord prop from D3Tab).
const TABS = computed(() => [
  { id: 'info', label: '資訊' },
  { id: 'style', label: '樣式' },
  { id: 'object', label: '物件' },
  ...(props.viewKind === 'rwd' ? [{ id: 'weight', label: '權重' }, { id: 'grid', label: 'LLM調整' }] : []),
  ...(props.llmRecord ? [{ id: 'llm', label: 'LLM對齊' }] : []),
])
const activeTab = ref('info')

/* ---- Object: properties of the last-clicked map feature (blank if none) ---- */
const store = useMapStore()
const selectedProps = computed(() => store.selectedFeatures[props.layer.id] ?? null)
const asText = (v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}
// A wikipedia value is a raw OSM tag ("en:Taipei Main Station") or a URL;
// a wikidata value is a Q-id. Turn both into a clickable link in the Object tab.
const linkFor = (key, v) => {
  if (typeof v !== 'string' || !v) return null
  if (key === 'wikipedia') {
    if (/^https?:\/\//.test(v)) return v
    const m = /^([a-z-]+):(.+)$/.exec(v)
    if (m) return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(v.replace(/ /g, '_'))}`
  }
  if (key === 'wikidata' && /^Q\d+$/.test(v)) return `https://www.wikidata.org/wiki/${v}`
  return null
}
// MapLibre serialises nested arrays/objects to JSON strings for GeoJSON source
// features — parse them back. Arrays render as an ordered list (no brackets);
// everything else as text.
const selectedEntries = computed(() => {
  const p = selectedProps.value
  if (!p) return []
  // Skip internal render-only props (e.g. `_c0.._c5` flattened dash colours).
  return Object.keys(p).filter((k) => !k.startsWith('_')).sort().map((k) => {
    let v = p[k]
    if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
      try { v = JSON.parse(v) } catch { /* leave as-is */ }
    }
    if (Array.isArray(v)) return { key: k, isList: true, items: v.map(asText) }
    const href = linkFor(k, v)
    return { key: k, isList: false, value: asText(v), href }
  })
})

// Clicking a feature auto-opens the Object tab (only when something is selected).
watch(selectedProps, (v) => { if (v) activeTab.value = 'object' })

// Pass-through relation (chord-proximity, skeleton.js): per-station stop/pass
// routes + per-route merged station order. Computed once per dataset.
const passThrough = computed(() => {
  const d = layerData[layer.value?.id]
  return d ? computePassThrough(d) : null
})
// Station object: routes that STOP here vs PASS here without stopping.
const stopRoutes = computed(() => {
  const sid = selectedProps.value?.station_id
  return (sid && passThrough.value?.stopByStation.get(sid)) || []
})
const passRoutes = computed(() => {
  const sid = selectedProps.value?.station_id
  return (sid && passThrough.value?.passByStation.get(sid)) || []
})
// The LLM對齊 tab can disappear (layer/data change) — fall back to Info.
watch(() => props.llmRecord, (v) => { if (!v && activeTab.value === 'llm') activeTab.value = 'info' })

// The skill that drove the run — fetched once when the LLM對齊 / LLM調整 tab
// first opens (same source + rendering as SkillViewer: /skills/<id>.md).
const llmSkillHtml = ref('')
const gridSkillHtml = ref('')
const fetchSkillHtml = async (id, target) => {
  try {
    const res = await fetch(assetUrl(`skills/${id}.md`))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = (await res.text()).replace(/^---\n[\s\S]*?\n---\n/, '')
    target.value = marked.parse(md)
  } catch (err) {
    target.value = `<p>SKILL.md 載入失敗：${err}</p>`
  }
}
watch(activeTab, (t) => {
  if (t === 'llm' && !llmSkillHtml.value) fetchSkillHtml('route-llm-align', llmSkillHtml)
  if (t === 'grid' && !gridSkillHtml.value) fetchSkillHtml('route-llm-grid', gridSkillHtml)
})

// 點到路段時：顯示每條行經 route 的完整車站列表（依站序）。
// 列表來自 route meta 的 stations（build 保證與圖面一致——audit 有不變式檢查）。
const selectedRouteLists = computed(() => {
  const p = selectedProps.value
  if (!p) return []
  let routes = p.routes
  if (typeof routes === 'string') { try { routes = JSON.parse(routes) } catch { return [] } }
  if (!Array.isArray(routes)) return []
  return routes.map((r) => ({
    route_id: r.route_id,
    name: r.route_name ?? r.route_id,
    ref: r.route_ref,
    color: r.route_color ?? '#e11d48',
    // Merged order: stops + 通過不停(pass:true) interleaved by position; falls
    // back to the raw stop list if the pass-through map isn't ready.
    stations: passThrough.value?.seqByRoute.get(r.route_id)
      ?? (r.stations ?? []).map((s) => ({ ...s, pass: false })),
    // 站數只算停靠站（保序不去重——支線接續/環線閉合站重複）
    uniqueCount: new Set((r.stations ?? []).map((s) => s.station_id)).size,
  }))
})

const layer = computed(() => props.layer)
// metroLike: a D3 view created from an imported metro GeoJSON — same panels.
const isMetro = computed(() => layer.value?.type === 'metro' || layer.value?.metroLike === true)
const editable = computed(() => layer.value && !layer.value.isBasemap && !isMetro.value)

/* ---- Info: metro system metadata (from the loaded GeoJSON) ---- */
const meta = computed(() => layerData[layer.value.id]?.metro_system ?? null)
const metroLines = computed(() => {
  const d = layerData[layer.value.id]
  if (!d) return []
  // line features are overlap-deduped SEGMENTS carrying `routes: [...]` —
  // the city's line list is the unique routes across all segments
  const byId = new Map()
  for (const f of d.features) {
    if (f.geometry.type === 'Point') continue
    for (const r of f.properties.routes ?? [f.properties]) {
      if (r.route_id && !byId.has(r.route_id)) byId.set(r.route_id, r)
    }
  }
  return [...byId.values()].sort((a, b) =>
    String(a.route_ref ?? a.route_name ?? '').localeCompare(
      String(b.route_ref ?? b.route_name ?? ''), undefined, { numeric: true },
    ),
  )
})
const wikidataUrl = computed(() =>
  meta.value?.wikidata ? `https://www.wikidata.org/wiki/${meta.value.wikidata}` : null,
)

/* ---- Info: network orientation rose (Boeing 2019) ---- */
// Length-weighted distribution of line bearings + orientation-order φ.
const orientation = computed(() => {
  const d = layerData[layer.value.id]
  if (!isMetro.value || !d) return null
  return computeOrientation(d)
})
// Suggested rotation to square the network up (rotate by −tilt): a clockwise tilt
// is cancelled by a counter-clockwise turn, and vice versa.
function rotationHint(o) {
  const t = o?.tilt ?? 0
  if (Math.abs(t) < 0.5) return '0°（已對齊正南北）'
  return `${Math.abs(t).toFixed(0)}° ${t > 0 ? '逆時針' : '順時針'}`
}

/* ---- Info: per-city audit verdict (metro_system.audit, from metro:audit) ---- */
const auditInfo = computed(() => meta.value?.audit ?? null)
const auditChecks = computed(() => auditInfo.value?.checks ?? [])

/* ---- Info: external links (wiki / official route map / urbanrail) ---- */
const mapsIndex = ref(null)
onMounted(() => {
  if (isMetro.value) loadMapsIndex().then((v) => { mapsIndex.value = v }).catch(() => {})
})
// '/data/metro/systems/asia/taiwan/asia-taiwan-taipei.geojson' → 'asia/taiwan/asia-taiwan-taipei'
const systemKey = computed(() => layer.value.file?.match(/systems\/(.+)\.geojson$/)?.[1] ?? null)
const mapEntry = computed(() => (systemKey.value && mapsIndex.value?.[systemKey.value]) || null)

// The zh-Wikipedia search term for this system. Default "{城市}地鐵" lands
// directly on the system article (台北地鐵 → 臺北捷運, 紐約地鐵 → 紐約地鐵), but
// a few systems in the catalog aren't subways — e.g. Sydney is the Sydney Trains
// / CityRail suburban network, so "雪梨地鐵" is wrong; "雪梨城市鐵路" → 悉尼火車.
const WIKI_TERM = {
  'oc-aus-sydney': '雪梨城市鐵路',
}
const wikiTerm = computed(() =>
  WIKI_TERM[layer.value?.id] ?? `${layer.value?.cityZh ?? layer.value?.city}地鐵`)
// Wikipedia article of this metro SYSTEM. Neither the metadata's `wikidata` nor
// `official_map` can be trusted — both often point to a single LINE (checked:
// NYC's Q126093 = 紐約地鐵1號線, London's Q207699 = 滑鐵盧及城市線). Instead we
// hit zh.wikipedia's Go-or-search with the term above, landing on the system.
const wikipediaUrl = computed(() =>
  layer.value ? `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(wikiTerm.value)}` : null)
// Official schematic route map. Only 91/232 systems have a downloaded image;
// the rest fall back to a Google image search for the city's route map, so
// every city gets a working 官方路線圖 link.
const routeMapUrl = computed(() => {
  if (mapEntry.value?.map_file) return assetUrl(`data/metro/${mapEntry.value.map_file}`)
  return layer.value
    ? `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(`${wikiTerm.value}路線圖`)}`
    : null
})
// Whether the route-map link is a real local image vs. a Google search.
const routeMapIsImage = computed(() => !!mapEntry.value?.map_file)
// urbanrail.net：城市頁 URL 不規則（城市碼縮寫沒有算法規律，台北 tw/taip/taipei.htm、
// 新加坡 sing/singapore.htm、蒙特雷 mony/monterrey.htm），故用實查的城市→URL 映射
// （key = index.json 的 city）。映射是把 urbanrail 五大洲索引頁（as/asia.htm 等）的
// 圖像地圖 area + 文字錨點全部解析出來、再和本專案 224 城比對而成（scripts 見
// scratchpad/match.mjs），223 城全部命中並 curl 驗證 HTTP 200。少數郊區城市指向其
// 所屬系統的母頁（Xirivella→西班牙 Valencia、Noida/Gurgaon→Delhi、Gimpo→Seoul、
// Ratingen→Düsseldorf）。唯一沒有 urbanrail 專頁的 Bezirk Landeck（奧地利）fallback
// 到洲索引頁。URL = 洲碼前綴 + 洲索引頁裡的相對 href（href 相對於洲目錄）。
const URBANRAIL_CITIES = {
  "Adana": "as/tr/adana/adana.htm",
  "Agra": "as/in/agra/agra.htm",
  "Ahmedabad": "as/in/ahmedabad/ahmedabad.htm",
  "Algiers": "af/alg/algiers.htm",
  "Almaty": "as/kz/almaty/almaty.htm",
  "Amsterdam": "eu/nl/ams/amsterdam.htm",
  "Ankara": "as/tr/ankara/ankara.htm",
  "Astana": "as/kz/astana/astana.htm",
  "Athens": "eu/gr/athens/athens.htm",
  "Atlanta": "am/atla/atlanta.htm",
  "Baku": "as/baku/baku.htm",
  "Baltimore": "am/balt/baltimore.htm",
  "Bangkok": "as/bang/bangkok.htm",
  "Barcelona": "eu/es/bcn/barcelona.htm",
  "Beijing": "as/cn/beij/beijing.htm",
  "Belo Horizonte": "am/belo/belo-horizonte.htm",
  "Bengaluru": "as/in/banl/bangalore.htm",
  "Berlin": "eu/de/b/berlin.htm",
  "Bhopal": "as/in/bhopal/bhopal.htm",
  "Bielefeld": "eu/de/bi/bielefeld.htm",
  "Bilbao": "eu/es/bilbao/bilbao.htm",
  "Bochum": "eu/de/bo/bochum.htm",
  "Boston": "am/bost/boston.htm",
  "Brasília": "am/bras/brasilia.htm",
  "Brescia": "eu/it/bre/brescia.htm",
  "Brussels": "eu/be/brux/brussels.htm",
  "Bucharest": "eu/ro/buc/bucurest.htm",
  "Budapest": "eu/hu/budapest/budapest.htm",
  "Buenos Aires": "am/buen/buenos-aires.htm",
  "Bursa": "as/tr/bursa/bursa.htm",
  "Busan": "as/kr/busan/busan.htm",
  "Cairo": "af/cairo/cairo.htm",
  "Caracas": "am/cara/caracas.htm",
  "Catania": "eu/it/cat/catania.htm",
  "Changchun": "as/cn/chan/changchun.htm",
  "Changsha": "as/cn/changsha/changsha.htm",
  "Changzhou": "as/cn/changzhou/changzhou.htm",
  "Chengdu": "as/cn/chdu/chengdu.htm",
  "Chennai": "as/in/chen/chennai.htm",
  "Chiba Prefecture": "as/jp/chiba/chiba.htm",
  "Chicago": "am/chic/chicago.htm",
  "Chongqing": "as/cn/chon/chongqing.htm",
  "Chuzhou": "as/cn/nanj/nanjing.htm",
  "Cleveland": "am/clev/cleveland.htm",
  "Copenhagen": "eu/dk/kobenhavn/kobenhavn.htm",
  "Daegu": "as/kr/daegu/daegu.htm",
  "Daejeon": "as/kr/daejeon/daejeon.htm",
  "Dalian": "as/cn/dalian/dalian.htm",
  "Delhi": "as/in/delhi/delhi.htm",
  "Derince": "as/tr/izmit/izmit.htm",
  "Dhaka": "as/dhaka/dhaka.htm",
  "Dnipro": "eu/ua/dnipro/dnipro.htm",
  "Doha": "as/doha/doha.htm",
  "Dongguan": "as/cn/dongguan/dongguan.htm",
  "Dubai": "as/dub/dubai.htm",
  "Dusseldorf": "eu/de/d/duesseldorf.htm",
  "Essen": "eu/de/e/essen.htm",
  "Fortaleza": "am/fort/fortaleza.htm",
  "Foshan": "as/cn/guan/foshan.htm",
  "Frankfurt": "eu/de/f/frankfurt.htm",
  "Fukuoka": "as/jp/fukuoka/fukuoka.htm",
  "Fuzhou": "as/cn/fuzhou/fuzhou.htm",
  "Genoa": "eu/it/gen/genova.htm",
  "Gimpo": "as/kr/seoul/seoul.htm",
  "Glasgow": "eu/uk/gla/glasgow.htm",
  "Guadalajara": "am/guad/guadalajara.htm",
  "Guangzhou": "as/cn/guan/guangzhou.htm",
  "Guiyang": "as/cn/guiyang/guiyang.htm",
  "Gurgaon": "as/in/delhi/delhi.htm",
  "Gwangju": "as/kr/gwangju/gwangju.htm",
  "Hamburg": "eu/de/hh/hamburg.htm",
  "Hangzhou": "as/cn/hang/hangzhou.htm",
  "Hanoi": "as/hanoi/hanoi.htm",
  "Harbin": "as/cn/harbin/harbin.htm",
  "Hefei": "as/cn/hefei/hefei.htm",
  "Helsinki": "eu/fi/helsinki//helsinki.htm",
  "Hiroshima": "as/jp/hiroshima/hiroshima.htm",
  "Ho Chi Minh City": "as/hcmc/ho-chi-minh-city.htm",
  "Hohhot": "as/cn/hohhot/hohhot.htm",
  "Hong Kong": "as/cn/hong/hong-kong.htm",
  "Honolulu": "am/hono/honolulu.htm",
  "Hyderabad": "as/in/hydr/hyderabad.htm",
  "Incheon": "as/kr/incheon/incheon.htm",
  "Indore": "as/in/indore/indore.htm",
  "Isfahan": "as/ir/isfa/isfahan.htm",
  "Istanbul": "as/tr/istanbul/istanbul.htm",
  "İzmir": "as/tr/izmir/izmir.htm",
  "Jaipur": "as/in/jaip/jaipur.htm",
  "Jakarta": "as/id/jaka/jakarta.htm",
  "Jinan": "as/cn/jinan/jinan.htm",
  "Jinhua": "as/cn/jinhua/jinhua.htm",
  "Kanpur": "as/in/kanpur/kanpur.htm",
  "Kaohsiung": "as/tw/kaoh/kaohsiung.htm",
  "Karaj": "as/ir/karaj/karaj.htm",
  "Kazan": "eu/ru/kaz/kazan.htm",
  "Kharkiv": "eu/ua/kha/kharkiv.htm",
  "Kobe": "as/jp/kobe/kobe.htm",
  "Kochi": "as/in/kochi/kochi.htm",
  "Kolkata": "as/in/kolk/kolkata.htm",
  "Kuala Lumpur": "as/my/kual/kuala-lumpur.htm",
  "Kunming": "as/cn/kunming/kunming.htm",
  "Kyiv": "eu/ua/kiev/kyiv.htm",
  "Kyoto": "as/jp/kyoto/kyoto.htm",
  "Lagos": "af/lagos/lagos.htm",
  "Lahore": "as/lahore/lahore.htm",
  "Lanzhou": "as/cn/lanzhou/lanzhou.htm",
  "Lausanne": "eu/ch/vd/lausanne.htm",
  "Lille": "eu/fr/lille/lille.htm",
  "Lima": "am/lima/lima.htm",
  "Lisbon": "eu/pt/lisboa/lisboa.htm",
  "London": "eu/uk/lon/london.htm",
  "Los Angeles": "am/lsan/los-angeles.htm",
  "Lucknow": "as/in/lucknow/lucknow.htm",
  "Luoyang": "as/cn/luoyang/luoyang.htm",
  "Lyon": "eu/fr/lyon/lyon.htm",
  "Macau": "as/cn/macau/macau.htm",
  "Madrid": "eu/es/mad/madrid.htm",
  "Manila": "as/manila/manila.htm",
  "Maracaibo": "am/mara/maracaibo.htm",
  "Marseille": "eu/fr/marseille/marseille.htm",
  "Mashhad": "as/ir/mash/mashhad.htm",
  "Mecca": "as/mecca/makkah.htm",
  "Medellín": "am/mede/medellin.htm",
  "Meerut": "as/in/delhi/meerut-metro.htm",
  "Mexico City": "am/mexi/mexico.htm",
  "Miami": "am/miam/miami.htm",
  "Milan": "eu/it/mil/milano.htm",
  "Minsk": "eu/by/minsk/minsk.htm",
  "Monterrey": "am/mony/monterrey.htm",
  "Montreal": "am/monr/montreal.htm",
  "Moscow": "eu/ru/mos/moskva.htm",
  "Mumbai": "as/in/mumb/mumbai.htm",
  "Munich": "eu/de/m/muenchen.htm",
  "Nagoya": "as/jp/nagoya/nagoya.htm",
  "Nagpur": "as/in/nagpur/nagpur.htm",
  "Nanchang": "as/cn/nanchang/nanchang.htm",
  "Nanjing": "as/cn/nanj/nanjing.htm",
  "Nanning": "as/cn/nanning/nanning.htm",
  "Nantong": "as/cn/nantong/nantong.htm",
  "Naples": "eu/it/nap/napoli.htm",
  "Navi Mumbai": "as/in/mumb/navi-mumbai.htm",
  "New York City": "am/nyrk/new-york.htm",
  "Ningbo": "as/cn/ningbo/ningbo.htm",
  "Nizhny Novgorod": "eu/ru/niz/nizhniy-novgorod.htm",
  "Noida": "as/in/delhi/delhi.htm",
  "Novosibirsk": "eu/ru/novosib/novosibirsk-tram.htm",
  "Nuremberg": "eu/de/n/nuernberg.htm",
  "Osaka": "as/jp/osaka/osaka.htm",
  "Oslo": "eu/no/oslo/oslo.htm",
  "Palembang": "as/id/palem/palembang.htm",
  "Panama City": "am/pana/panama.htm",
  "Paris": "eu/fr/paris/paris.htm",
  "Patna": "as/in/patna/patna.htm",
  "Philadelphia": "am/phil/philadelphia.htm",
  "Porto Alegre": "am/ptal/porto-alegre.htm",
  "Prague": "eu/cz/praha/praha.htm",
  "Pune": "as/in/pune/pune.htm",
  "Pyongyang": "as/kr/pyongyang/pyongyang.htm",
  "Qingdao": "as/cn/qing/qingdao.htm",
  "Quito": "am/quito/quito.htm",
  "Ratingen": "eu/de/d/duesseldorf.htm",
  "Recife": "am/reci/recife.htm",
  "Rennes": "eu/fr/rennes/rennes.htm",
  "Rio de Janeiro": "am/rioj/rio-de-janeiro.htm",
  "Riyadh": "as/riyadh/riyadh.htm",
  "Rome": "eu/it/rom/roma.htm",
  "Rotterdam": "eu/nl/rot/rotterdam.htm",
  "Saint Petersburg": "eu/ru/pet/petersburg.htm",
  "Saitama Prefecture": "as/jp/tokyo/tokyo.htm",
  "Salvador": "am/salv/salvador.htm",
  "Samara": "eu/ru/sam/samara.htm",
  "San Francisco (Bay Area)": "am/snfr/sf-bay-area-map.htm",
  "San Juan": "am/snju/san-juan.htm",
  "Santiago": "am/sant/santiago.htm",
  "Santo Domingo": "am/sdom/santo-domingo.htm",
  "São Paulo": "am/spau/sao-paulo.htm",
  "Sapporo": "as/jp/sapporo/sapporo.htm",
  "Sendai": "as/jp/sendai/sendai.htm",
  "Seoul": "as/kr/seoul/seoul.htm",
  "Seville": "eu/es/sevilla/sevilla.htm",
  "Shanghai": "as/cn/shan/shanghai.htm",
  "Shaoxing": "as/cn/shaoxing/shaoxing.htm",
  "Shenyang": "as/cn/shny/shenyang.htm",
  "Shenzhen": "as/cn/shen/shenzhen.htm",
  "Shijiazhuang": "as/cn/shijiazhuang/shijiazhuang.htm",
  "Shiraz": "as/ir/shir/shiraz.htm",
  "Singapore": "as/sing/singapore.htm",
  "Sofia": "eu/bg/sofia/sofia.htm",
  "Stockholm": "eu/se/stockholm/stockhlm.htm",
  "Suzhou": "as/cn/suzh/suzhou.htm",
  "Sydney": "au/sydney/sydney.htm",
  "Tabriz": "as/ir/tabr/tabriz.htm",
  "Taichung": "as/tw/taichung/taichung.htm",
  "Taipei": "as/tw/taip/taipei.htm",
  "Taiyuan": "as/cn/taiyuan/taiyuan.htm",
  "Taizhou": "as/cn/taizhou/taizhou.htm",
  "Tashkent": "as/uz/toshkent/toshkent.htm",
  "Tbilisi": "as/tbil/tbilisi.htm",
  "Tehran": "as/ir/tehr/tehran.htm",
  "Thessaloniki": "eu/gr/thessaloniki/thessaloniki.htm",
  "Tianjin": "as/cn/tian/tianjin.htm",
  "Tokyo": "as/jp/tokyo/tokyo.htm",
  "Toronto": "am/toro/toronto.htm",
  "Toulouse": "eu/fr/toulouse/toulouse.htm",
  "Turin": "eu/it/tor/torino.htm",
  "Ürümqi": "as/cn/urumqi/urumqi.htm",
  "Valencia": "am/vale/valencia.htm",
  "Vancouver": "am/vanc/vancouver.htm",
  "Vienna": "eu/at/vienna/wien.htm",
  "Warsaw": "eu/pl/war/warszawa.htm",
  "Washington, D.C.": "am/wash/washington.htm",
  "Wenzhou": "as/cn/wenzhou/wenzhou.htm",
  "Wuhan": "as/cn/wuhan/wuhan.htm",
  "Wuhu": "as/cn/wuhu/wuhu.htm",
  "Wuxi": "as/cn/wuxi/wuxi.htm",
  "Xi'an": "as/cn/xian/xian.htm",
  "Xiamen": "as/cn/xiamen/xiamen.htm",
  "Xirivella": "eu/es/val/valencia.htm",
  "Xuzhou": "as/cn/xuzhou/xuzhou.htm",
  "Yekaterinburg": "eu/ru/yekatarin/yekaterinburg-tram.htm",
  "Yerevan": "as/yere/yerevan.htm",
  "Yokohama": "as/jp/yokohama/yokohama.htm",
  "Zhengzhou": "as/cn/zheng/zhengzhou.htm",
}
const URBANRAIL_CONTINENTS = {
  asia: 'as/asia.htm',
  europe: 'eu/euromet.htm',
  'north-america': 'am/america.htm',
  'south-america': 'am/america.htm',
  africa: 'af/africa.htm',
  oceania: 'au/oceania.htm',
}
const urbanrailUrl = computed(() => {
  const city = URBANRAIL_CITIES[layer.value.city]
  if (city) return `https://www.urbanrail.net/${city}`
  const path = URBANRAIL_CONTINENTS[layer.value.continent]
  return path ? `https://www.urbanrail.net/${path}` : 'https://www.urbanrail.net/'
})
// 有城市頁映射 → 顯示城市名；否則顯示洲（連到洲索引頁）
const urbanrailLabel = computed(() =>
  URBANRAIL_CITIES[layer.value.city] ? layer.value.city : prettyContinent(layer.value.continent))

/* ---- resize ---- */
const dragging = ref(false)
function startResize(e) {
  dragging.value = true
  const startX = e.clientX
  const startW = width.value
  // 拖到極限但**不越過左邊面板**：上限＝容器寬 − 左側視圖導覽條寬 − 畫布一小條。
  const host = e.currentTarget?.parentElement
  const leftNav = host?.querySelector('.view-nav')
  const move = (ev) => {
    const navW = leftNav ? leftNav.offsetWidth : 0
    const maxW = host ? Math.max(120, host.clientWidth - navW - 60) : 2000
    width.value = Math.min(maxW, Math.max(60, startW - (ev.clientX - startX)))
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <!-- Collapsed rail -->
  <aside v-if="!open" class="rail" aria-label="Panel (collapsed)">
    <button class="btn-icon" title="Expand panel" @click="open = true">
      <MIcon name="right_panel_open" :size="15" />
    </button>
    <MIcon name="tune" :size="14" class="rail-icon" />
    <span class="rail-label">資訊 / 樣式</span>
  </aside>

  <template v-else>
    <div
      class="resize-x"
      :class="{ dragging }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startResize"
    />

    <aside class="style-panel" aria-label="Layer panel" :style="{ width: width + 'px' }">
      <div class="panel-header tabs-header">
        <div class="panel-tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.id"
            class="panel-tab"
            :class="{ active: activeTab === t.id }"
            role="tab"
            :aria-selected="activeTab === t.id"
            @click="activeTab = t.id"
          >
            {{ t.label }}
          </button>
        </div>
        <button class="btn-icon" title="Collapse panel" @click="open = false">
          <MIcon name="right_panel_close" :size="14" />
        </button>
      </div>

      <div class="style-body">
        <div class="layer-heading">
          <span class="layer-name">{{ layer.name }}</span>
        </div>

        <!-- ============ Info ============ -->
        <template v-if="activeTab === 'info'">
          <template v-if="isMetro">
            <div class="info-rows">
              <div class="info-row"><span class="info-key">城市</span><span>{{ layer.cityZh ?? layer.city }}</span></div>
              <div class="info-row"><span class="info-key">國家</span><span>{{ layer.countryZh ?? layer.country }}</span></div>
              <div class="info-row">
                <span class="info-key">洲別</span><span>{{ continentZh(layer.continent) }}</span>
              </div>
              <div class="info-row"><span class="info-key">路線數</span><span>{{ layer.lineCount }}</span></div>
              <div class="info-row"><span class="info-key">車站數</span><span>{{ layer.stationCount }}</span></div>
              <div v-if="meta?.operator" class="info-row">
                <span class="info-key">營運單位</span><span>{{ meta.operator }}</span>
              </div>
              <div v-if="meta?.official_website" class="info-row">
                <span class="info-key">官網</span>
                <a :href="meta.official_website" target="_blank" rel="noopener" class="info-link">
                  {{ meta.official_website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }}
                  <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="wikidataUrl" class="info-row">
                <span class="info-key">Wikidata</span>
                <a :href="wikidataUrl" target="_blank" rel="noopener" class="info-link">
                  {{ meta.wikidata }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="wikipediaUrl" class="info-row">
                <span class="info-key">Wikipedia</span>
                <a :href="wikipediaUrl" target="_blank" rel="noopener" class="info-link">
                  {{ wikiTerm }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div class="info-row">
                <span class="info-key">urbanrail</span>
                <a :href="urbanrailUrl" target="_blank" rel="noopener" class="info-link">
                  UrbanRail.Net：{{ urbanrailLabel }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="routeMapUrl" class="info-row">
                <span class="info-key">官方路線圖</span>
                <a :href="routeMapUrl" target="_blank" rel="noopener" class="info-link">
                  {{ routeMapIsImage ? '開啟圖片' : 'Google 圖片搜尋' }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="meta?.osm_networks?.length" class="info-row">
                <span class="info-key">路網</span>
                <span>{{ meta.osm_networks.join(', ') }}</span>
              </div>
            </div>

            <template v-if="showOrientation">
            <div class="section-title">方位</div>
            <div v-if="!orientation || !orientation.segments" class="info-empty">
              載入中…
            </div>
            <template v-else>
              <OrientationRose
                :bins="orientation.bins"
                :size="220"
                :tilt="orientation.tilt"
                :strength="orientation.strength"
              />
              <div class="info-rows rose-stats">
                <div class="info-row">
                  <span class="info-key">φ 秩序度</span><span>{{ orientation.phi.toFixed(3) }}</span>
                </div>
                <div class="info-row">
                  <span class="info-key">路線總長</span>
                  <span>{{ orientation.totalKm.toFixed(1) }} km</span>
                </div>
                <div class="info-row">
                  <span class="info-key">建議旋轉</span>
                  <span>{{ rotationHint(orientation) }}</span>
                </div>
              </div>
              <div class="rose-note">
                <strong>玫瑰圖的算法</strong>：把每條線段的羅盤方位角（0°=北、順時針）連同反向
                （+180°），依<strong>線段長度</strong>加權，分進 36 個 10° 方向格；每根 wedge 的半徑
                ∝ 該方向的長度佔比（面積等比、雙向對稱）。共用主幹只算一條、不乘路線數。
                <br />
                <strong>φ 秩序度</strong>（Boeing 2019 方向熵）：φ = 0 方向均勻（無序），
                φ = 1 完美方格網——越高代表越接近單一方格、旋轉建議越可靠。
                <br />
                <strong>建議旋轉的算法</strong>：<strong>只取玫瑰圖<span class="rose-red">紅色（最長）</span>那格內的線</strong>，
                以各自長度為權重、平均它們的角度（精確值，非取格子中心），再轉到<strong>最近</strong>的水平／垂直
                （摺 90°，轉幅 ≤ 45°，即最小旋轉）。其他方向不參與。此角度不改地圖。
              </div>
            </template>
            </template>

            <!-- Skeleton computation rules — Map Adjust view only -->
            <template v-if="isMapAdjust">
              <div class="section-title">骨架化規則</div>
              <div class="skeleton-rules">
                <p>不拉直、保留地理形狀，只做拓撲收縮與標記（connect 骨架）。</p>
                <p class="sk-sub">節點（依圖 degree）</p>
                <ul>
                  <li><span class="sk-dot" style="background:#e11d48" /> 紅：分歧／轉乘（degree≥3，或兩側路線不同的 degree-2）</li>
                  <li><span class="sk-dot" style="background:#2563eb" /> 藍：真端點（degree≤1）</li>
                  <li><span class="sk-dot sk-ring" /> 白：直通中段站（degree=2、兩側同路線；不變）</li>
                  <li><span class="sk-dot" style="background:#a855f7" /> 紫：頭尾共點／環線切斷點</li>
                  <li><span class="sk-dot" style="background:#ec4899" /> 粉紅：代表性轉折點（邊曲折度&gt;1.25 才挑，DP 垂距/弦長&gt;0.25 的黑點）</li>
                  <li><span class="sk-dot" style="background:#9ca3af" /> 灰：過長黑點段的分隔（每段 ≤4，G=⌊N/5⌋）</li>
                </ul>
                <p class="sk-sub">線畫法（照原本）</p>
                <ul>
                  <li><span class="sk-line sk-plain" /> 單線＝route 原色；重疊＝各 route 交錯彩色虛線</li>
                </ul>
                <p class="sk-sub">邊分類（線底下的 highlight 襯底）</p>
                <ul>
                  <li><span class="sk-line" style="background:#e11d48" /> 紅：共線合併（≥2 路線；不切紫點）</li>
                  <li><span class="sk-line" style="background:#16a34a" /> 綠：環線（自環；1/3、2/3 切 2 紫）</li>
                  <li><span class="sk-line" style="background:#2563eb" /> 藍：頭尾共點（平行多重邊；1/2 切 1 紫）</li>
                  <li><span class="sk-line" style="background:#7c3aed" /> 紫：<b>非分類</b>——紅、藍襯底半透明重疊處的疊色（同走廊既是共線又有平行邊）</li>
                </ul>
                <p class="rose-note">
                  依 skill <code>route-skeleton-connect</code>。座標一律照原地理、不移動；
                  黃色幾何交叉為 v2（metro 交叉多為轉乘站，罕見）。
                </p>
              </div>
            </template>

            <template v-if="!isD3">
            <div class="section-title">資料驗證</div>
            <div v-if="!auditInfo" class="info-empty">
              尚未執行資料驗證（npm run metro:audit）
            </div>
            <template v-else>
              <div class="audit-banner" :class="auditInfo.passed ? 'pass' : 'fail'">
                <MIcon name="check_circle" v-if="auditInfo.passed" :size="14" />
                <MIcon name="cancel" v-else :size="14" />
                <span>{{ auditInfo.passed ? '資料驗證通過' : '資料驗證未通過' }}</span>
                <span v-if="auditInfo.audited_at" class="audit-date">
                  {{ auditInfo.audited_at.slice(0, 10) }}
                </span>
              </div>

              <div v-if="!auditInfo.passed && auditInfo.reasons?.length" class="audit-list fail">
                <div v-for="(r, i) in auditInfo.reasons" :key="i" class="audit-item">
                  <MIcon name="cancel" :size="12" class="audit-ic" /> {{ r }}
                </div>
              </div>
              <div v-if="auditInfo.covered_by" class="audit-list">
                <div class="audit-item">
                  <MIcon name="warning" :size="12" class="audit-ic warn" />
                  由 {{ auditInfo.covered_by }} 系統檔涵蓋（同都會區）
                </div>
              </div>
              <div v-if="auditInfo.warnings?.length" class="audit-list warn">
                <div v-for="(w, i) in auditInfo.warnings" :key="i" class="audit-item">
                  <MIcon name="warning" :size="12" class="audit-ic warn" /> {{ w }}
                </div>
              </div>
              <div v-if="auditChecks.length" class="audit-list">
                <div v-for="c in auditChecks.filter((c) => c.ok)" :key="c.id" class="audit-item ok">
                  <MIcon name="check_circle" :size="12" class="audit-ic ok" /> {{ c.detail }}
                </div>
              </div>
            </template>
            </template>

            <!-- 路線 list: only on the Metro Maps (MapLibre) view -->
            <template v-if="!isD3">
              <div class="section-title">路線</div>
              <div v-if="!metroLines.length" class="info-empty">載入中…</div>
              <div v-else class="line-list">
                <div v-for="ln in metroLines" :key="ln.route_id" class="line-row">
                  <span class="line-swatch" :style="{ background: ln.route_color ?? '#e11d48' }" />
                  <span v-if="ln.route_ref" class="line-ref">{{ ln.route_ref }}</span>
                  <span class="line-name">
                    {{ ln.route_name ?? ln.route_name_local ?? '—' }}
                  </span>
                  <span v-if="ln.status === 'under_construction'" class="line-uc">建設中</span>
                </div>
              </div>
            </template>
          </template>
          <div v-else class="info-empty">此圖層沒有 metro 資訊。</div>
        </template>

        <!-- ============ Style ============ -->
        <template v-else-if="activeTab === 'style'">
          <template v-if="isMetro">
            <div class="field">
              <label class="field-label">Line width — {{ layer.strokeWidth }} px</label>
              <input v-model.number="layer.strokeWidth" type="range" min="0.5" max="8" step="0.5" class="slider" />
            </div>

            <div class="field">
              <label class="field-label">Station radius — {{ layer.radius }} px</label>
              <input v-model.number="layer.radius" type="range" min="1" max="10" step="0.5" class="slider" />
            </div>

            <label class="field check-field">
              <input type="checkbox" :checked="layer.showLabels" @change="layer.showLabels = $event.target.checked" />
              <span>顯示站名（在站點上方）</span>
            </label>
          </template>

          <template v-if="editable">
            <div class="field">
              <label class="field-label">Symbology</label>
              <select v-model="layer.symbology" class="select">
                <option value="single">Single symbol</option>
                <option value="categorized">Categorized</option>
                <option value="graduated">Graduated</option>
                <option value="rule-based">Rule-based</option>
                <option value="expression">Expression</option>
              </select>
            </div>

            <div class="field-row">
              <div class="field">
                <label class="field-label">{{ layer.type === 'line' ? 'Line color' : 'Fill color' }}</label>
                <input v-model="layer.color" type="color" class="color-input" />
              </div>
              <div v-if="layer.type !== 'line'" class="field">
                <label class="field-label">Stroke color</label>
                <input v-model="layer.strokeColor" type="color" class="color-input" />
              </div>
            </div>

            <div class="field">
              <label class="field-label">
                {{ layer.type === 'line' ? 'Line width' : 'Stroke width' }} — {{ layer.strokeWidth }} px
              </label>
              <input v-model.number="layer.strokeWidth" type="range" min="0" max="10" step="0.5" class="slider" />
            </div>

            <div v-if="layer.type === 'point'" class="field">
              <label class="field-label">Circle radius — {{ layer.radius }} px</label>
              <input v-model.number="layer.radius" type="range" min="1" max="20" step="1" class="slider" />
            </div>
          </template>

          <div class="field">
            <label class="field-label">Opacity — {{ Math.round(layer.opacity * 100) }}%</label>
            <input v-model.number="layer.opacity" type="range" min="0" max="1" step="0.05" class="slider" />
          </div>
        </template>

        <template v-else-if="activeTab === 'object'">
          <div v-if="!selectedEntries.length" class="obj-empty">
            點地圖上的物件以檢視其屬性
          </div>
          <!-- 路段：站序中同時列停靠與通過(不停)站，pass 站標記、灰字並排在正確位置 -->
          <template v-for="rt in selectedRouteLists" :key="rt.route_id">
            <div class="obj-route-head">
              <span class="line-swatch" :style="{ background: rt.color }" />
              <span v-if="rt.ref" class="line-ref">{{ rt.ref }}</span>
              <span class="obj-route-name">{{ rt.name }}</span>
              <span class="obj-route-count">停靠 {{ rt.uniqueCount }} 站</span>
            </div>
            <ol class="obj-station-list">
              <li v-for="(st, i) in rt.stations" :key="`${st.station_id}-${i}`" :class="{ 'st-pass': st.pass }">
                {{ st.station_name }}<span v-if="st.pass" class="obj-pass-tag">pass</span>
              </li>
            </ol>
          </template>
          <!-- 車站：停靠此站的路線 + 行經(不停靠)的路線 -->
          <div v-if="stopRoutes.length || passRoutes.length" class="obj-pass">
            <div v-if="stopRoutes.length" class="obj-pass-sub">停靠路線</div>
            <div v-for="r in stopRoutes" :key="`s-${r.route_name}`" class="obj-pass-row">
              <span class="line-swatch" :style="{ background: r.route_color ?? '#e11d48' }" />
              <span v-if="r.route_ref" class="line-ref">{{ r.route_ref }}</span>
              <span class="obj-route-name">{{ r.route_name ?? '—' }}</span>
            </div>
            <div v-if="passRoutes.length" class="obj-pass-sub">行經（不停靠）</div>
            <div v-for="r in passRoutes" :key="`p-${r.route_name}`" class="obj-pass-row">
              <span class="line-swatch" :style="{ background: r.route_color ?? '#e11d48' }" />
              <span v-if="r.route_ref" class="line-ref">{{ r.route_ref }}</span>
              <span class="obj-route-name">{{ r.route_name ?? '—' }}</span>
              <span class="obj-pass-tag">pass</span>
            </div>
          </div>
          <table v-if="selectedEntries.length" class="obj-table">
            <tbody>
              <tr v-for="row in selectedEntries" :key="row.key">
                <th class="obj-key">{{ row.key }}</th>
                <td class="obj-val">
                  <template v-if="row.isList">
                    <span v-if="!row.items.length">—</span>
                    <div v-for="(it, i) in row.items" :key="i" class="obj-li">{{ it }}</div>
                  </template>
                  <a v-else-if="row.href" :href="row.href" target="_blank" rel="noopener" class="info-link">
                    {{ row.value }} <MIcon name="open_in_new" :size="11" />
                  </a>
                  <template v-else>{{ row.value }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ============ 權重（RWD Maps）: weight 驅動版面簡化（論文 §九）============ -->
        <template v-else-if="activeTab === 'weight'">
          <div class="weight-panel">
            <p class="weight-hint">
              版面簡化不改拓撲：用各欄／列**最忙路段的流量（weight）**決定該欄多寬、該列多高
              ——主走廊變寬、次要區壓窄，外框固定，路線在新像素座標重畫成 H/V/45°。
            </p>
            <label class="weight-hide-toggle" style="padding: 0 2px;">
              <input type="checkbox" :checked="showWeights" @change="emit('show-weights', $event.target.checked)" />
              顯示 weight 數字
            </label>
            <div class="weight-modes">
              <button class="weight-mode" :class="{ active: weightMode === 'uniform' }"
                @click="emit('weight-mode', 'uniform')">均勻網格</button>
              <button class="weight-mode" :class="{ active: weightMode === 'weight' }"
                @click="emit('weight-mode', 'weight')">顯示 weight 比例</button>
            </div>
            <button class="weight-random" @click="emit('weight-random')">全部隨機（1–9）</button>
            <button class="weight-random weight-auto" :class="{ active: weightAuto }"
              @click="emit('weight-auto')">
              {{ weightAuto ? '⏸ 停止自動重抽' : '▶ 每 5 秒自動重抽' }}
            </button>
            <p class="weight-hint">
              「全部隨機」每按一次整表重抽：每個沿路相鄰站對抽 1–9，反等比（機率 ∝ 1/2ᵏ）
              ——數字越小越常見，少數主走廊、多數次要邊。「每 5 秒自動重抽」開啟後每 5 秒
              整表重抽一次，network 點跟著新版面變形（自動切到 weight 模式）。
            </p>
            <div class="weight-hide-row">
              <label class="weight-hide-toggle">
                <input type="checkbox" :checked="hideStops" @change="emit('hide-stops', $event.target.checked)" />
                自動隱藏白點
              </label>
              <label class="weight-hide-px">
                最小站距
                <input type="number" min="1" step="1" :value="minStopPx"
                  @change="emit('min-stop-px', $event.target.value)" />
                pt
              </label>
            </div>
            <div v-if="stopStat" class="weight-stat">
              目前最小站距　高
              <b>{{ stopStat.high != null ? stopStat.high.toFixed(1) : '—' }}</b> pt　寬
              <b>{{ stopStat.wide != null ? stopStat.wide.toFixed(1) : '—' }}</b> pt
            </div>
            <div v-if="stopStat && stopStat.canvas" class="weight-stat">
              畫布 <b>{{ stopStat.canvas[0] }}</b> × <b>{{ stopStat.canvas[1] }}</b> px（resize 診斷）
            </div>
            <div v-if="hideStops && stopStat" class="weight-stat">
              已隱藏 <b>{{ stopStat.hidden }}</b> 站<template v-if="stopStat.hidden > 0 && stopStat.hiddenMaxT != null">
              　·　目前刪到 weight 差 ≤ <b>{{ stopStat.hiddenMaxT }}</b></template>
            </div>
            <div v-if="hideStops && stopStat && stopStat.hidden > 0" class="hidden-list">
              <div class="hidden-list-title">被隱藏的站</div>
              <ol class="hidden-list-items">
                <li v-for="(n, i) in stopStat.hiddenNames" :key="i">{{ n }}</li>
              </ol>
            </div>
            <p class="weight-hint">
              開啟後：由最擠的路段決定一個**全域 weight 差 cutoff T**（升高 T 直到最擠段
              均分後站距 ≥「最小站距」），然後**全圖**任何白點（直通站）只要左右兩段 weight
              差 ≤ T 就一律隱藏——所以「刪到 ≤ T」與畫面完全一致（寬鬆段的低差白點也一起
              消失、相鄰標籤合併取 max）。彩色錨點（紅／藍／黃）不會被藏。
            </p>
          </div>
        </template>

        <!-- ============ LLM調整（RWD Maps）: AI 改網格長寬（skill route-llm-grid）============ -->
        <template v-else-if="activeTab === 'grid'">
          <div class="weight-panel">
            <p class="weight-hint">
              用一句話改網格大小：模型推理**每個 X 欄／Y 列區間**在畫面上該佔多大（顯示權重，
              1=原尺寸、&gt;1 放大、&lt;1 壓縮），不搬任何站的格座標；系統把權重正規化進固定
              外框、在新像素座標重畫 H/V/45°。與「權重」tab 的流量比例是同一種變形、
              不同的權重來源。
            </p>
            <template v-if="gridCanRun">
              <textarea
                v-model="gridUserPrompt"
                class="llm-prompt-box"
                rows="3"
                :disabled="gridRunning"
                placeholder="例：把市中心那幾欄拉開；中間幾列拉高；東側壓縮一點、把空間讓給核心…"
              />
              <button
                class="llm-run-btn"
                :disabled="gridRunning || !gridUserPrompt.trim()"
                @click="emit('run-grid', gridUserPrompt.trim())"
              >{{ gridRunning ? '執行中…' : '開始 LLM 調整' }}</button>
              <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-grid skill 推理權重並存檔——放大會明顯（核心 3–5 倍）且由核心向外漸近。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>

            <template v-if="gridRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ gridRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">網格</span><span>{{ gridRecord.cols }} 欄 × {{ gridRecord.rows }} 列</span></div>
                <div class="info-row">
                  <span class="info-key">最大倍率</span>
                  <span>{{ Math.max(...gridRecord.colW, ...gridRecord.rowW).toFixed(1) }}</span>
                </div>
              </div>
              <p v-if="gridRecord.userPrompt" class="llm-run-hint">上次指示：{{ gridRecord.userPrompt }}</p>
              <h4 class="llm-h">模型的思路</h4>
              <div class="llm-note">{{ gridRecord.note ?? '（無說明）' }}</div>
              <h4 class="llm-h">欄權重（西 → 東）</h4>
              <pre class="llm-pre">{{ gridRecord.colW.map((w) => (+w).toFixed(1)).join(' ') }}</pre>
              <h4 class="llm-h">列權重（北 → 南）</h4>
              <pre class="llm-pre">{{ gridRecord.rowW.map((w) => (+w).toFixed(1)).join(' ') }}</pre>
              <template v-if="gridRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ gridRecord.finalOutput }}</pre>
              </template>
            </template>
            <p v-else class="llm-note">尚未產生結果——切到「LLM調整」視圖或直接在上面輸入一句話執行。</p>

            <h4 class="llm-h">使用的 skill：route-llm-grid</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="gridSkillHtml || '<p>載入中…</p>'" />
            </details>
          </div>
        </template>

        <!-- ============ LLM對齊: run provenance (prompt / responses / model) ============ -->
        <template v-else-if="activeTab === 'llm' && llmRecord">
          <div class="info-rows">
            <div class="info-row"><span class="info-key">模型</span><span>{{ llmRecord.model ?? '—' }}</span></div>
            <div class="info-row"><span class="info-key">輪數</span><span>{{ llmRecord.rounds }}</span></div>
            <div class="info-row">
              <span class="info-key">水平垂直</span>
              <span>{{ llmRecord.hvBefore }} → {{ llmRecord.hvAfter }}／{{ llmRecord.segs }} 段</span>
            </div>
            <div class="info-row"><span class="info-key">移動</span><span>{{ llmRecord.moved }} 站</span></div>
          </div>

          <h4 class="llm-h">輸入的 skill / prompt</h4>
          <pre class="llm-pre">{{ llmRecord.prompt ?? '（此結果產生於紀錄功能之前，無 prompt 紀錄——重跑一次即可補上）' }}</pre>

          <h4 class="llm-h">使用的 skill：route-llm-align</h4>
          <details class="llm-skill">
            <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
            <div class="skill-md llm-skill-md" v-html="llmSkillHtml || '<p>載入中…</p>'" />
          </details>

          <h4 class="llm-h">LLM 回傳（逐輪）</h4>
          <div v-for="(t, i) in llmRecord.transcript ?? []" :key="i" class="llm-round">
            <div class="llm-round-head">
              {{ t.round ? `第 ${t.round} 輪` : '附註' }} · 提案 {{ t.proposed }} 點
              · HV {{ t.hv }}<template v-if="t.rejected"> · 硬規則拒絕 {{ t.rejected }}</template>
            </div>
            <div class="llm-note">{{ t.note ?? '（無說明）' }}</div>
          </div>
          <div v-if="!(llmRecord.transcript ?? []).length" class="llm-note">
            （無逐輪紀錄——重跑一次即可補上）
          </div>

          <template v-if="llmRecord.finalOutput">
            <h4 class="llm-h">最終輸出</h4>
            <pre class="llm-pre">{{ llmRecord.finalOutput }}</pre>
          </template>

          <button
            v-if="llmCanRun"
            class="llm-run-btn"
            :disabled="llmRunning"
            @click="emit('run-llm', '')"
          >{{ llmRunning ? '執行中…' : '重新開始 LLM 對齊' }}</button>
          <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-align skill 重跑並更新此結果。</p>

          <!-- 自訂 prompt：使用者的指示會併入 route-llm-align，引導模型移動哪些座標 -->
          <template v-if="llmCanRun">
            <h4 class="llm-h">用 prompt 調整座標</h4>
            <p v-if="llmRecord.userPrompt" class="llm-run-hint">上次指示：{{ llmRecord.userPrompt }}</p>
            <textarea
              v-model="llmUserPrompt"
              class="llm-prompt-box"
              rows="3"
              :disabled="llmRunning"
              placeholder="例：優先把紅線拉成水平；讓東側幾條線對齊同一欄；把環狀線盡量收成矩形…"
            />
            <button
              class="llm-run-btn"
              :disabled="llmRunning || !llmUserPrompt.trim()"
              @click="emit('run-llm', llmUserPrompt.trim())"
            >{{ llmRunning ? '執行中…' : '確定，依此 prompt 重跑' }}</button>
            <p class="llm-run-hint">你的指示會併入 skill、引導模型「移動哪些點、往哪對齊」——一樣經硬規則把關，不會弄壞佈局。</p>
          </template>
        </template>
      </div>
    </aside>
  </template>
</template>

<style scoped>
.style-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-height: 0;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail {
  width: 44px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail-icon { color: hsl(var(--muted-foreground)); }
.rail-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
}

/* header tabs */
.tabs-header { padding: 4px 8px 0 8px; align-items: flex-end; }
.panel-tabs { display: flex; gap: 2px; }
.panel-tab {
  padding: 7px 12px 8px;
  font-size: 12.5px;
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent;
  border-radius: calc(var(--radius) - 4px) calc(var(--radius) - 4px) 0 0;
}
.panel-tab:hover { background: hsl(var(--accent) / 0.6); color: hsl(var(--foreground)); }
.panel-tab.active {
  color: hsl(var(--primary));
  font-weight: 600;
  border-bottom-color: hsl(var(--primary));
}

.style-body { flex: 1; overflow-y: auto; padding: 12px; }

/* Object tab: all properties of the clicked feature */
.obj-empty { color: hsl(var(--muted-foreground)); font-size: 12px; padding: 8px 2px; }
.obj-route-head {
  display: flex; align-items: center; gap: 6px;
  margin: 10px 0 4px; font-size: 12.5px; font-weight: 600; min-width: 0;
}
.obj-route-head:first-of-type { margin-top: 0; }
.obj-route-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-route-count {
  margin-left: auto; flex-shrink: 0;
  font-weight: 400; font-size: 11px; color: hsl(var(--muted-foreground));
}
/* 站序中的通過(不停)站：灰字 + pass 標記 */
.obj-station-list .st-pass { color: hsl(var(--muted-foreground)); }
.obj-pass-sub { margin: 8px 0 2px; font-size: 11.5px; font-weight: 600; color: hsl(var(--muted-foreground)); }
/* 行經（不停靠）路線 */
.obj-pass { margin: 6px 0 10px; }
.obj-pass-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; padding: 2px 0; min-width: 0;
}
.obj-pass-tag {
  margin-left: auto; flex-shrink: 0;
  font-size: 10.5px; font-weight: 600; color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border)); border-radius: 999px; padding: 0 7px;
}
.obj-station-list {
  margin: 0 0 10px; padding-left: 26px; font-size: 12px; line-height: 1.7;
  color: hsl(var(--foreground));
}
.obj-station-list li::marker { color: hsl(var(--muted-foreground)); font-size: 10.5px; }
/* LLM對齊 tab: run provenance */
.llm-h {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 700;
  color: hsl(var(--foreground));
}
.llm-pre {
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 8px 10px;
  max-height: 220px;
  overflow: auto;
}
.llm-round {
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 8px 10px;
  margin-bottom: 8px;
}
.llm-round-head {
  font-size: 11px;
  font-weight: 600;
  color: hsl(var(--primary));
  margin-bottom: 4px;
  font-variant-numeric: tabular-nums;
}
.llm-note { font-size: 11.5px; line-height: 1.6; color: hsl(var(--muted-foreground)); white-space: pre-wrap; }
.llm-skill summary {
  cursor: pointer;
  font-size: 11.5px;
  color: hsl(var(--primary));
  user-select: none;
  margin-bottom: 6px;
}
.llm-skill summary:hover { text-decoration: underline; }
.llm-skill-md {
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 8px 12px;
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
}
.llm-run-btn {
  width: 100%;
  height: 30px;
  margin-top: 16px;
  font-size: 12.5px;
  font-weight: 600;
  border: 1px solid hsl(var(--primary) / 0.55);
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
}
.llm-run-btn:hover:not(:disabled) { background: hsl(var(--primary) / 0.22); }
.llm-run-btn:disabled { opacity: 0.55; cursor: default; }
.llm-run-hint { margin: 6px 0 0; font-size: 10.5px; color: hsl(var(--muted-foreground)); }
.llm-prompt-box {
  width: 100%;
  margin-top: 4px;
  padding: 8px 10px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.5;
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  resize: vertical;
  box-sizing: border-box;
}
.llm-prompt-box:focus { outline: none; border-color: hsl(var(--primary) / 0.6); }
.llm-prompt-box:disabled { opacity: 0.6; }

.obj-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.obj-table tr { border-bottom: 1px solid hsl(var(--border)); }
.obj-key {
  text-align: left;
  vertical-align: top;
  padding: 5px 8px 5px 2px;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.obj-val {
  padding: 5px 2px;
  word-break: break-word;
  white-space: pre-wrap;
  font-variant-numeric: tabular-nums;
}
.obj-li { padding: 1px 0; }
.obj-li + .obj-li { border-top: 1px dotted hsl(var(--border)); }
.layer-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
  min-width: 0;
}
.layer-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Info */
/* 權重 tab（RWD Maps 版面簡化控制）*/
.weight-panel { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
.weight-hint { font-size: 11.5px; color: hsl(var(--muted-foreground)); line-height: 1.6; }
.weight-modes { display: flex; flex-direction: column; gap: 4px; }
.weight-mode {
  text-align: left;
  padding: 7px 12px;
  font-size: 12.5px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: hsl(var(--foreground));
}
.weight-mode:hover { background: hsl(var(--accent)); }
.weight-mode.active { background: hsl(var(--primary) / 0.12); color: hsl(var(--primary)); border-color: hsl(var(--primary)); font-weight: 600; }
.weight-random {
  padding: 8px 12px;
  font-size: 12.5px;
  border: 1px solid hsl(var(--primary) / 0.5);
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--primary) / 0.1);
  color: hsl(var(--primary));
  font-weight: 500;
}
.weight-random:hover { background: hsl(var(--primary) / 0.2); }
.weight-auto.active {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  border-color: hsl(var(--primary)); font-weight: 600;
}
.weight-auto.active:hover { background: hsl(var(--primary) / 0.9); }
.weight-hide-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px; }
.weight-hide-toggle { display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer; }
.weight-hide-px { display: flex; align-items: center; gap: 4px; font-size: 12.5px; color: hsl(var(--muted-foreground)); }
.weight-hide-px input {
  width: 46px; padding: 3px 5px; font-size: 12.5px; text-align: right;
  border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--background)); color: hsl(var(--foreground));
}
.weight-stat { font-size: 12px; color: hsl(var(--muted-foreground)); padding: 0 2px; }
.weight-stat b { color: hsl(var(--foreground)); font-variant-numeric: tabular-nums; }
.hidden-list { padding: 2px; }
.hidden-list-title { font-size: 12px; font-weight: 600; color: hsl(var(--muted-foreground)); margin-bottom: 4px; }
.hidden-list-items {
  margin: 0; padding: 6px 8px 6px 26px; max-height: 160px; overflow-y: auto;
  border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--muted) / 0.4); font-size: 12px; line-height: 1.6;
}
.hidden-list-items li { color: hsl(var(--foreground)); }
.info-rows { display: flex; flex-direction: column; gap: 2px; }
.info-row {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  font-size: 12.5px;
  border-bottom: 1px solid hsl(var(--border) / 0.5);
}
.info-row:last-child { border-bottom: none; }
.info-key {
  width: 84px;
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}
.info-row > span:not(.info-key), .info-row > a { min-width: 0; overflow-wrap: anywhere; }
.info-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: hsl(var(--primary));
  text-decoration: none;
}
.info-link:hover { text-decoration: underline; }
.info-empty { font-size: 12.5px; color: hsl(var(--muted-foreground)); padding: 8px 0; }


/* Audit */
.audit-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: calc(var(--radius) - 2px);
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 8px;
}
.audit-banner.pass {
  background: hsl(142 71% 45% / 0.12);
  color: hsl(142 60% 40%);
}
.dark .audit-banner.pass { color: hsl(142 65% 55%); }
.audit-banner.fail {
  background: hsl(var(--destructive) / 0.12);
  color: hsl(var(--destructive));
}
.audit-date {
  margin-left: auto;
  font-weight: 400;
  font-size: 10.5px;
  opacity: 0.75;
}
.audit-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.audit-item {
  display: flex;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.45;
  color: hsl(var(--foreground));
}
.audit-item.ok { color: hsl(var(--muted-foreground)); }
.audit-ic { flex-shrink: 0; margin-top: 2px; }
.audit-ic.ok { color: hsl(142 60% 42%); }
.audit-ic.warn { color: hsl(38 92% 50%); }
.audit-list.fail .audit-ic { color: hsl(var(--destructive)); }

.line-list { display: flex; flex-direction: column; gap: 2px; }
.line-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: 12.5px;
  min-width: 0;
}
.line-swatch {
  width: 14px;
  height: 6px;
  border-radius: 3px;
  flex-shrink: 0;
}
.line-uc {
  font-size: 10px;
  color: hsl(38 92% 40%);
  background: hsl(38 92% 50% / 0.15);
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: auto;
  flex: none;
}
.line-ref {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  background: hsl(var(--muted));
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.line-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Style */
.field { margin-bottom: 12px; flex: 1; min-width: 0; }
.check-field { display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; }
.check-field input { accent-color: hsl(var(--primary)); }
.field-row { display: flex; gap: 10px; }
.color-input {
  width: 100%;
  height: 30px;
  padding: 2px;
  border: 1px solid hsl(var(--input));
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  cursor: pointer;
}
.skeleton-rules { font-size: 12px; line-height: 1.55; color: hsl(var(--foreground)); }
.skeleton-rules p { margin: 4px 0; }
.skeleton-rules .sk-sub { font-weight: 600; margin-top: 10px; color: hsl(var(--muted-foreground)); }
.skeleton-rules ul { list-style: none; margin: 4px 0; padding: 0; }
.skeleton-rules li { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
.sk-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  border: 1.5px solid #3f3f46;
}
.sk-dot.sk-ring { background: #fff; }
.sk-line { width: 16px; height: 4px; border-radius: 2px; flex-shrink: 0; }
.sk-line.sk-plain { background: linear-gradient(90deg, #e11d48, #2563eb, #16a34a); }
.skeleton-rules .rose-note { margin-top: 10px; font-size: 11px; color: hsl(var(--muted-foreground)); }
.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: hsl(var(--muted-foreground));
  border-top: 1px solid hsl(var(--border));
  padding-top: 12px;
  margin: 12px 0 10px;
}
.rose-stats { margin-top: 10px; }
.rose-note {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.5;
  color: hsl(var(--muted-foreground));
}
.rose-note .rose-red { color: #e11d48; font-weight: 600; }
</style>
