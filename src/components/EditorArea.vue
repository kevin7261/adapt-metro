<script setup>
import { onBeforeUnmount } from 'vue'
import { DockviewVue } from 'dockview-vue'
import { useMapStore } from '../stores/mapStore'
import { dockHandle, openLayerTab } from '../stores/dockHandle'
import LayerTab from './LayerTab.vue'
import DockWatermark from './DockWatermark.vue'

const store = useMapStore()

// Custom theme: CSS variables live in style.css (.dockview-theme-adapt)
// and follow the app tokens, so dark/light/accent switching just works.
const theme = {
  name: 'adapt',
  className: 'dockview-theme-adapt',
  gap: 0,
  dndTabIndicator: 'fill',
}

function onReady(event) {
  dockHandle.api = event.api

  // NOTE: "selected layer" is kept in sync with the active tab by each LayerTab
  // via its per-panel onDidActiveChange — dockview 7's api.onDidActivePanelChange
  // is mis-wired to group changes and won't fire on same-group tab switches.

  // Open the initial tab.
  const first = store.layers.find((l) => l.id === store.selectedLayerId) ?? store.layers[0]
  openLayerTab(first)
}

onBeforeUnmount(() => { dockHandle.api = null })
</script>

<template>
  <DockviewVue
    class="editor-dock"
    :components="{ 'layer-tab': LayerTab }"
    :watermark-component="DockWatermark"
    :theme="theme"
    @ready="onReady"
  />
</template>

<style scoped>
.editor-dock {
  width: 100%;
  height: 100%;
}
</style>
