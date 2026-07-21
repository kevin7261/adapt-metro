<script setup>
import { ref, computed, watch } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import { layerData } from '../../stores/layerData'
import { stationsAlongSeg } from '../../stores/popupHtml'
import MIcon from '../MIcon.vue'
import './style-panel.css'

const props = defineProps({
  layer: { type: Object, required: true },
})

const store = useMapStore()
const selectedProps = computed(() => store.selectedFeatures[props.layer.id] ?? null)
const asText = (v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}
const linkFor = (key, v) => {
  if (typeof v !== 'string' || !v) return null
  if (key === 'wikipedia') {
    if (/^https?:\/\//.test(v)) return v
    const m = /^([a-z-]+):(.+)$/.exec(v)
    if (m) return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(v.replace(/ /g, '_'))}`
  }
  return null
}
const selectedEntries = computed(() => {
  const p = selectedProps.value
  if (!p) return []
  const OMIT = new Set(['merged_names', 'wikidata', 'routes', 'lines', 'route_refs', 'route_colors'])
  const dupLocal = (k) => {
    const m = /^(.+)_(local|en)$/.exec(k)
    return m && p[m[1]] != null && p[k] === p[m[1]]
  }
  return Object.keys(p).filter((k) => !k.startsWith('_') && !OMIT.has(k) && !dupLocal(k)).sort().map((k) => {
    let v = p[k]
    if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
      try { v = JSON.parse(v) } catch { /* leave as-is */ }
    }
    if (Array.isArray(v)) return { key: k, isList: true, items: v.map(asText) }
    const href = linkFor(k, v)
    return { key: k, isList: false, value: asText(v), href }
  })
})

const layer = computed(() => props.layer)
const metroLines = computed(() => {
  const d = layerData[layer.value.id]
  if (!d) return []
  const byId = new Map()
  for (const f of d.features) {
    if (f.geometry.type === 'Point') continue
    for (const r of f.properties.routes ?? [f.properties]) {
      if (r.route_id && !byId.has(r.route_id)) byId.set(r.route_id, r)
    }
  }
  return [...byId.values()]
})
const routeByName = computed(() => {
  const m = new Map()
  for (const r of metroLines.value) {
    if (r.route_name != null && !m.has(String(r.route_name))) m.set(String(r.route_name), r)
    if (r.route_ref != null && !m.has(String(r.route_ref))) m.set(String(r.route_ref), r)
  }
  return m
})
const parseArr = (v) => {
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return [] } }
  return Array.isArray(v) ? v : []
}
const stationRoutes = computed(() => {
  const p = selectedProps.value
  if (!p?.station_id) return []
  return parseArr(p.routes).map((e) => {
    const r = routeByName.value.get(String(e.name)) ?? routeByName.value.get(String(e.ref))
    return { route_ref: String(e.ref), route_name: e.name ?? String(e.ref),
      route_color: e.route_color ?? r?.route_color ?? '#e11d48', pass: !!e.pass }
  })
})
const stopRoutes = computed(() => stationRoutes.value.filter((r) => !r.pass))
const passRoutes = computed(() => stationRoutes.value.filter((r) => r.pass))
const mergedNames = computed(() => {
  let v = selectedProps.value?.merged_names
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return [] } }
  if (!Array.isArray(v)) return []
  const colorByRef = new Map()
  for (const r of metroLines.value)
    if (r.route_ref != null) colorByRef.set(String(r.route_ref), r.route_color ?? '#e11d48')
  for (const e of stationRoutes.value)
    if (e.route_ref != null && e.route_color) colorByRef.set(String(e.route_ref), e.route_color)
  return v.map((e) => ({
    station_id: e.station_id,
    name: e.station_name,
    nameLocal: e.station_name_local && e.station_name_local !== e.station_name ? e.station_name_local : null,
    lines: (e.lines ?? []).map((ref) => ({ ref: String(ref), color: colorByRef.get(String(ref)) ?? '#e11d48' })),
  }))
})
const joinTitle = (list) => {
  const name = [...new Set(list.map((e) => e.name))].join(' / ')
  const en = [...new Set(list.map((e) => e.nameEn || e.name))].join(' / ')
  return { name, nameEn: en !== name ? en : null }
}
const selectedRouteLists = computed(() => {
  const p = selectedProps.value
  if (!p || p.station_id) return []
  let routes = p.routes
  if (typeof routes === 'string') { try { routes = JSON.parse(routes) } catch { return [] } }
  if (!Array.isArray(routes)) return []
  const d = layerData[layer.value?.id] ??
    (layer.value?.sourceLayerId ? layerData[layer.value.sourceLayerId] : null)
  const seg = d?.features.find((f) =>
    f.geometry?.type !== 'Point' && f.properties?.seg_id === p.seg_id)
  let ordered = []
  if (seg) {
    const byCoord = new Map()
    for (const f of d.features)
      if (f.geometry.type === 'Point') byCoord.set(f.geometry.coordinates.join(','), f.properties)
    ordered = stationsAlongSeg(seg, byCoord)
      .map((s) => ({ station_id: s.station_id, station_name: s.station_name, code: s.code }))
  }
  const rows = routes.map((r) => {
    const passIds = new Set((r.stations ?? []).filter((s) => s.pass).map((s) => s.station_id))
    const codeOf = new Map((r.stations ?? []).map((s) => [s.station_id, s.code]))
    const base = ordered.length ? ordered : (r.stations ?? [])
    const stations = base.map((s) => ({ ...s, code: s.code ?? codeOf.get(s.station_id),
      pass: !!s.pass || passIds.has(s.station_id) }))
    return {
      route_id: r.route_id,
      name: r.route_name ?? r.route_id,
      nameLocal: r.route_name_local && r.route_name_local !== r.route_name ? r.route_name_local : null,
      nameEn: r.route_name_en && r.route_name_en !== r.route_name ? r.route_name_en : null,
      ref: r.route_ref,
      color: r.route_color ?? '#e11d48',
      stations,
      uniqueCount: new Set(stations.filter((s) => !s.pass).map((s) => s.station_id)).size,
    }
  })
  const seen = new Set()
  return rows.filter((r) => {
    const k = `${r.ref ?? ''}|${r.name}|${r.uniqueCount}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
})
const objectTitle = computed(() => {
  const p = selectedProps.value
  if (!p) return null
  if (p.landmark_id) {
    const en = p.name_en && p.name_en !== p.name ? p.name_en : null
    return p.name ? { name: p.name, nameEn: en } : null
  }
  if (p.station_id) {
    const mn = mergedNames.value
    const en = p.station_name_en && p.station_name_en !== p.station_name ? p.station_name_en : null
    if (mn.length > 1) return { ...joinTitle(mn), nameEn: en }
    const name = p.station_name || p.station_name_local
    if (!name) return null
    return { name, nameEn: en }
  }
  const rl = selectedRouteLists.value
  if (rl.length) return joinTitle(rl)
  return null
})

