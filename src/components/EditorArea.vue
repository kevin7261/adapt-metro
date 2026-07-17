<script setup>
import { onBeforeUnmount, watch } from 'vue'
import { DockviewVue } from 'dockview-vue'
import { useMapStore } from '../stores/mapStore'
import { dockHandle, openLayerTab, reopenTabById } from '../stores/dockHandle'
import LayerTab from './LayerTab.vue'
import D3Tab from './D3Tab.vue'
import AllGallery from './AllGallery.vue'
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

  // Restore exactly the tabs that were open last time (layer tabs + the 視圖畫廊
  // fixed tab), in their saved order. `openTabIds === null` = a session from
  // before tab-persistence existed → fall back to opening every layer. An empty
  // array means the user had all tabs closed — honour that (open nothing).
  if (Array.isArray(store.openTabIds)) {
    for (const id of store.openTabIds) reopenTabById(id, store.layers)
  } else {
    for (const l of store.layers) openLayerTab(l)
    const sel = store.layers.find((l) => l.id === store.selectedLayerId) ?? store.layers[0]
    if (sel) openLayerTab(sel)
  }
  // Focus the previously-active tab if it is open (openLayerTab already focuses
  // the last legacy tab; dockview auto-activates the last-added panel otherwise).
  const activePanel = store.activeTabId && event.api.getPanel(store.activeTabId)
  if (activePanel) activePanel.api.setActive()

  // Keep the persisted open-tab set / active tab in sync with the live dockview.
  const syncOpenTabs = () => store.setOpenTabs(event.api.panels.map((pnl) => pnl.id))
  event.api.onDidAddPanel(syncOpenTabs)
  event.api.onDidRemovePanel(syncOpenTabs)
  event.api.onDidActivePanelChange((pnl) => store.setActiveTab(pnl?.id))
  syncOpenTabs()
}

// Layer tabs update selectedLayerId on activation (incl. same-group switches,
// which onDidActivePanelChange misses) — mirror that into activeTabId.
watch(() => store.selectedLayerId, (id) => store.setActiveTab(id))

onBeforeUnmount(() => { dockHandle.api = null })
</script>

<template>
  <DockviewVue
    class="editor-dock"
    :components="{ 'layer-tab': LayerTab, 'd3-tab': D3Tab, 'all-gallery': AllGallery }"
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
