import { ref, watch, computed } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import { loadMetroCatalog } from '../../stores/metroCatalog'

// Module-level so Import + Add* dialogs share one catalog load.
const catalog = ref(null)
const catalogError = ref(null)

export const IMPORT_DIALOGS = ['import-metro', 'import-quick', 'import-stations']
// 匯入 dialog 需要 catalog；新增視圖 dialog 也要（cityParts 的中文名由 catalog 對應——
// 否則城市只顯示英文）。任一開啟且尚未載入就載。
const NEED_CATALOG = [...IMPORT_DIALOGS, 'add-d3', 'add-hillclimb', 'add-rwd']

let watching = false

/** Shared metro catalog + cityParts. Call from DialogHost (always mounted). */
export function useDialogCatalog() {
  const store = useMapStore()
  const dialog = computed(() => store.ui.dialog)

  if (!watching) {
    watching = true
    watch(dialog, (d) => {
      if (!NEED_CATALOG.includes(d) || catalog.value) return
      catalogError.value = null
      loadMetroCatalog()
        .then((systems) => { catalog.value = systems })
        .catch((err) => { catalogError.value = String(err) })
    })
  }

  // 城市中英文標籤——沿來源鏈追到 metro 圖層（d3→metro、hillclimb→d3→metro），中文由
  // catalog（含 cityZh/countryZh）以城市名對應。回傳 { zh:'城市·國家', en:'City · Country' }。
  function cityParts(l) {
    let cur = l
    const seen = new Set()
    while (cur && cur.type !== 'metro' && cur.sourceLayerId && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = store.layers.find((s) => s.id === cur.sourceLayerId)
    }
    const city = cur?.city ?? l.name
    const en = cur?.country ? `${city} · ${cur.country}` : city
    const cat = catalog.value?.find((s) => s.city === city)
    const zh = cat ? `${cat.cityZh ?? cat.city} · ${cat.countryZh ?? cat.country}` : ''
    return { zh, en }
  }

  return { catalog, catalogError, cityParts }
}
