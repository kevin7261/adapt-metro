<script setup>
import { onBeforeUnmount } from 'vue'
import { DockviewVue } from 'dockview-vue'
import { useMapStore } from '../stores/mapStore'
import { dockHandle, openLayerTab } from '../stores/dockHandle'
import LayerTab from './LayerTab.vue'
import D3Tab from './D3Tab.vue'
import MetroGallery from './MetroGallery.vue'
import MapAdjustGallery from './MapAdjustGallery.vue'
import HillClimbGallery from './HillClimbGallery.vue'
import RwdGallery from './RwdGallery.vue'
import DockTab from './DockTab.vue'
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

  // 放寬面板分隔線的拖曳極限：dockview group 預設最小尺寸 ~100px，會讓分隔線拖不到底。
  // 把「所有」group 的最小寬高降到 20px（留一小條、不完全越過相鄰面板）——並在每次版面
  // 變動（新增 group／分割／移動）後重設一次，確保初始 group 與之後新建的都吃到。
  const relaxAll = () => {
    for (const g of event.api.groups) {
      try { g.api.setConstraints({ minimumWidth: 20, minimumHeight: 20, maximumWidth: Number.MAX_SAFE_INTEGER, maximumHeight: Number.MAX_SAFE_INTEGER }) } catch { /* older api */ }
    }
  }
  relaxAll()
  event.api.onDidAddGroup(relaxAll)
  event.api.onDidLayoutChange(relaxAll)

  // NOTE: "selected layer" is kept in sync with the active tab by each LayerTab
  // via its per-panel onDidActiveChange — dockview 7's api.onDidActivePanelChange
  // is mis-wired to group changes and won't fire on same-group tab switches.

  // Re-open a tab for every persisted layer, then focus the selected one
  // (openLayerTab focuses instead of duplicating if the panel already exists).
  for (const l of store.layers) openLayerTab(l)
  const sel = store.layers.find((l) => l.id === store.selectedLayerId) ?? store.layers[0]
  if (sel) openLayerTab(sel)
}

onBeforeUnmount(() => { dockHandle.api = null })
</script>

<template>
  <DockviewVue
    class="editor-dock"
    :components="{ 'layer-tab': LayerTab, 'd3-tab': D3Tab, 'metro-gallery': MetroGallery, 'map-adjust-gallery': MapAdjustGallery, 'hill-climb-gallery': HillClimbGallery, 'rwd-gallery': RwdGallery }"
    :default-tab-component="DockTab"
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
