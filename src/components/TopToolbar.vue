<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import MIcon from './MIcon.vue'

const store = useMapStore()

// Brand links to the app root — clicking reloads the whole app (fresh session,
// re-applies store migrations + data localisation). BASE_URL matches the Vite
// base (GitHub Pages: /adapt-metro/).
const homeUrl = import.meta.env.BASE_URL
const slidesUrl = `${import.meta.env.BASE_URL}slides/`

/* ---- Info dropdown ---- */
const infoOpen = ref(false)
const infoWrap = ref(null)
const relatedLinks = [
  { label: 'Metro systems (Wikipedia)', href: 'https://en.wikipedia.org/wiki/List_of_metro_systems' },
  { label: 'UrbanRail.net', href: 'https://www.urbanrail.net/' },
]

// 每列圖層有自己「計算用到」的 skill 選單（LayerPanel）；toolbar 的 Skills
// 按鈕開全部 skill 的 modal（DialogHost 'skills'）。

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
    <a class="brand" :href="homeUrl" title="重新載入">
      <MIcon name="map" :size="16" />
      <span class="brand-name">Adapt-Metro</span>
    </a>

    <!-- Skills：所有 skill 的總覽 modal -->
    <button class="btn-ghost skills-link" @click="store.ui.dialog = 'skills'">Skills</button>

    <a class="btn-ghost" :href="slidesUrl">系統介紹</a>

    <div ref="infoWrap" class="skills-wrap info-wrap">
      <button class="btn-ghost" :class="{ active: infoOpen }" @click="infoOpen = !infoOpen">
        相關連結
      </button>
      <div v-if="infoOpen" class="menu-pop info-menu">
        <div class="menu-label">相關連結</div>
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
  gap: 2px;
  min-height: 40px;
  padding: 4px 10px;
  flex-shrink: 0;
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--card));
}
.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px 0 2px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: hsl(var(--foreground));
  white-space: nowrap;
  flex-shrink: 0;
  text-decoration: none;
  border-radius: calc(var(--radius) - 2px);
}
.brand:hover { background: hsl(var(--accent)); }
.brand :deep(.m-icon) { color: hsl(var(--primary)); }

.skills-link { margin-left: auto; }
.toolbar a.btn-ghost { text-decoration: none; }
.skills-wrap { position: relative; }
.info-menu { top: 32px; right: 0; left: auto; min-width: 220px; }
.info-menu a.menu-item { text-decoration: none; color: inherit; }
</style>
