<script setup>
import { computed } from 'vue'

// Per-tab view state ({ lng, lat, zoom, bearing, pitch, bounds }) from LayerTab.
const props = defineProps({ view: { type: Object, required: true } })

const coords = computed(() => {
  const { lng, lat } = props.view
  if (lng == null || lat == null) return '—'
  return `${lng.toFixed(5)}, ${lat.toFixed(5)}`
})
const bbox = computed(() => {
  const b = props.view.bounds
  if (!b) return '—'
  return b.map((v) => v.toFixed(4)).join(', ')
})
</script>

<template>
  <footer class="status-bar">
    <span>Coords: {{ coords }}</span>
    <span>Zoom: {{ view.zoom.toFixed(2) }}</span>
    <span class="bbox">BBox: {{ bbox }}</span>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 28px;
  flex-shrink: 0;
  padding: 0 12px;
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--muted) / 0.4);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
  overflow: hidden;
}
.bbox { overflow: hidden; text-overflow: ellipsis; margin-right: auto; }
@media (max-width: 900px) {
  .bbox { display: none; }
}
</style>
