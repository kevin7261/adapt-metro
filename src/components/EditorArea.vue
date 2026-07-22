<script setup>
import { onBeforeUnmount } from 'vue'
import { DockviewVue } from 'dockview-vue'
import { useMapStore } from '../stores/mapStore'
import { dockHandle, reopenTabById } from '../stores/dockHandle'
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

  // Restore exactly the tabs that were open last time (layer tabs + the 視圖畫廊
  // fixed tab), in their saved order. Non-active tabs open as `inactive` so
  // only the focused panel mounts MapLibre / D3 / gallery（否則一城鏈十幾個 tab
  // 全用 renderer:always 會把啟動拖到十幾秒）。`openTabIds === null` = legacy
  // → 只開選中那個，不掃全部圖層。空陣列＝上次全關 → 什麼都不開。
  const focusId = store.activeTabId
    || store.selectedLayerId
    || store.layers[0]?.id
    || null
  if (Array.isArray(store.openTabIds)) {
    for (const id of store.openTabIds) {
      reopenTabById(id, store.layers, { inactive: id !== focusId })
    }
  } else if (focusId) {
    reopenTabById(focusId, store.layers)
  }
  const activePanel = focusId && event.api.getPanel(focusId)
  if (activePanel) activePanel.api.setActive()

  // Keep the persisted open-tab set / active tab in sync with the live dockview.
  // dockview 的 onDidActivePanelChange 事件是 { panel, origin }（不是 panel 本身）；
  // 同 group 內切 tab 有時不發此事件 → 各 tab 的 onDidActiveChange 才是準的
  // （LayerTab／D3Tab／AllGallery 各自 setActiveTab）。
  const syncOpenTabs = () => store.setOpenTabs(event.api.panels.map((pnl) => pnl.id))
  event.api.onDidAddPanel(syncOpenTabs)
  event.api.onDidRemovePanel(syncOpenTabs)
  event.api.onDidActivePanelChange(({ panel }) => {
    if (panel?.id) store.setActiveTab(panel.id)
  })
  syncOpenTabs()
}

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
