<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import { Sparkles, X } from 'lucide-vue-next'
import { skillView, closeSkillDoc } from '../stores/skillHandle'
import { assetUrl } from '../lib/assetUrl'

const html = ref('')
const loading = ref(false)

watch(() => skillView.id, async (id) => {
  if (!id) return
  loading.value = true
  html.value = ''
  try {
    const res = await fetch(assetUrl(`skills/${id}.md`))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = (await res.text()).replace(/^---\n[\s\S]*?\n---\n/, '') // strip frontmatter
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
          <Sparkles :size="15" /> {{ skillView.id }}
        </h2>
        <button class="btn-icon" @click="closeSkillDoc"><X :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="loading" class="skills-status">載入 SKILL.md…</div>
        <div v-else class="skill-md" v-html="html" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.skill-dialog { width: min(760px, calc(100vw - 32px)); }
.skill-title { display: flex; align-items: center; gap: 8px; }
.skills-status { padding: 12px; font-size: 12.5px; color: hsl(var(--muted-foreground)); text-align: center; }
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
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
