<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { clearDataOverlay } from '../lib/dataOverlay'
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

/* ---- 重新計算（全城）----
   all      連環狀成方一起重做
   no-shape 成方相關全部不動，只重算一般路網
   dataflow 不成方，但有形狀的後續資料流一併重算
   僅 dev server 可用。 */
const RECOMPUTE_OPTS = {
  all: {
    label: '全部城市',
    hint: '全部重算含 LLM 成方（較久）',
    detail: '會重算所有城市的路網圖，並重新做環狀成方（較久）。',
  },
  'no-shape': {
    label: '全部城市不含成方',
    hint: '有成方的部分全部不動',
    detail: '只重算一般路網圖；成方結果與有形狀的圖一律不動。',
  },
  dataflow: {
    label: '全部城市・下游全重算',
    hint: '不重算 LLM 成方，但下游佈局全部重算',
    detail: '不成方結果；一般與有形狀圖層的下游佈局全部重算。',
  },
}
const recomputeOpen = ref(false)
const recomputeWrap = ref(null)
const recomputeBusy = ref(false)
const recomputeStep = ref('')
let recomputePoll = null

async function startRecompute(mode) {
  recomputeOpen.value = false
  if (recomputeBusy.value) return
  const opt = RECOMPUTE_OPTS[mode]
  if (!opt) return
  if (!confirm(`確定要重新計算「${opt.label}」？\n${opt.detail}`)) return
  recomputeBusy.value = true
  recomputeStep.value = '啟動中…'
  store.toast(`重新計算：${opt.label}…`)
  try {
    const res = await fetch('/metro-recompute/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    if (res.status === 404 || res.status === 405) {
      throw new Error('僅開發伺服器可用（npm run dev）')
    }
    if (res.status === 409) {
      store.toast('已有重新計算在進行中')
    } else if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.error || `HTTP ${res.status}`)
    }
    clearInterval(recomputePoll)
    recomputePoll = setInterval(pollRecompute, 2000)
    await pollRecompute()
  } catch (err) {
    recomputeBusy.value = false
    recomputeStep.value = ''
    store.toast(`重新計算失敗：${err.message || err}`)
  }
}

async function pollRecompute() {
  try {
    const res = await fetch('/metro-recompute/status')
    if (!res.ok) throw new Error(`status HTTP ${res.status}`)
    const j = await res.json()
    recomputeStep.value = j.step || ''
    if (j.running) return
    clearInterval(recomputePoll)
    recomputePoll = null
    recomputeBusy.value = false
    // 清瀏覽器 overlay，避免讀到舊 cells／縮圖
    clearDataOverlay('data/metro/')
    if (j.exit === 0) {
      store.toast('重新計算完成')
    } else {
      store.toast(`重新計算失敗：${j.error || '未知錯誤'}（見 terminal）`)
    }
    recomputeStep.value = ''
  } catch (err) {
    clearInterval(recomputePoll)
    recomputePoll = null
    recomputeBusy.value = false
    recomputeStep.value = ''
    store.toast(`重新計算狀態讀取失敗：${err.message || err}`)
  }
}

// 每列圖層有自己「計算用到」的 skill 選單（LayerPanel）；toolbar 的 Skills
// 按鈕開全部 skill 的 modal（DialogHost 'skills'）。

function onDocClick(e) {
  if (infoOpen.value && infoWrap.value && !infoWrap.value.contains(e.target)) {
    infoOpen.value = false
  }
  if (recomputeOpen.value && recomputeWrap.value && !recomputeWrap.value.contains(e.target)) {
    recomputeOpen.value = false
  }
}
function onKeydown(e) {
  if (e.key === 'Escape') {
    infoOpen.value = false
    recomputeOpen.value = false
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKeydown)
  clearInterval(recomputePoll)
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

    <!-- 右上：重新計算全部城市（畫廊＋cells；可選 LLM 成方）——與各圖層 StyleBar 右上「重新計算」對齊 -->
    <div ref="recomputeWrap" class="skills-wrap recompute-wrap">
      <button
        class="btn-ghost"
        :class="{ active: recomputeOpen || recomputeBusy }"
        :disabled="recomputeBusy"
        :title="recomputeBusy ? `重新計算中：${recomputeStep || '…'}` : '重新計算全部城市的路網圖'"
        @click="recomputeOpen = !recomputeOpen"
      >
        <MIcon v-if="recomputeBusy" name="progress_activity" :size="14" class="spin" />
        {{ recomputeBusy ? (recomputeStep || '重新計算中…') : '重新計算' }}
        <MIcon v-if="!recomputeBusy" name="expand_more" :size="14" />
      </button>
      <div v-if="recomputeOpen && !recomputeBusy" class="menu-pop recompute-menu">
        <div class="menu-label">重新計算全部城市</div>
        <button
          v-for="(opt, mode) in RECOMPUTE_OPTS"
          :key="mode"
          class="menu-item"
          @click="startRecompute(mode)"
        >
          <MIcon name="restart_alt" :size="14" />
          <span class="mi-col">
            <span>{{ opt.label }}</span>
            <span class="mi-hint">{{ opt.hint }}</span>
          </span>
        </button>
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
  padding: 6px 12px;
  flex-shrink: 0;
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--card));
}
.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  height: auto;
  padding: 0 10px 0 4px;
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: -0.025em;
  color: hsl(var(--foreground));
  white-space: nowrap;
  flex-shrink: 0;
  text-decoration: none;
  border-radius: 0;
  background: transparent;
  border: none;
}
.brand:hover { background: transparent; color: hsl(var(--foreground)); }
.brand :deep(.m-icon) { color: hsl(var(--primary)); }

.skills-link { margin-left: auto; }
.toolbar a.btn-ghost { text-decoration: none; }
.toolbar .btn-ghost {
  height: 32px;
  padding: 0 11px;
  border-radius: calc(var(--radius) + 2px);
  border: 1px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toolbar .btn-ghost:hover:not(:disabled) {
  border-color: hsl(var(--border));
  background: hsl(var(--card));
}
.toolbar .btn-ghost:disabled { opacity: 0.7; cursor: wait; }
.skills-wrap { position: relative; }
.info-menu { top: 36px; right: 0; left: auto; min-width: 220px; }
.info-menu a.menu-item { text-decoration: none; color: inherit; }
.recompute-menu { top: 36px; right: 0; left: auto; min-width: 300px; }
.mi-col { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mi-hint { font-size: 10.5px; color: hsl(var(--muted-foreground)); font-weight: 400; }
.spin { animation: tb-spin 0.9s linear infinite; }
@keyframes tb-spin { to { transform: rotate(360deg); } }
</style>
