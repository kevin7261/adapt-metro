// 執行時間（vite plugin 於 spawn→close 量到、寫進結果檔的 elapsedMs）→ 顯示字串：
// <60 秒顯示秒、否則「分 秒」。沒有值就回 null。
export function fmtElapsed(ms) {
  if (!ms || ms < 0) return null
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

// 把評價文字拆成條列：已是陣列直接用；字串依換行／分號／頓號切開。
export function toBullets(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  const s = String(v ?? '').trim()
  if (!s) return []
  let parts = s.split(/\n+/)
    .flatMap((line) => line.split(/[；。]/))
    .map((x) => x
      .replace(/^[\s•\-–—*]+/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .replace(/[。．.]+$/u, '')
      .trim())
    .filter(Boolean)
  if (parts.length <= 1) {
    const one = parts[0] || s
    const dunk = one.split(/[、]/).map((x) => x.trim()).filter(Boolean)
    parts = dunk.length >= 2 ? dunk : [one.replace(/[。．.]+$/u, '').trim()].filter(Boolean)
  }
  return parts.length ? parts : [s]
}
