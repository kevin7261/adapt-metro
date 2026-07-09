<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: [Object, Function], default: null },
  items: { type: Array, required: true },
})
const emit = defineEmits(['action'])

const open = ref(false)
const openSub = ref(null)
const root = ref(null)

function onDocClick(e) {
  if (root.value && !root.value.contains(e.target)) {
    open.value = false
    openSub.value = null
  }
}
onMounted(() => document.addEventListener('mousedown', onDocClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))

function toggle() {
  open.value = !open.value
  openSub.value = null
}
function run(item) {
  if (item.children) return
  open.value = false
  openSub.value = null
  emit('action', item)
}
</script>

<template>
  <div ref="root" class="menu-root">
    <button class="btn-ghost" :class="{ active: open }" @click="toggle">
      <component :is="icon" v-if="icon" :size="14" />
      <span class="menu-btn-label">{{ label }}</span>
    </button>

    <div v-if="open" class="menu-pop menu-below">
      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.type === 'separator'" class="menu-sep" />
        <div v-else-if="item.type === 'label'" class="menu-label">{{ item.label }}</div>
        <div
          v-else
          class="sub-wrap"
          @mouseenter="openSub = item.children ? i : null"
        >
          <button
            class="menu-item"
            :class="{ open: openSub === i }"
            @click="run(item)"
          >
            <component :is="item.icon" v-if="item.icon" :size="14" class="mi-icon" />
            <span>{{ item.label }}</span>
            <span v-if="item.shortcut" class="shortcut">{{ item.shortcut }}</span>
            <ChevronRight v-if="item.children" :size="13" class="sub-arrow" />
          </button>
          <div v-if="item.children && openSub === i" class="menu-pop submenu">
            <template v-for="(sub, j) in item.children" :key="j">
              <div v-if="sub.type === 'separator'" class="menu-sep" />
              <div v-else-if="sub.type === 'label'" class="menu-label">{{ sub.label }}</div>
              <button v-else class="menu-item" @click="run(sub)">
                <component :is="sub.icon" v-if="sub.icon" :size="14" class="mi-icon" />
                <span>{{ sub.label }}</span>
                <span v-if="sub.shortcut" class="shortcut">{{ sub.shortcut }}</span>
              </button>
            </template>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.menu-root { position: relative; }
.menu-below { top: calc(100% + 4px); left: 0; }
.sub-wrap { position: relative; }
.submenu {
  top: -5px;
  left: calc(100% + 2px);
  max-height: 60vh;
  overflow-y: auto;
}
.mi-icon { color: hsl(var(--muted-foreground)); flex-shrink: 0; }
@media (max-width: 900px) {
  .menu-btn-label { display: none; }
}
</style>
