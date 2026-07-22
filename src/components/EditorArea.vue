<script setup>
import { onBeforeUnmount } from 'vue'
import { DockviewVue } from 'dockview-vue'
import { useMapStore } from '../stores/mapStore'
import { dockHandle, reopenTabById, sanitizeDockLayout } from '../stores/dockHandle'
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

  // 還原版面：優先 dockview toJSON（保留疊 tab／左右分裂／比例）。
  // 缺版面或有已刪圖層 → 退回 openTabIds，且後續 tab 用 beside 掛進同一 group
  // （連續 inactive addPanel 若不指定 position，activeGroup 為空會每個 tab 另開一組）。
  let restoredFromJson = false
  const layout = sanitizeDockLayout(store.dockLayout, store.layers)
  if (layout) {
    try {
      event.api.fromJSON(layout)
      restoredFromJson = true
    } catch {
      try { event.api.clear() } catch { /* */ }
    }
  }
  if (!restoredFromJson) {
    const focusId = store.activeTabId
      || store.selectedLayerId
      || store.layers[0]?.id
      || null
    if (Array.isArray(store.openTabIds)) {
      let beside = null
      for (const id of store.openTabIds) {
        reopenTabById(id, store.layers, {
          inactive: id !== focusId,
          beside,
        })
        if (!beside && event.api.getPanel(id)) beside = id
      }
    } else if (focusId) {
      reopenTabById(focusId, store.layers)
    }
    const activePanel = focusId && event.api.getPanel(focusId)
    if (activePanel) activePanel.api.setActive()
  }

  // Keep the persisted open-tab set / active tab / full dock layout in sync.
  // dockview 的 onDidActivePanelChange 事件是 { panel, origin }（不是 panel 本身）；
  // 同 group 內切 tab 有時不發此事件 → 各 tab 的 onDidActiveChange 才是準的
  // （LayerTab／D3Tab／AllGallery 各自 setActiveTab）。
  const syncOpenTabs = () => store.setOpenTabs(event.api.panels.map((pnl) => pnl.id))
  const syncLayout = () => {
    try { store.setDockLayout(event.api.toJSON()) } catch { /* empty / mid-teardown */ }
    syncOpenTabs()
  }
  event.api.onDidAddPanel(syncOpenTabs)
  event.api.onDidRemovePanel(syncOpenTabs)
  event.api.onDidActivePanelChange(({ panel }) => {
    if (panel?.id) store.setActiveTab(panel.id)
  })
  // 拖曳分裂／合併／調比例都走 layout change（debounced persist 由 App $subscribe）。
  event.api.onDidLayoutChange(syncLayout)
  relaxAll()
  syncLayout()
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
