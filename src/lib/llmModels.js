// LLM 模型下拉選項（短鍵 → 顯示名）。'default' 不帶 --model（沿用 Claude Code 預設）。
// 短鍵必須與 vite/llmModels.js 的 CLI id 對照表一致。
export const LLM_MODEL_OPTIONS = [
  { key: 'default', label: '沿用 CLI 預設' },
  { key: 'opus', label: 'Opus 4.8' },
  { key: 'fable', label: 'Fable 5' },
  { key: 'sonnet', label: 'Sonnet 5' },
  { key: 'haiku', label: 'Haiku 4.5' },
]
