import { reactive } from 'vue'

// Which skill's SKILL.md is currently shown in the viewer modal (id or null).
// Kept as a tiny shared reactive so any component (layer rows, etc.) can open a
// skill doc and a single mounted <SkillViewer> renders it.
export const skillView = reactive({ id: null })

export function openSkillDoc(id) { skillView.id = id }
export function closeSkillDoc() { skillView.id = null }
