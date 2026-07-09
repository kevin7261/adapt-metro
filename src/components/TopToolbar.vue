<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import { useMapStore } from '../stores/mapStore'
import {
  Map as MapIcon, TrainFront, Sparkles, X, Zap, ArrowUpDown, Globe,
} from 'lucide-vue-next'

const store = useMapStore()

/* ---- Import dropdown ---- */
const importOpen = ref(false)
const importWrap = ref(null)
const importItems = [
  { id: 'import-quick', label: 'Quick Selection', icon: Zap },
  { id: 'import-stations', label: '依車站數排序', icon: ArrowUpDown },
  { id: 'import-metro', label: 'Global Metro Map', icon: Globe },
]
function pickImport(id) {
  importOpen.value = false
  store.ui.dialog = id
}

/* ---- Skills dropdown + modal ---- */
const skillsOpen = ref(false)
const skills = ref(null)       // [{ id, description }]
const skillsError = ref(null)
const activeSkill = ref(null)  // { id, html } shown in the modal
const skillLoading = ref(false)
const menuWrap = ref(null)

async function toggleSkills() {
  skillsOpen.value = !skillsOpen.value
  if (skillsOpen.value && !skills.value) {
    try {
      const res = await fetch('/skills/index.json')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      skills.value = await res.json()
    } catch (err) {
      skillsError.value = String(err)
    }
  }
}

async function openSkill(skill) {
  skillsOpen.value = false
  skillLoading.value = true
  activeSkill.value = { id: skill.id, html: '' }
  try {
    const res = await fetch(`/skills/${skill.id}.md`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = (await res.text()).replace(/^---\n[\s\S]*?\n---\n/, '') // strip frontmatter
    activeSkill.value = { id: skill.id, html: marked.parse(md) }
  } catch (err) {
    activeSkill.value = { id: skill.id, html: `<p>載入失敗：${err}</p>` }
  } finally {
    skillLoading.value = false
  }
}

function onDocClick(e) {
  if (skillsOpen.value && menuWrap.value && !menuWrap.value.contains(e.target)) {
    skillsOpen.value = false
  }
  if (importOpen.value && importWrap.value && !importWrap.value.contains(e.target)) {
    importOpen.value = false
  }
}
function onKeydown(e) {
  if (e.key === 'Escape') { skillsOpen.value = false; importOpen.value = false; activeSkill.value = null }
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
      <MapIcon :size="16" />
      <span class="brand-name">Adapt-Metro</span>
    </div>

    <div ref="importWrap" class="skills-wrap">
      <button class="btn-ghost" :class="{ active: importOpen }" @click="importOpen = !importOpen">
        <TrainFront :size="14" />
        Import
      </button>
      <div v-if="importOpen" class="menu-pop import-menu">
        <button v-for="item in importItems" :key="item.id" class="menu-item" @click="pickImport(item.id)">
          <component :is="item.icon" :size="14" /> {{ item.label }}
        </button>
      </div>
    </div>

    <div ref="menuWrap" class="skills-wrap">
      <button class="btn-ghost" :class="{ active: skillsOpen }" @click="toggleSkills">
        <Sparkles :size="14" />
        Skills
      </button>
      <div v-if="skillsOpen" class="menu-pop skills-menu">
        <div v-if="skillsError" class="skills-status">載入失敗：{{ skillsError }}</div>
        <div v-else-if="!skills" class="skills-status">載入 skills…</div>
        <template v-else>
          <div class="menu-label">此系統的 Skills（.claude/skills）</div>
          <button v-for="s in skills" :key="s.id" class="menu-item skill-item" @click="openSkill(s)">
            <Sparkles :size="13" class="skill-icon" />
            <span class="skill-text">
              <span class="skill-name">{{ s.id }}</span>
              <span class="skill-desc">{{ s.description }}</span>
            </span>
          </button>
          <div v-if="!skills.length" class="skills-status">沒有找到 skill</div>
        </template>
      </div>
    </div>
  </header>

  <!-- Skill modal -->
  <div v-if="activeSkill" class="dialog-overlay" @mousedown.self="activeSkill = null">
    <div class="dialog skill-dialog">
      <div class="dialog-header">
        <h2 class="dialog-title skill-title">
          <Sparkles :size="15" /> {{ activeSkill.id }}
        </h2>
        <button class="btn-icon" @click="activeSkill = null"><X :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="skillLoading" class="skills-status">載入 SKILL.md…</div>
        <div v-else class="skill-md" v-html="activeSkill.html" />
      </div>
    </div>
  </div>
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
.skills-menu { top: 34px; left: 0; min-width: 320px; max-width: 420px; }
.import-menu { top: 34px; left: 0; min-width: 200px; }
.skills-status {
  padding: 12px;
  font-size: 12.5px;
  color: hsl(var(--muted-foreground));
  text-align: center;
}
.skill-item { align-items: flex-start; }
.skill-icon { flex-shrink: 0; margin-top: 2px; color: hsl(var(--primary)); }
.skill-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; white-space: normal; }
.skill-name { font-weight: 600; font-size: 12.5px; }
.skill-desc {
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-dialog { width: min(760px, calc(100vw - 32px)); }
.skill-title { display: flex; align-items: center; gap: 8px; }
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
