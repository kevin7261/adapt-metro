<script setup>
import { ref, reactive, computed } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { layerData } from '../stores/layerData'
import MIcon from './MIcon.vue'

const store = useMapStore()

// The tab owning this table passes its layer; fall back to the active layer.
// `ownerId` keys the open/closed state — a D3 tab shows a SOURCE layer's data
// but owns its own toggle, so the two ids differ there.
const props = defineProps({
  layer: { type: Object, default: null },
  ownerId: { type: String, default: null },
})
const activeLayer = computed(() => props.layer ?? store.selectedLayer)
const toggleId = computed(() => props.ownerId ?? activeLayer.value?.id)

// 中文欄位標題（整個面板走中文；缺的欄用原鍵）。
const COL_LABEL = {
  station_name: '站名', station_name_local: '當地名', network: '系統',
  lines: '路線', city: '城市',
  route_ref: '代號', route_name: '路線名', route_name_en: '英文名', stations: '站數',
  name: '名稱', name_en: '英文名', kind: '類別', size: '規模',
}
const label = (col) => COL_LABEL[col] ?? col

const LANDMARK_KIND_ZH = {
  'river-centerline': '河流', river: '河流', palace: '宮殿／皇居', park: '公園',
}

const data = computed(() => {
  const layer = activeLayer.value
  return (layer && layerData[layer.id]) || null
})

/* ---- 三類物件 rows（各自從同一份 layer geojson 抽出）---- */

// 車站：Point features（排除地標）。
const stationRows = computed(() => {
  const d = data.value
  if (!d) return []
  return d.features
    .filter((f) => f.geometry.type === 'Point' && !f.properties?.landmark_id)
    .map((f) => ({
      ...f.properties,
      lines: Array.isArray(f.properties.lines)
        ? f.properties.lines.join(', ')
        : f.properties.lines,
      _key: f.properties.station_id,
      _coords: f.geometry.coordinates,
    }))
})

// 路線：MultiLineString features 內的 routes，依 route_id（或代號+名稱）去重；
// 每條路線累計唯一停靠站數與涵蓋範圍供縮放。
const lineRows = computed(() => {
  const d = data.value
  if (!d) return []
  const byRoute = new Map()
  for (const f of d.features) {
    if (f.geometry.type !== 'MultiLineString' || f.properties?.landmark_id) continue
    for (const r of f.properties.routes ?? []) {
      const key = r.route_id ?? `${r.route_ref ?? ''}|${r.route_name ?? ''}`
      let e = byRoute.get(key)
      if (!e) {
        e = {
          route_ref: r.route_ref,
          route_name: r.route_name,
          route_name_en: r.route_name_en,
          network: r.network,
          route_color: r.route_color,
          _key: key,
          _stationIds: new Set(),
          _bounds: null,
        }
        byRoute.set(key, e)
      }
      for (const s of r.stations ?? []) e._stationIds.add(s.station_id)
      e._bounds = extendBounds(e._bounds, f.geometry)
    }
  }
  return [...byRoute.values()].map((e) => ({ ...e, stations: e._stationIds.size }))
})

// 地標：帶 landmark_id 的 features（河流線／皇居・公園面域）。
const landmarkRows = computed(() => {
  const d = data.value
  if (!d) return []
  return d.features
    .filter((f) => f.properties?.landmark_id)
    .map((f) => {
      const p = f.properties
      const size =
        p.length_km != null ? `${(+p.length_km).toFixed(1)} km`
        : p.area_km2 != null ? `${(+p.area_km2).toFixed(2)} km²`
        : ''
      return {
        name: p.name,
        name_en: p.name_en,
        kind: LANDMARK_KIND_ZH[p.kind] ?? p.kind,
        size,
        _key: p.landmark_id,
        _bounds: extendBounds(null, f.geometry),
      }
    })
})

