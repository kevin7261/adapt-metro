<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import MIcon from './MIcon.vue'
import { layerDoc, closeLayerDoc } from '../stores/layerDocHandle'
import { LAYER_DOCS } from '../stores/layerDocs'
import { openSkillDoc } from '../stores/skillHandle'

const doc = computed(() => (layerDoc.key ? LAYER_DOCS[layerDoc.key] : null))
// 標題＝使用者點的那個圖層/區塊的名字（無描述性副標、無 tag，使用者要求）。
const headTitle = computed(() => layerDoc.title || doc.value?.title || '')
const tab = ref('show') // 'show' 顯示與資料 | 'algo' 演算法
const TABS = [
  { id: 'show', label: '顯示與資料' },
  { id: 'algo', label: '演算法' },
]
// reset to the first tab whenever a different layer opens
watch(() => layerDoc.key, () => { tab.value = 'show' })

// Legend swatch — a tiny inline SVG per mark type (dot/line/dash/area/ring).
function markSvg(g) {
  const c = g.c
  switch (g.t) {
    case 'line': return `<svg viewBox="0 0 22 12"><line x1="1" y1="6" x2="21" y2="6" stroke="${c}" stroke-width="3" stroke-linecap="round"/></svg>`
    case 'dash': return `<svg viewBox="0 0 22 12"><line x1="1" y1="6" x2="21" y2="6" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 3"/></svg>`
    case 'area': return `<svg viewBox="0 0 22 12"><rect x="1" y="1.5" width="20" height="9" rx="2" fill="${c}" fill-opacity="0.45" stroke="${c}"/></svg>`
    case 'ring': return `<svg viewBox="0 0 22 12"><circle cx="11" cy="6" r="4" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="2.4 1.8"/></svg>`
    default: return `<svg viewBox="0 0 22 12"><circle cx="11" cy="6" r="4.2" fill="${c}" stroke="#0a1020" stroke-width="1"/></svg>`
  }
}

function openSkill(id) { closeLayerDoc(); openSkillDoc(id) }
function onKeydown(e) { if (e.key === 'Escape') closeLayerDoc() }
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="doc" class="dialog-overlay" @mousedown.self="closeLayerDoc">
    <div class="dialog layerdoc-dialog">
      <div class="dialog-header">
        <h2 class="dialog-title layerdoc-title">
          <MIcon name="help" :size="15" />
          <span>{{ headTitle }}</span>
        </h2>
        <button class="btn-icon" @click="closeLayerDoc"><MIcon name="close" :size="15" /></button>
      </div>

      <div class="dialog-tabs" role="tablist">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="dialog-tab"
          :class="{ active: tab === t.id }"
          role="tab"
          :aria-selected="tab === t.id"
          @click="tab = t.id"
        >{{ t.label }}</button>
      </div>

      <div class="dialog-body layerdoc-body">
        <!-- Tab 1：會顯示成怎樣（圖）＋ 顯示方式有哪些（圖例）＋ 資料代表什麼意思 -->
        <template v-if="tab === 'show'">
          <div class="layerdoc-fig" v-html="doc.svg" />
          <p class="layerdoc-cap">{{ doc.caption }}</p>

          <section class="layerdoc-sec">
            <h3><MIcon name="palette" :size="14" /> 顯示方式有哪些</h3>
            <ul class="layerdoc-legend">
              <li v-for="(g, i) in doc.legend" :key="i">
                <span class="lg-mark" v-html="markSvg(g)" />
                <span class="lg-label">{{ g.l }}</span>
              </li>
            </ul>
          </section>

          <section class="layerdoc-sec">
            <h3><MIcon name="dataset" :size="14" /> 資料代表什麼意思</h3>
            <div class="layerdoc-prose" v-html="doc.dataMeaning" />
          </section>

          <section class="layerdoc-sec">
            <h3><MIcon name="code" :size="14" /> JSON 格式怎麼存</h3>
            <pre class="layerdoc-code"><code>{{ doc.json.code }}</code></pre>
            <p v-if="doc.json.note" class="layerdoc-note">{{ doc.json.note }}</p>
          </section>
        </template>

        <!-- Tab 2：計算的演算法內容 -->
        <template v-else>
          <section class="layerdoc-sec first">
            <h3><MIcon name="functions" :size="14" /> 計算的演算法</h3>
            <div class="layerdoc-prose" v-html="doc.algorithm" />
          </section>

          <section v-if="doc.skills && doc.skills.length" class="layerdoc-sec">
            <h3><MIcon name="auto_awesome" :size="14" /> 相關 skill（完整說明）</h3>
            <div class="layerdoc-skills">
              <button v-for="s in doc.skills" :key="s" class="layerdoc-skill" @click="openSkill(s)">
                <MIcon name="auto_awesome" :size="12" /><span>{{ s }}</span>
              </button>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layerdoc-dialog { width: min(680px, calc(100vw - 32px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column; }
/* 分頁列（顯示與資料 / 演算法）——與 SkillViewer 同款，但那份是 scoped，這裡要自帶一份 */
.dialog-tabs {
  display: flex; gap: 2px; padding: 0 16px;
  border-bottom: 1px solid hsl(var(--border));
}
.dialog-tab {
  padding: 8px 12px; font-size: 13px; background: transparent; border: none; cursor: pointer;
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap;
}
.dialog-tab:hover { color: hsl(var(--foreground)); }
.dialog-tab.active { color: hsl(var(--primary)); font-weight: 600; border-bottom-color: hsl(var(--primary)); }
.layerdoc-title { display: flex; align-items: center; gap: 8px; }
.layerdoc-body { overflow-y: auto; padding: 12px 16px 16px; }
.layerdoc-fig {
  display: flex; justify-content: center;
  background: hsl(var(--muted) / 0.35);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 10px;
}
.layerdoc-fig :deep(svg) { width: 100%; max-width: 340px; height: auto; }
.layerdoc-cap { margin: 6px 2px 0; font-size: 12px; color: hsl(var(--muted-foreground)); text-align: center; }
.layerdoc-sec { margin-top: 16px; }
.layerdoc-sec.first { margin-top: 4px; }
.layerdoc-sec h3 {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600; margin: 0 0 8px;
  color: hsl(var(--foreground));
}
.layerdoc-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.layerdoc-legend li { display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
.lg-mark { flex-shrink: 0; width: 26px; height: 14px; display: inline-flex; }
.lg-mark :deep(svg) { width: 26px; height: 14px; }
.lg-label { color: hsl(var(--foreground)); }
.layerdoc-prose { font-size: 13px; line-height: 1.7; }
.layerdoc-prose :deep(p) { margin: 4px 0; }
.layerdoc-prose :deep(ul) { margin: 4px 0; padding-left: 20px; }
.layerdoc-prose :deep(li) { margin: 3px 0; }
.layerdoc-prose :deep(code), .layerdoc-note :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  background: hsl(var(--muted) / 0.6); border-radius: 4px; padding: 1px 5px;
}
.layerdoc-code {
  margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55;
  background: hsl(var(--muted) / 0.5); border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px); padding: 10px 12px; overflow-x: auto; white-space: pre;
}
.layerdoc-note { margin: 6px 2px 0; font-size: 12px; color: hsl(var(--muted-foreground)); }
.layerdoc-skills { display: flex; flex-wrap: wrap; gap: 6px; }
.layerdoc-skill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; padding: 4px 9px; border-radius: 999px;
  color: hsl(var(--foreground)); background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border)); cursor: pointer;
}
.layerdoc-skill:hover { background: hsl(var(--accent)); border-color: hsl(var(--primary) / 0.5); }
</style>
