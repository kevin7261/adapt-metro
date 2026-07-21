<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import MIcon from './MIcon.vue'
import { skillView, closeSkillDoc } from '../stores/skillHandle'
import { assetUrl } from '../lib/assetUrl'

const html = ref('')
const raw = ref('')          // 原始 SKILL.md 全文（含 frontmatter，行號對齊實際檔案）
const loading = ref(false)
const tab = ref('rendered')  // 'rendered' 目前內容 | 'raw' 原始 md（含行號）
const TABS = [
  { id: 'rendered', label: '內容' },
  { id: 'raw', label: '原始 MD' },
]
const rawLines = computed(() => raw.value.split('\n'))

watch(() => skillView.id, async (id) => {
  if (!id) return
  loading.value = true
  html.value = ''
  raw.value = ''
  tab.value = 'rendered'
  try {
    const res = await fetch(assetUrl(`skills/${id}.md`), { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    raw.value = await res.text()
    const md = raw.value.replace(/^---\n[\s\S]*?\n---\n/, '') // strip frontmatter
    html.value = marked.parse(md)
  } catch (err) {
    html.value = `<p>載入失敗：${err}</p>`
  } finally {
    loading.value = false
  }
})

function onKeydown(e) { if (e.key === 'Escape') closeSkillDoc() }
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="skillView.id" class="dialog-overlay" @mousedown.self="closeSkillDoc">
    <div class="dialog skill-dialog">
      <div class="dialog-header">
        <h2 class="dialog-title skill-title">
          <MIcon name="auto_awesome" :size="15" /> {{ skillView.id }}
        </h2>
        <button class="btn-icon" @click="closeSkillDoc"><MIcon name="close" :size="15" /></button>
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
      <div class="dialog-body">
        <div v-if="loading" class="skills-status">載入 SKILL.md…</div>
        <div v-else-if="tab === 'rendered'" class="skill-md" v-html="html" />
        <div v-else class="skill-raw">
          <table class="skill-raw-table">
            <tbody>
              <tr v-for="(line, i) in rawLines" :key="i">
                <td class="ln">{{ i + 1 }}</td>
                <td class="lc">{{ line }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skill-dialog { width: min(760px, calc(100vw - 32px)); }
.skill-title { display: flex; align-items: center; gap: 8px; }
.skills-status { padding: 12px; font-size: 12.5px; color: hsl(var(--muted-foreground)); text-align: center; }
/* 內容 / 原始 MD——與匯入 modal 相同的 tab 形式（header 下方、底線指示） */
.dialog-tabs {
  display: flex; gap: 2px; padding: 0 16px;
  border-bottom: 1px solid hsl(var(--border));
}
.dialog-tab {
  padding: 8px 12px; font-size: 13px;
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap;
}
.dialog-tab:hover { color: hsl(var(--foreground)); }
.dialog-tab.active {
  color: hsl(var(--primary)); font-weight: 600;
  border-bottom-color: hsl(var(--primary));
}
/* 原始 md：行號＋等寬、水平捲動；行號不可選取（複製時只拿內容） */
.skill-raw { overflow: auto; }
.skill-raw-table { border-collapse: collapse; width: 100%; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.55; }
.skill-raw-table .ln {
  position: sticky; left: 0;
  padding: 0 10px 0 4px; text-align: right; vertical-align: top;
  color: hsl(var(--muted-foreground) / 0.7); background: hsl(var(--card));
  border-right: 1px solid hsl(var(--border));
  user-select: none; white-space: nowrap; width: 1%;
}
.skill-raw-table .lc { padding: 0 4px 0 10px; white-space: pre; }
</style>

<style>
/* Rendered SKILL.md content (v-html, so unscoped) */
.skill-md { font-size: 13px; line-height: 1.65; }
.skill-md h1 { font-size: 18px; margin: 4px 0 10px; }
.skill-md h2 { font-size: 15px; margin: 18px 0 8px; border-bottom: 1px solid hsl(var(--border)); padding-bottom: 4px; }
.skill-md h3 { font-size: 13.5px; margin: 14px 0 6px; }
.skill-md p { margin: 6px 0; }
.skill-md ul, .skill-md ol { margin: 6px 0; padding-left: 22px; }
.skill-md li { margin: 2px 0; }
.skill-md code {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  background: hsl(var(--muted) / 0.6);
  border-radius: 4px;
  padding: 1px 5px;
}
.skill-md pre {
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 10px 12px;
  overflow-x: auto;
}
.skill-md pre code { background: none; padding: 0; }
.skill-md table { border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }
.skill-md th, .skill-md td {
  border: 1px solid hsl(var(--border));
  padding: 4px 10px;
  text-align: left;
}
.skill-md th { background: hsl(var(--muted) / 0.5); }
.skill-md a { color: hsl(var(--primary)); }
.skill-md blockquote {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid hsl(var(--primary) / 0.5);
  color: hsl(var(--muted-foreground));
}
</style>
