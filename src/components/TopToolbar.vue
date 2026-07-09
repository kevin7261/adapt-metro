<script setup>
import { useMapStore } from '../stores/mapStore'
import { Map as MapIcon, TrainFront } from 'lucide-vue-next'

const store = useMapStore()
</script>

<template>
  <header class="toolbar">
    <div class="brand">
      <MapIcon :size="16" />
      <span class="brand-name">Adapt-Metro</span>
    </div>

    <button class="btn-ghost" @click="store.ui.dialog = 'import-metro'">
      <TrainFront :size="14" />
      Import Metro Map
    </button>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 4px 8px;
  flex-shrink: 0;
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--card));
}
.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: hsl(var(--primary));
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