/* ---- tab 定義 ---- */
const TABS = [
  {
    id: 'stations', label: '車站', noun: '車站',
    columns: ['station_name', 'station_name_local', 'network', 'lines', 'city'],
    src: stationRows,
    zoom: (row) => mapHandle.map?.flyTo({ center: row._coords, zoom: 14 }),
  },
  {
    id: 'lines', label: '路線', noun: '路線',
    columns: ['route_ref', 'route_name', 'route_name_en', 'network', 'stations'],
    src: lineRows,
    zoom: (row) => zoomToBounds(row._bounds),
  },
  {
    id: 'landmarks', label: '地標', noun: '地標',
    columns: ['name', 'name_en', 'kind', 'size'],
    src: landmarkRows,
    zoom: (row) => zoomToBounds(row._bounds),
  },
]
const activeTab = ref('stations')
const tab = computed(() => TABS.find((t) => t.id === activeTab.value))

const filter = ref('')
// 每個 tab 各記自己的排序（切 tab 不會用到別 tab 的欄）。
const sortState = reactive({
  stations: { by: 'station_name', dir: 1 },
  lines: { by: 'route_ref', dir: 1 },
  landmarks: { by: 'name', dir: 1 },
})
const selectedRow = ref(null)

const allRows = computed(() => tab.value.src.value)

const rows = computed(() => {
  const cols = tab.value.columns
  let r = allRows.value
  const q = filter.value.trim().toLowerCase()
  if (q) {
    r = r.filter((row) =>
      cols.some((c) => String(row[c] ?? '').toLowerCase().includes(q)),
    )
  }
  const { by, dir } = sortState[activeTab.value]
  return [...r].sort((a, b) => {
    const va = a[by] ?? '', vb = b[by] ?? ''
    return (va > vb ? 1 : va < vb ? -1 : 0) * dir
  })
})

function switchTab(id) {
  activeTab.value = id
  selectedRow.value = null
}

function sort(col) {
  const s = sortState[activeTab.value]
  if (s.by === col) s.dir *= -1
  else { s.by = col; s.dir = 1 }
}

function onRow(row) {
  selectedRow.value = row._key
  tab.value.zoom(row)
}

/* ---- bounds helpers（路線/地標 縮放到範圍）---- */
// [w, s, e, n]，就地擴張 acc。
function extendBounds(acc, geometry) {
  const b = acc ?? [Infinity, Infinity, -Infinity, -Infinity]
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < b[0]) b[0] = c[0]
      if (c[1] < b[1]) b[1] = c[1]
      if (c[0] > b[2]) b[2] = c[0]
      if (c[1] > b[3]) b[3] = c[1]
    } else c.forEach(visit)
  }
  visit(geometry.coordinates)
  return b
}
function zoomToBounds(b) {
  if (!b || b[0] > b[2]) return
  mapHandle.map?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 15 })
}

