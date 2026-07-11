<script setup>
import { computed } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { Circle, Spline, Hexagon, Image as ImageIcon, TrainFront, X } from 'lucide-vue-next'

// Custom dockview tab: layer-type icon + title + close.
// Dockview tab props: { params: { layerId }, api, containerApi }
const props = defineProps({ params: { type: Object, required: true } })

const store = useMapStore()
// Tab renderer props may nest params one or two levels — read both shapes.
const p = computed(() => props.params ?? {})
const inner = computed(() => p.value.params ?? p.value)
const layerId = computed(() => inner.value.layerId ?? p.value.layerId)
const layer = computed(() => store.layers.find((l) => l.id === layerId.value) ?? null)

const typeIcons = { point: Circle, line: Spline, polygon: Hexagon, raster: ImageIcon, metro: TrainFront, d3: Spline }
const icon = computed(() => typeIcons[layer.value?.type] ?? Circle)
const title = computed(() =>
  layer.value?.name || inner.value.title || p.value.title || p.value.api?.title || layerId.value || '—')

function close(e) {
  e.stopPropagation()
  p.value.api?.close()
}
</script>

<template>
  <div class="dock-tab" @pointerdown.middle="close">
    <component :is="icon" :size="13" class="dock-tab-icon" />
    <span class="dock-tab-title">{{ title }}</span>
    <button class="dock-tab-close" title="Close" @click="close" @pointerdown.stop>
      <X :size="12" />
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
