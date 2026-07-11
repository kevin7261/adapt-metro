<script setup>
import { ref, computed, onMounted } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import MIcon from './MIcon.vue'

const store = useMapStore()

const query = ref('')
const activeIdx = ref(0)
const inputEl = ref(null)

const commands = [
  { group: 'Project', title: 'New Project…', icon: 'note_add', run: () => (store.ui.dialog = 'new-project') },
  { group: 'Project', title: 'Save Project', icon: 'save', shortcut: '⌘S', run: () => store.fake('Save') },
  { group: 'Project', title: 'Share Project…', icon: 'share', run: () => store.fake('Share') },
  { group: 'Add Data', title: 'Add Vector Layer…', icon: 'data_object', run: () => (store.ui.dialog = 'add-data') },
  { group: 'Add Data', title: 'Add WMS / WMTS…', icon: 'dns', run: () => (store.ui.dialog = 'add-data') },
  { group: 'Add Data', title: 'Add PMTiles…', icon: 'stacks', run: () => (store.ui.dialog = 'add-data') },
  { group: 'View', title: 'Zoom In', icon: 'zoom_in', run: () => mapHandle.map?.zoomIn() },
  { group: 'View', title: 'Zoom Out', icon: 'zoom_out', run: () => mapHandle.map?.zoomOut() },
  { group: 'View', title: 'Reset Orientation', icon: 'explore', shortcut: 'N', run: () => mapHandle.map?.resetNorth() },
  { group: 'View', title: 'Toggle Dark Mode', icon: 'light_mode', run: () => (store.dark = !store.dark) },
  { group: 'Controls', title: 'Measure', icon: 'straighten', run: () => store.fake('Measure') },
  { group: 'Controls', title: 'Bookmark', icon: 'bookmark', run: () => store.fake('Bookmark') },
  { group: 'Processing', title: 'SQL Workspace', icon: 'terminal', run: () => store.fake('SQL Workspace') },
  { group: 'Processing', title: 'Assistant (AI)', icon: 'auto_awesome', run: () => store.fake('Assistant') },
  { group: 'Processing', title: 'Dashboard', icon: 'dashboard', run: () => store.fake('Dashboard') },
  { group: 'Panels', title: 'Toggle Attribute Table', icon: 'table', run: () => store.toggleAttributeTable(store.selectedLayerId) },
  { group: 'Settings', title: 'Open Settings', icon: 'settings', run: () => (store.ui.dialog = 'settings') },
  { group: 'Help', title: 'Keyboard Shortcuts', icon: 'keyboard', shortcut: '?', run: () => (store.ui.dialog = 'shortcuts') },
  { group: 'Help', title: 'About', icon: 'info', run: () => (store.ui.dialog = 'about') },
]

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return commands
  return commands.filter(
    (c) => c.title.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
  )
})

const grouped = computed(() => {
  const out = []
  let last = null
  filtered.value.forEach((c) => {
    if (c.group !== last) {
      out.push({ type: 'group', label: c.group })
      last = c.group
    }
    out.push({ type: 'cmd', cmd: c, idx: filtered.value.indexOf(c) })
  })
  return out
})

function run(cmd) {
  store.ui.commandPalette = false
  cmd.run()
}

function onKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = Math.min(filtered.value.length - 1, activeIdx.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = Math.max(0, activeIdx.value - 1)
  } else if (e.key === 'Enter') {
    const cmd = filtered.value[activeIdx.value]
    if (cmd) run(cmd)
  }
}

onMounted(() => inputEl.value?.focus())
</script>

<template>
  <div class="palette-overlay" @mousedown.self="store.ui.commandPalette = false">
    <div class="palette">
      <div class="palette-input-row">
        <MIcon name="search" :size="15" class="search-icon" />
        <input
          ref="inputEl"
          v-model="query"
          class="palette-input"
          placeholder="Type a command or search…"
          @input="activeIdx = 0"
          @keydown="onKey"
        />
        <kbd>esc</kbd>
      </div>
      <div class="palette-list">
        <template v-for="(item, i) in grouped" :key="i">
          <div v-if="item.type === 'group'" class="menu-label">{{ item.label }}</div>
          <button
            v-else
            class="menu-item"
            :class="{ open: item.idx === activeIdx }"
            @mouseenter="activeIdx = item.idx"
            @click="run(item.cmd)"
          >
            <MIcon :name="item.cmd.icon" :size="14" class="cmd-icon" />
            <span>{{ item.cmd.title }}</span>
            <span v-if="item.cmd.shortcut" class="shortcut">{{ item.cmd.shortcut }}</span>
          </button>
        </template>
        <div v-if="!filtered.length" class="empty">No matching commands</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 350;
  background: rgb(0 0 0 / 0.4);
  display: flex;
  justify-content: center;
  padding-top: 12vh;
}
.palette {
  width: min(560px, calc(100vw - 32px));
  max-height: 60vh;
  background: hsl(var(--popover));
  color: hsl(var(--popover-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  box-shadow: 0 16px 48px rgb(0 0 0 / 0.35);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
}
.palette-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid hsl(var(--border));
}
.search-icon { color: hsl(var(--muted-foreground)); }
.palette-input {
  flex: 1;
  border: none;
  background: transparent;
  color: hsl(var(--foreground));
  font-size: 14px;
}
.palette-input:focus { outline: none; }
kbd {
  font-size: 10px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: 4px;
  padding: 2px 5px;
}
.palette-list { overflow-y: auto; padding: 4px; }
.cmd-icon { color: hsl(var(--muted-foreground)); }
.empty {
  padding: 20px;
  text-align: center;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
}
</style>
