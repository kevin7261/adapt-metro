<script setup>
import { computed } from 'vue'
import { store } from '../store'
import { Bug } from 'lucide-vue-next'

const coords = computed(() => {
  const { lng, lat } = store.map
  if (lng == null || lat == null) return '—'
  return `${lng.toFixed(5)}, ${lat.toFixed(5)}`
})
const bbox = computed(() => {
  const b = store.map.bounds
  if (!b) return '—'
  return b.map((v) => v.toFixed(4)).join(', ')
})
</script>

<template>
  <footer class="status-bar">
    <span>Coords: {{ coords }}</span>
    <span>Zoom: {{ store.map.zoom.toFixed(2) }}</span>
    <span>Bearing: {{ store.map.bearing.toFixed(1) }}°</span>
    <span>Pitch: {{ store.map.pitch.toFixed(1) }}°</span>
    <span class="bbox">BBox: {{ bbox }}</span>
    <button class="diag" @click="store.fake('Diagnostics')">
      <Bug :size="12" />
      <span>0</span>
    </button>
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
.bbox { overflow: hidden; text-overflow: ellipsis; }
.diag {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: hsl(var(--muted-foreground));
  font-family: inherit;
  font-size: inherit;
  padding: 2px 6px;
  border-radius: calc(var(--radius) - 4px);
  flex-shrink: 0;
}
.diag:hover { background: hsl(var(--accent)); }
@media (max-width: 900px) {
  .bbox { display: none; }
}
</style>
