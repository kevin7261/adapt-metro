<script setup>
import { ref, computed, watch } from 'vue'
import { openSkillDoc } from '../../stores/skillHandle'
import { assetUrl } from '../../lib/assetUrl'
import MIcon from '../MIcon.vue'

const props = defineProps({
  dialog: { type: String, required: true },
})
const emit = defineEmits(['close'])

/* Skills modal — toolbar「Skills」開啟，列出全部 skill（skills/index.json），
   點一個開它的 SKILL.md 檢視器。依用途分三節。 */
const allSkills = ref(null)
const skillsError = ref(null)
watch(() => props.dialog, (d) => {
  if (d !== 'skills' || allSkills.value) return
  skillsError.value = null
  fetch(assetUrl('skills/index.json'))
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() })
    .then((list) => { allSkills.value = list })
    .catch((err) => { skillsError.value = String(err) })
}, { immediate: true })
// 分類＝圖層名（與圈層列一致）：Metro Maps 收三管線＋地標＋城市規則、Map Adjust
// 收骨架/格網化、RWD Maps 收畫線＋LLM 調整/評價、其餘 route-* 都屬 Straighten。
const skillGroupOf = (id) => {
  if (id.startsWith('route-skeleton-')) return 'Map Adjust'
  if (['route-rwd-draw', 'route-llm-grid', 'route-llm-eval'].includes(id)) return 'RWD Maps'
  if (id.startsWith('route-')) return 'Straighten'
  return 'Metro Maps'
}
const skillGroups = computed(() => {
  const order = ['Metro Maps', 'Map Adjust', 'Straighten', 'RWD Maps']
  const by = new Map(order.map((label) => [label, []]))
  for (const s of allSkills.value ?? []) by.get(skillGroupOf(s.id)).push(s)
  return order.map((label) => ({ label, skills: by.get(label) })).filter((g) => g.skills.length)
})
// 四個 skill 群改成分頁（tab）呈現，一次只看一群。
const activeSkillGroup = ref('Raw Maps')
const currentSkillGroup = computed(() => {
  const groups = skillGroups.value
  return groups.find((g) => g.label === activeSkillGroup.value) ?? groups[0] ?? null
})
function openSkill(id) {
  emit('close')
  openSkillDoc(id)
}
</script>

<template>
  <!-- Skills：全部 skill 總覽（toolbar 的 Skills 按鈕） -->
  <div class="dialog skills-modal">
    <div class="dialog-header">
      <h2 class="dialog-title">Skills</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div v-if="allSkills && !skillsError" class="dialog-tabs" role="tablist">
      <button
        v-for="g in skillGroups"
        :key="g.label"
        class="dialog-tab"
        :class="{ active: currentSkillGroup?.label === g.label }"
        role="tab"
        :aria-selected="currentSkillGroup?.label === g.label"
        @click="activeSkillGroup = g.label"
      >{{ g.label }} <span class="skills-tab-count">{{ g.skills.length }}</span></button>
    </div>
    <div class="dialog-body skills-body">
      <div v-if="skillsError" class="import-status error">載入 skill 清單失敗：{{ skillsError }}</div>
      <div v-else-if="!allSkills" class="import-status">載入 skill 清單…</div>
      <div v-else-if="currentSkillGroup" class="skills-grid">
        <button v-for="s in currentSkillGroup.skills" :key="s.id" class="skill-card" @click="openSkill(s.id)">
          <MIcon name="auto_awesome" :size="13" class="skill-card-icon" />
          <span class="skill-card-text">
            <span class="skill-card-name">{{ s.id }}</span>
            <span v-if="s.description" class="skill-card-desc">{{ s.description }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
