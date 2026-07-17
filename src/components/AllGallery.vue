<script setup>
import { ref, computed } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import { VIEW_ORDER, viewLabels, HC_VIEW_ORDER, hcViewLabels, RWD_VIEW_ORDER, rwdViewLabels, rwdCellCompact, rwdCellVariant } from '../stores/viewGeometry'
import GalleryShell from './GalleryShell.vue'
import CityAllCard from './CityAllCard.vue'

// 視圖畫廊（2026-07 併四為一）：every city 的「所有地圖」——Raw Maps 縮圖＋
// Map Adjust / Straighten / RWD Maps 預算視圖（data/metro/{views,hcviews,
// rwdviews}/）。因為全部展開太多，工具列可「逐一」勾選要顯示的視圖（每個圖層
// 的所有功能各自開關，不是四大類一次全開）；每類另有總開關。預設顯示 Raw
// Maps 縮圖＋RWD Maps 全部視圖。點任何一格都匯入該城市的整組管線圖層
//（importCityChain：一城一群組，Raw / Adjust / Straighten / RWD 四層），並開啟
// 點到的那種視圖的 tab。
const store = useMapStore()

async function load() {
  const res = await fetch(assetUrl('data/metro/views/index.json'), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).systems ?? []
}

// 勾選清單的標籤與各城市無關（各城市的實際旋轉角在卡片 cell 標籤上）——用
// tilt=0 產生再把「旋轉 0°」縮成「旋轉」。
const stripRot = (s) => (s ?? '').replace(/旋轉 0°/g, '旋轉')
const viewsOf = (order, labelFn) => {
  const lab = labelFn(0)
  return order.map((id) => ({ id, label: stripRot(lab[id]) }))
}
const KINDS = [
  { id: 'raw', label: 'Raw Maps', views: [{ id: 'thumb', label: '路網縮圖' }] },
  { id: 'adjust', label: 'Map Adjust', views: viewsOf(VIEW_ORDER, viewLabels) },
  { id: 'straighten', label: 'Straighten', views: viewsOf(HC_VIEW_ORDER, hcViewLabels) },
  { id: 'rwd', label: 'RWD Maps', views: viewsOf(RWD_VIEW_ORDER, rwdViewLabels) },
]

// 已勾選的視圖（`kind:viewId`）。預設：Raw Maps 縮圖＋RWD Maps 全部。
const shown = ref(new Set(['raw:thumb', ...RWD_VIEW_ORDER.map((id) => `rwd:${id}`)]))
const isOn = (kind, viewId) => shown.value.has(`${kind}:${viewId}`)
function toggleView(kind, viewId) {
  const key = `${kind}:${viewId}`
  const s = new Set(shown.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  shown.value = s
}
// 類別總開關：有任一勾選 → 全關；全沒勾 → 全開。
const kindState = (k) => {
  const on = k.views.filter((v) => isOn(k.id, v.id)).length
  return on === 0 ? 'none' : on === k.views.length ? 'all' : 'some'
}
function toggleKind(k) {
  const any = k.views.some((v) => isOn(k.id, v.id))
  const s = new Set(shown.value)
  for (const v of k.views) {
    const key = `${k.id}:${v.id}`
    if (any) s.delete(key)
    else s.add(key)
  }
  shown.value = s
}

// 卡片要畫的區段：每類只留勾選的視圖（CityViewGrid 的 order 就是 cell 清單）。
const sections = computed(() => KINDS
  .map((k) => ({ id: k.id, order: k.views.filter((v) => isOn(k.id, v.id)).map((v) => v.id) }))
  .filter((s) => s.order.length))

// 點卡片標題或任何一格：匯入整組管線圖層，變體由點到的 cell 決定
// （Straighten 的 *-rot → 旋轉；RWD 的 cell id → 縮減網格來源＋變體），
// 再開啟點到那種視圖的 tab。
function pick(kind, entry, viewId) {
  const variant = kind === 'rwd' ? rwdCellVariant(viewId)
    : kind === 'straighten' && /-rot$/.test(viewId ?? '') ? 'rot' : 'orig'
  const compact = kind === 'rwd' ? rwdCellCompact(viewId) : 'rect'
  const { metro, d3, hc, rwd } = store.importCityChain(entry, { variant, compact })
  const target = { raw: metro, adjust: d3, straighten: hc, rwd }[kind] ?? metro
  if (!target) { store.toast('無法建立視圖'); return }
  openLayerTab(target)
  const kindLabel = KINDS.find((k) => k.id === kind)?.label ?? kind
  store.toast(`已匯入 ${entry.cityZh ?? entry.city}（開啟 ${kindLabel}）`)
}
</script>

<template>
  <GalleryShell :load="load" loading-text="載入全球視圖清單…" error-hint="npm run metro:views">
    <template #toolbar>
      <div class="kind-rows">
        <div v-for="k in KINDS" :key="k.id" class="kind-row">
          <button
            class="kind-master"
            :class="kindState(k)"
            :title="`${k.label}：全部開／關`"
            @click="toggleKind(k)"
          >{{ k.label }}</button>
          <label
            v-for="v in k.views"
            :key="v.id"
            class="kind-check"
            :class="{ on: isOn(k.id, v.id) }"
          >
            <input type="checkbox" :checked="isOn(k.id, v.id)" @change="toggleView(k.id, v.id)" />
            {{ v.label }}
          </label>
        </div>
      </div>
    </template>
    <template #default="{ tiles }">
      <div class="tile-grid">
        <CityAllCard v-for="s in tiles" :key="s.id" :entry="s" :sections="sections" @pick="pick" />
      </div>
    </template>
  </GalleryShell>
</template>

<style scoped>
.kind-rows { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.kind-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
/* 類別總開關（Raw Maps / Map Adjust / Straighten / RWD Maps） */
.kind-master {
  flex-shrink: 0;
  min-width: 92px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 700;
  text-align: left;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.kind-master.all {
  background: hsl(var(--primary) / 0.18);
  border-color: hsl(var(--primary) / 0.6);
  color: hsl(var(--primary));
}
.kind-master.some {
  background: hsl(var(--primary) / 0.07);
  border-color: hsl(var(--primary) / 0.35);
  color: hsl(var(--primary));
}
/* 個別視圖勾選 */
.kind-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  color: hsl(var(--muted-foreground));
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.kind-check.on {
  background: hsl(var(--primary) / 0.12);
  border-color: hsl(var(--primary) / 0.5);
  color: hsl(var(--primary));
}
.kind-check input { accent-color: hsl(var(--primary)); margin: 0; }

.tile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-content: start;
}
@container (max-width: 720px) { .tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 460px) { .tile-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