/* ---- resize ---- */
const dragging = ref(false)
function startResize(e) {
  dragging.value = true
  const startY = e.clientY
  const startH = store.attributeTableHeight
  const move = (ev) => {
    store.attributeTableHeight = Math.min(500, Math.max(120, startH - (ev.clientY - startY)))
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
  <section class="attr-table" :style="{ height: store.attributeTableHeight + 'px' }">
    <div
      class="resize-y"
      :class="{ dragging }"
      role="separator"
      aria-orientation="horizontal"
      @pointerdown="startResize"
    />
    <div class="attr-header">
      <MIcon name="table" :size="14" class="hdr-icon" />
      <span class="attr-title">物件列表</span>

      <span class="attr-meta">
        {{ activeLayer?.name ?? '—' }} — {{ rows.length }} / {{ allRows.length }} {{ tab.noun }}
      </span>

      <div class="attr-actions">
        <div class="filter-wrap">
          <MIcon name="filter_alt" :size="12" class="filter-icon" />
          <input v-model="filter" class="filter-input" placeholder="篩選…" />
        </div>
        <button class="btn-icon" title="關閉" @click="toggleId && store.toggleAttributeTable(toggleId, false)">
          <MIcon name="close" :size="14" />
        </button>
      </div>
    </div>

    <div class="attr-tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="attr-tab"
        :class="{ active: activeTab === t.id }"
        role="tab"
        :aria-selected="activeTab === t.id"
        @click="switchTab(t.id)"
      >
        {{ t.label }}
        <span class="tab-count">{{ t.src.value.length }}</span>
      </button>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="row-action-col"></th>
            <th v-for="col in tab.columns" :key="col" @click="sort(col)">
              <span class="th-inner">
                {{ label(col) }}
                <MIcon name="arrow_upward" v-if="sortState[activeTab].by === col && sortState[activeTab].dir === 1" :size="11" />
                <MIcon name="arrow_downward" v-else-if="sortState[activeTab].by === col" :size="11" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td class="empty-cell" :colspan="tab.columns.length + 1">沒有{{ tab.noun }}</td>
          </tr>
          <tr
            v-for="row in rows"
            :key="row._key"
            :class="{ selected: selectedRow === row._key }"
            @click="selectedRow = row._key"
          >
            <td class="row-action-col">
              <button class="btn-icon zoom-btn" title="縮放至此物件" @click.stop="onRow(row)">
                <MIcon name="zoom_in" :size="12" />
              </button>
            </td>
            <td v-for="col in tab.columns" :key="col">{{ row[col] ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.attr-table {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--card));
  max-height: min(500px, 42dvh);
}
.resize-y { position: absolute; top: -2px; left: 0; right: 0; z-index: 10; }
.attr-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-bottom: 1px solid hsl(var(--border));
  min-height: 36px;
  flex-shrink: 0;
}
.hdr-icon { color: hsl(var(--muted-foreground)); }
.attr-title { font-size: 13px; font-weight: 600; }
.attr-meta { font-size: 12px; color: hsl(var(--muted-foreground)); }

/* 頁籤列：底線式 tab（非按鈕）。 */
.attr-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid hsl(var(--border));
  flex-shrink: 0;
}
.attr-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px; /* 蓋住容器底線，讓 active 底線接合 */
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: 12.5px; font-weight: 500;
  cursor: pointer;
}
.attr-tab:hover { color: hsl(var(--foreground)); }
.attr-tab.active {
  color: hsl(var(--foreground));
  border-bottom-color: hsl(var(--primary));
  font-weight: 600;
}
.tab-count {
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 999px;
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
}
.attr-tab.active .tab-count {
  background: hsl(var(--primary) / 0.15);
  color: hsl(var(--primary));
}

.attr-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.filter-wrap { position: relative; margin-right: 6px; }
.filter-icon {
  position: absolute; left: 7px; top: 50%; transform: translateY(-50%);
  color: hsl(var(--muted-foreground));
}
.filter-input {
  height: 26px; width: 150px;
  padding: 0 8px 0 24px;
  border: 1px solid hsl(var(--input));
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: hsl(var(--foreground));
  font-size: 12px;
}
.filter-input:focus { outline: 2px solid hsl(var(--ring)); outline-offset: -1px; }

.table-scroll { flex: 1; overflow: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th {
  position: sticky; top: 0; z-index: 1;
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  font-weight: 600;
  text-align: left;
  padding: 5px 12px;
  border-bottom: 1px solid hsl(var(--border));
  border-right: 1px solid hsl(var(--border));
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.th-inner { display: inline-flex; align-items: center; gap: 4px; }
td {
  padding: 4px 12px;
  border-bottom: 1px solid hsl(var(--border) / 0.6);
  border-right: 1px solid hsl(var(--border) / 0.4);
  white-space: nowrap;
}
.empty-cell {
  text-align: center;
  color: hsl(var(--muted-foreground));
  padding: 18px;
  border-right: none;
}
tbody tr:hover { background: hsl(var(--accent) / 0.5); }
tbody tr.selected { background: hsl(var(--primary) / 0.12); }
.row-action-col { width: 34px; padding: 0 4px; border-right: none; }
.zoom-btn { width: 22px; height: 22px; opacity: 0; }
tbody tr:hover .zoom-btn, tbody tr.selected .zoom-btn { opacity: 1; }
</style>
