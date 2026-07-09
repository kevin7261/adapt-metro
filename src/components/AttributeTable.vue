<script setup>
import { ref, computed } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { layerData } from '../stores/layerData'
import {
  TableProperties, X, Filter, Download, Sigma, BarChart3,
  ArrowUp, ArrowDown, ZoomIn,
} from 'lucide-vue-next'

const store = useMapStore()

const columns = ['station_name', 'station_name_local', 'network', 'lines', 'city']
const filter = ref('')
const sortBy = ref('station_name')
const sortDir = ref(1)
const selectedRow = ref(null)

// Stations of the active tab's metro layer (loaded lazily by its LayerTab).
const stations = computed(() => {
  const layer = store.selectedLayer
  const data = layer && layerData[layer.id]
  if (!data) return []
  return data.features.filter((f) => f.geometry.type === 'Point')
})

const rows = computed(() => {
  let r = stations.value.map((f) => ({
    ...f.properties,
    lines: Array.isArray(f.properties.lines) ? f.properties.lines.join(', ') : f.properties.lines,
    _coords: f.geometry.coordinates,
  }))
  const q = filter.value.trim().toLowerCase()
  if (q) {
    r = r.filter((row) =>
      columns.some((c) => String(row[c] ?? '').toLowerCase().includes(q)),
    )
  }
  return [...r].sort((a, b) => {
    const va = a[sortBy.value] ?? '', vb = b[sortBy.value] ?? ''
    return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir.value
  })
})

function sort(col) {
  if (sortBy.value === col) sortDir.value *= -1
  else { sortBy.value = col; sortDir.value = 1 }
}

function zoomToRow(row) {
  selectedRow.value = row.station_id
  mapHandle.map?.flyTo({ center: row._coords, zoom: 14 })
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
      <TableProperties :size="14" class="hdr-icon" />
      <span class="attr-title">Attribute table</span>
      <span class="attr-meta">
        {{ store.selectedLayer?.name ?? '—' }} — {{ rows.length }} / {{ stations.length }} stations
      </span>

      <div class="attr-actions">
        <div class="filter-wrap">
          <Filter :size="12" class="filter-icon" />
          <input v-model="filter" class="filter-input" placeholder="Filter…" />
        </div>
        <button class="btn-icon" title="Statistics" @click="store.fake('Field statistics')">
          <Sigma :size="14" />
        </button>
        <button class="btn-icon" title="Charts" @click="store.fake('Charts')">
          <BarChart3 :size="14" />
        </button>
        <button class="btn-icon" title="Export" @click="store.fake('Export table')">
          <Download :size="14" />
        </button>
        <button class="btn-icon" title="Close" @click="store.ui.attributeTable = false">
          <X :size="14" />
        </button>
      </div>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="row-action-col"></th>
            <th v-for="col in columns" :key="col" @click="sort(col)">
              <span class="th-inner">
                {{ col }}
                <ArrowUp v-if="sortBy === col && sortDir === 1" :size="11" />
                <ArrowDown v-else-if="sortBy === col" :size="11" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.station_id"
            :class="{ selected: selectedRow === row.station_id }"
            @click="selectedRow = row.station_id"
          >
            <td class="row-action-col">
              <button class="btn-icon zoom-btn" title="Zoom to feature" @click.stop="zoomToRow(row)">
                <ZoomIn :size="12" />
              </button>
            </td>
            <td v-for="col in columns" :key="col">{{ row[col] ?? '—' }}</td>
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
tbody tr:hover { background: hsl(var(--accent) / 0.5); }
tbody tr.selected { background: hsl(var(--primary) / 0.12); }
.row-action-col { width: 34px; padding: 0 4px; border-right: none; }
.zoom-btn { width: 22px; height: 22px; opacity: 0; }
tbody tr:hover .zoom-btn, tbody tr.selected .zoom-btn { opacity: 1; }
</style>