const toggleIn = (setRef, id) => {
  const next = new Set(setRef.value)
  next.has(id) ? next.delete(id) : next.add(id)
  setRef.value = next
}
const expandedRoutes = ref(new Set())
const toggleRoute = (routeId) => toggleIn(expandedRoutes, routeId)
watch(selectedProps, () => { expandedRoutes.value = new Set() })
</script>

<template>
          <div v-if="!selectedEntries.length" class="obj-empty">
            點地圖上的物件以檢視其屬性
          </div>
          <!-- 車站/路段：最上方顯示名稱（英文 + 在地名），共站/共線以 " / " 併 -->
          <div v-if="objectTitle" class="obj-title">
            {{ objectTitle.name }}
            <span v-if="objectTitle.nameEn" class="obj-title-local">{{ objectTitle.nameEn }}</span>
          </div>
          <!-- 標題下不放維基連結（使用者 2026-07：下方屬性表的 wikipedia 列已有連結） -->
          <!-- 路段：站序中同時列停靠與通過(不停)站，pass 站標記、灰字並排在正確位置 -->
          <template v-for="rt in selectedRouteLists" :key="rt.route_id">
            <button type="button" class="obj-route-head obj-route-toggle"
              :aria-expanded="expandedRoutes.has(rt.route_id)" @click="toggleRoute(rt.route_id)">
              <MIcon :name="expandedRoutes.has(rt.route_id) ? 'expand_more' : 'chevron_right'" class="obj-route-caret" />
              <span class="line-swatch" :style="{ background: rt.color }" />
              <span v-if="rt.ref" class="line-ref">{{ rt.ref }}</span>
              <span class="obj-route-name">{{ rt.name }}</span>
              <span class="obj-route-count">停靠 {{ rt.uniqueCount }} 站</span>
            </button>
            <ol v-if="expandedRoutes.has(rt.route_id)" class="obj-station-list">
              <li v-for="(st, i) in rt.stations" :key="`${st.station_id}-${i}`" :class="{ 'st-pass': st.pass }">
                <span v-if="st.code" class="obj-st-code">{{ st.code }}</span><span v-else-if="st.mileage != null" class="obj-st-code" title="里程">{{ st.mileage }}K</span>{{ st.station_name }}<span v-if="st.pass" class="obj-pass-tag">pass</span>
              </li>
            </ol>
          </template>
          <!-- 共站合併：異名轉乘站——每條線在此站的不同站名 -->
          <div v-if="mergedNames.length" class="obj-merged">
            <div class="obj-pass-sub">共站（各線）</div>
            <div v-for="mn in mergedNames" :key="mn.station_id" class="obj-merged-row">
              <span class="obj-merged-name">{{ mn.name
                }}<span v-if="mn.nameLocal" class="obj-merged-local">{{ mn.nameLocal }}</span></span>
              <span v-for="ln in mn.lines" :key="ln.ref" class="line-ref obj-merged-line"
                :style="{ background: ln.color }">{{ ln.ref }}</span>
            </div>
          </div>
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
