// LLM「執行調整」toggle 跨 reload 記憶（只存布林，結果本身仍從結果檔重載）。
const LLM_APPLY_LS = 'adaptMetro.llmApplied.v1'

export function llmApplyGet(key) {
  try { return !!JSON.parse(localStorage.getItem(LLM_APPLY_LS) || '{}')[key] } catch { return false }
}

export function llmApplySet(key, on) {
  try {
    const s = JSON.parse(localStorage.getItem(LLM_APPLY_LS) || '{}')
    if (on) s[key] = true; else delete s[key]
    localStorage.setItem(LLM_APPLY_LS, JSON.stringify(s))
  } catch { /* localStorage 不可用 → 退回「不記憶」 */ }
}
