<script setup>
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useMapStore } from './stores/mapStore'
import { schedulePersist, restoreLayerData } from './stores/persist'
import TopToolbar from './components/TopToolbar.vue'
import LayerPanel from './components/LayerPanel.vue'
import EditorArea from './components/EditorArea.vue'
import CommandPalette from './components/CommandPalette.vue'
import DialogHost from './components/DialogHost.vue'
import SkillViewer from './components/SkillViewer.vue'

const store = useMapStore()

// Re-seed imported-file data before the dock opens its tabs, then persist the
// session (layers + settings) to localStorage on every change (debounced).
restoreLayerData()
store.$subscribe(() => schedulePersist(store))

watch(
  () => store.dark,
  (dark) => document.documentElement.classList.toggle('dark', dark),
  { immediate: true },
)
watch(
  () => store.accent,
  (accent) => {
    if (accent === 'blue') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = accent
  },
  { immediate: true },
)

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    store.ui.commandPalette = !store.ui.commandPalette
  } else if (e.key === 'Escape') {
    store.ui.commandPalette = false
    store.ui.dialog = null
  } else if (e.key === '?' && !isTyping(e)) {
    store.ui.dialog = 'shortcuts'
  }
}
function isTyping(e) {
  const t = e.target
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="shell">
    <TopToolbar />
    <div class="workspace">
      <LayerPanel />
      <main class="map-main">
        <EditorArea />
      </main>
    </div>

    <CommandPalette v-if="store.ui.commandPalette" />
    <DialogHost />
    <SkillViewer />

    <Transition name="toast">
      <div v-if="store.ui.toast" class="toast">{{ store.ui.toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: hsl(var(--background));
}
.workspace {
  display: flex;
  flex: 1;
  min-height: 0;
}
.map-main {
  position: relative;
  isolation: isolate;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.toast {
  position: absolute;
  bottom: 44px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 400;
  background: hsl(var(--popover));
  color: hsl(var(--popover-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  padding: 8px 18px;
  font-size: 13px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  white-space: nowrap;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }
</style>
