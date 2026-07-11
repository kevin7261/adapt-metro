<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import MIcon from './MIcon.vue'

/* ---- Info dropdown ---- */
const infoOpen = ref(false)
const infoWrap = ref(null)
const relatedLinks = [
  { label: 'Metro systems (Wikipedia)', href: 'https://en.wikipedia.org/wiki/List_of_metro_systems' },
  { label: 'UrbanRail.net', href: 'https://www.urbanrail.net/' },
]

// Skills moved off the toolbar onto each layer row (see LayerPanel).

function onDocClick(e) {
  if (infoOpen.value && infoWrap.value && !infoWrap.value.contains(e.target)) {
    infoOpen.value = false
  }
}
function onKeydown(e) {
  if (e.key === 'Escape') infoOpen.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <header class="toolbar">
    <div class="brand">
      <MIcon name="map" :size="16" />
      <span class="brand-name">Adapt-Metro</span>
    </div>

    <div ref="infoWrap" class="skills-wrap info-wrap">
      <button class="btn-ghost" :class="{ active: infoOpen }" @click="infoOpen = !infoOpen">
        Info
      </button>
      <div v-if="infoOpen" class="menu-pop info-menu">
        <div class="menu-label">Related Links</div>
        <a
          v-for="link in relatedLinks"
          :key="link.href"
          class="menu-item"
          :href="link.href"
          target="_blank"
          rel="noopener noreferrer"
          @click="infoOpen = false"
        >
          <MIcon name="open_in_new" :size="14" /> {{ link.label }}
        </a>
      </div>
    </div>
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

.skills-wrap { position: relative; }
.info-wrap { margin-left: auto; }
.info-menu { top: 34px; right: 0; left: auto; min-width: 220px; }
.info-menu a.menu-item { text-decoration: none; color: inherit; }
</style>
