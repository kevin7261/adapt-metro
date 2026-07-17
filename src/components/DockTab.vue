<script setup>
import { computed } from 'vue'
import { useMapStore } from '../stores/mapStore'
import MIcon from './MIcon.vue'

// Custom dockview tab: layer-type icon + title + close.
// Dockview tab props: { params: { layerId }, api, containerApi }
const props = defineProps({ params: { type: Object, required: true } })

const store = useMapStore()
// Tab renderer props may nest params one or two levels — read both shapes.
const p = computed(() => props.params ?? {})
const inner = computed(() => p.value.params ?? p.value)
const layerId = computed(() => inner.value.layerId ?? p.value.layerId)
const layer = computed(() => store.layers.find((l) => l.id === layerId.value) ?? null)

// Keep in sync with LayerPanel.vue's typeIcons so a layer shows the same glyph
// in its dock tab and in the layer list (hillclimb/rwd were missing → fell back
// to 'circle' in the tab while the panel showed terrain/route).
const typeIcons = { point: 'circle', line: 'polyline', polygon: 'hexagon', raster: 'image', metro: 'train', d3: 'polyline', hillclimb: 'terrain', rwd: 'route' }
// Gallery panels have no layer — derive their icon from the panel id (always
// known by dockview, so it works even for panels opened before params gained an
// icon).
const GALLERY_ICON = { 'all-gallery': 'grid_view' }
const panelId = computed(() => p.value.api?.id ?? inner.value.id)
const icon = computed(() =>
  typeIcons[layer.value?.type] ?? GALLERY_ICON[panelId.value] ?? inner.value.icon ?? p.value.icon ?? 'circle')
// 圈層一城一群組後，同一城市的管線圖層同名（城市名，Straighten/RWD 另帶變體）
// ——tab 標題附上階段以便區分。RWD 一城 10 個（變體 × 5 鏈），再附上鏈名。
const STAGE_SUFFIX = { d3: 'Map Adjust', hillclimb: 'Straighten', rwd: 'RWD' }
const RWD_COMPACT_ZH = { rect: '直角爬山', align: '軸對齊', ilp: '整數規劃', llm: 'LLM 對齊', hc: '基本' }
const title = computed(() => {
  const l = layer.value
  if (l) {
    if (l.type === 'rwd') return `${l.name} · RWD（${RWD_COMPACT_ZH[l.compact ?? 'hc']}）`
    return STAGE_SUFFIX[l.type] ? `${l.name} · ${STAGE_SUFFIX[l.type]}` : l.name
  }
  return inner.value.title || p.value.title || p.value.api?.title || layerId.value || '—'
})

function close(e) {
  e.stopPropagation()
  p.value.api?.close()
}
</script>

<template>
  <div class="dock-tab" @pointerdown.middle="close">
    <MIcon :name="icon" :size="13" class="dock-tab-icon" />
    <span class="dock-tab-title">{{ title }}</span>
    <button class="dock-tab-close" title="Close" @click="close" @pointerdown.stop>
      <MIcon name="close" :size="12" />
    </button>
  </div>
</template>

<style scoped>
.dock-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 4px;
  min-width: 0;
}
.dock-tab-icon { flex-shrink: 0; color: hsl(var(--primary)); }
.dock-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.dock-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 4px;
  color: hsl(var(--muted-foreground));
  opacity: 0;
}
.dock-tab:hover .dock-tab-close { opacity: 1; }
.dock-tab-close:hover { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
</style>
