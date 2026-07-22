// LLM「執行調整」toggle 跨 reload 記憶（只存布林，結果本身仍從結果檔重載）。
const LLM_APPLY_LS = 'adaptMetro.llmApplied.v1'

function llmApplyRead() {
  try { return JSON.parse(localStorage.getItem(LLM_APPLY_LS) || '{}') } catch { return {} }
}

/** 是否曾寫過此鍵（用來區分「預設未寫」與「使用者明確關」） */
export function llmApplyHas(key) {
  try { return Object.prototype.hasOwnProperty.call(llmApplyRead(), key) } catch { return false }
}

export function llmApplyGet(key) {
  try { return !!llmApplyRead()[key] } catch { return false }
}

export function llmApplySet(key, on) {
  try {
    const s = llmApplyRead()
    // 一律寫入 true/false（不再 delete）——「重新計算圖層」可把成方套用釘成
    // false；預設不成方，只有按「開始 LLM 成方」或「執行調整」才會寫 true。
    s[key] = !!on
    localStorage.setItem(LLM_APPLY_LS, JSON.stringify(s))
  } catch { /* localStorage 不可用 → 退回「不記憶」 */ }
}
