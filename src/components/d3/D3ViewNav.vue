<script setup>
import { ref, watch } from 'vue'
import MIcon from '../MIcon.vue'
import { dragResize } from '../../lib/dragResize'
import { openLayerDoc } from '../../stores/layerDocHandle'
import { useMediaQuery } from '../../lib/useMediaQuery'

const props = defineProps({
  sections: { type: Array, required: true },
  mode: { type: String, required: true },
  panelLayer: { type: Object, default: null },
  canRotate: { type: Boolean, default: true },
})

const emit = defineEmits(['update:mode'])

// Left view-list rail width — draggable via the divider (canvas re-renders on
// resize through the ResizeObserver on host).
const viewNavWidth = ref(132)
const navDragging = ref(false)
const narrowUi = useMediaQuery('(max-width: 768px)')
const navOpenDrawer = ref(false)
watch(narrowUi, (n) => {
  if (n) {
    navOpenDrawer.value = false
    if (viewNavWidth.value > 160) viewNavWidth.value = 148
  }
})

function startNavResize(e) {
  e.preventDefault()
  const startW = viewNavWidth.value
  // 拖到極限：上限＝容器寬 − 留給畫布的一小條；下限縮到很小；不設固定 90/300。
  const host = e.currentTarget?.parentElement
  dragResize(e, {
    dragging: navDragging,
    onMove: (dx) => {
      const maxW = host ? Math.max(90, host.clientWidth - 80) : 600
      viewNavWidth.value = Math.min(maxW, Math.max(40, startW + dx))
    },
  })
}

// 左側功能列分組可開合（使用者規則：不用全部展開）。sections 依 header 收成
// sections；預設收合、只展開「含目前視圖」的那一組，點 header 切換。
// navOpen 只記使用者手動切換過的組（true/false），沒記錄的走預設。
const navOpen = ref({})
const navSectionOpen = (s) =>
  !s.header || (navOpen.value[s.header] ?? s.items.some((t) => t.id === props.mode))

function toggleNavSection(s) {
  if (s.header) navOpen.value[s.header] = !navSectionOpen(s)
}

function pickMode(id) {
  emit('update:mode', id)
  if (narrowUi.value) navOpenDrawer.value = false
}
</script>

<template>
  <button
    v-if="narrowUi && !navOpenDrawer"
    type="button"
    class="btn-ghost view-nav-fab"
    title="開啟視圖清單"
    @click="navOpenDrawer = true"
  >
    <MIcon name="view_list" :size="15" /> 視圖
  </button>
  <button
    v-if="narrowUi && navOpenDrawer"
    type="button"
    class="rwd-scrim view-nav-scrim"
    aria-label="關閉視圖清單"
    @click="navOpenDrawer = false"
  />
  <div
    v-if="!narrowUi || navOpenDrawer"
    class="view-nav"
    :class="{ 'view-nav--drawer': narrowUi }"
    :style="{ width: viewNavWidth + 'px' }"
    role="tablist"
  >
    <div
      v-for="s in sections"
      :key="s.header ?? 'flat'"
      class="view-nav-sec"
      :class="{ open: navSectionOpen(s), flat: !s.header }"
    >
      <button
        v-if="s.header"
        class="view-nav-group"
        :aria-expanded="navSectionOpen(s)"
        @click="toggleNavSection(s)"
      >
        <MIcon
          :name="navSectionOpen(s) ? 'expand_more' : 'chevron_right'"
          :size="14"
          class="view-nav-caret"
        />
        <span class="view-nav-group-label">{{ s.header }}</span>
        <MIcon
          v-if="s.doc"
          name="help"
          :size="14"
          class="view-nav-help"
          role="button"
          title="這個圖層的做法／JSON 格式／顯示方式"
          @click.stop="openLayerDoc(s.doc, s.header)"
        />
      </button>
      <div v-if="navSectionOpen(s)" class="view-nav-sec-items">
        <button
          v-for="t in s.items"
          :key="t.id"
          class="view-nav-item"
          :class="{ active: mode === t.id }"
          role="tab"
          :aria-selected="mode === t.id"
          :disabled="!panelLayer || (t.rot && !canRotate) || !!t.disabled"
          :title="t.disabled ? '此城市未規定形狀計算（不需計算）' : (t.rot && !canRotate ? '網路已對齊正南北，無需旋轉' : '')"
          @click="pickMode(t.id)"
        >{{ t.label }}</button>
      </div>
    </div>
  </div>
  <div
    v-if="!narrowUi"
    class="view-nav-resize"
    :class="{ dragging: navDragging }"
    role="separator"
    aria-orientation="vertical"
    @pointerdown="startNavResize"
  />
</template>

<style scoped>
.view-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
  padding: 6px;
  overflow-y: auto;
  background: hsl(var(--card));
}
.view-nav-fab {
  position: absolute;
  z-index: 28;
  top: 8px;
  left: 8px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--card) / 0.94);
  box-shadow: var(--shadow);
}
.view-nav-scrim { z-index: 29; position: absolute; inset: 0; }
.view-nav--drawer {
  position: absolute;
  z-index: 30;
  top: 0;
  left: 0;
  bottom: 0;
  max-width: min(220px, 78vw);
  box-shadow: var(--shadow-lg);
  border-right: 1px solid hsl(var(--border));
}
/* 分組（原始／Hill Climbing／直線演算法／…）——全部左側功能列共用同一套版面：
   header 一列（caret＋標題＋項目數 badge）可開合，展開的項目縮排並帶樹狀導引線。 */
.view-nav-sec {
  flex-shrink: 0; /* view 很多時不被壓扁——超出改由 .view-nav 的捲軸承接 */
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.view-nav-sec:not(:first-child):not(.flat) {
  margin-top: 3px;
  padding-top: 3px;
  border-top: 1px solid hsl(var(--border) / 0.5);
}
.view-nav-group {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 6px 8px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: hsl(var(--muted-foreground));
  user-select: none;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.view-nav-group:hover { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
/* 同 Layers 面板的 group-chevron（MIcon chevron_right / expand_more, 14px）。 */
.view-nav-caret {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}
.view-nav-group-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 「?」說明 icon：平時淡、hover 才亮，點了開 LayerDocViewer（不影響展開） */
.view-nav-help {
  flex-shrink: 0;
  opacity: 0.45;
  color: hsl(var(--muted-foreground));
  cursor: help;
  border-radius: 50%;
}
.view-nav-help:hover { opacity: 1; color: hsl(var(--primary)); }
/* 展開的項目：縮排到 caret 之下、左側一條導引線。flat（無 header 的清單，
   理論上已不存在）不縮排。 */
.view-nav-sec-items {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-left: 14px;
  padding-left: 5px;
  border-left: 1px solid hsl(var(--border) / 0.7);
}
.view-nav-sec.flat .view-nav-sec-items {
  margin-left: 0;
  padding-left: 0;
  border-left: none;
}
/* Draggable divider between the view list and the canvas. */
.view-nav-resize {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  border-left: 1px solid hsl(var(--border));
  background: transparent;
}
.view-nav-resize:hover, .view-nav-resize.dragging { background: hsl(var(--primary) / 0.3); }
.view-nav-item {
  flex-shrink: 0; /* view 很多時不被壓扁——超出改由 .view-nav 的捲軸承接 */
  text-align: left;
  padding: 6px 10px;
  font-size: 12.5px;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.view-nav-item:hover:not(:disabled) { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
.view-nav-item.active {
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
  font-weight: 600;
}
.view-nav-item:disabled { opacity: 0.4; cursor: default; }
</style>
