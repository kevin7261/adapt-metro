// 單城「從目前位置起的後續資料流」——清 cells → bakeHcCells → shape → buildViews。
// 僅 dev server（/metro-recompute/city）；與工具列全城重算共用 status。
import { clearDataOverlay } from './dataOverlay.js'
import {
  showRecomputeOverlay, updateRecomputeOverlay, hideRecomputeOverlay,
} from '../stores/recomputeOverlay.js'

/**
 * @param {string} cityId
 * @param {{ onStep?: (s: string) => void, title?: string }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function recomputeCityFlow(cityId, opts = {}) {
  const city = String(cityId || '').replace(/[^\w-]/g, '')
  if (!city) return { ok: false, error: '無城市 id' }
  const onStep = opts.onStep || (() => {})
  showRecomputeOverlay({
    title: opts.title || `重新計算 ${city}`,
    mode: 'city',
  })
  let res
  try {
    res = await fetch('/metro-recompute/city', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city }),
    })
  } catch (e) {
    const error = e.message || '無法連線'
    updateRecomputeOverlay({ error, step: error })
    await new Promise((r) => setTimeout(r, 1200))
    hideRecomputeOverlay()
    return { ok: false, error }
  }
  if (res.status === 404 || res.status === 405) {
    const error = '僅開發伺服器可用（npm run serve）'
    updateRecomputeOverlay({ error, step: error })
    await new Promise((r) => setTimeout(r, 1200))
    hideRecomputeOverlay()
    return { ok: false, error }
  }
  if (res.status === 409) {
    const error = '已有重新計算在進行中'
    updateRecomputeOverlay({ error, step: error })
    await new Promise((r) => setTimeout(r, 1200))
    hideRecomputeOverlay()
    return { ok: false, error }
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    const error = j.error || `HTTP ${res.status}`
    updateRecomputeOverlay({ error, step: error })
    await new Promise((r) => setTimeout(r, 1200))
    hideRecomputeOverlay()
    return { ok: false, error }
  }
  // 等 job 跑完
  for (;;) {
    await new Promise((r) => setTimeout(r, 800))
    let j
    try {
      const st = await fetch('/metro-recompute/status')
      if (!st.ok) {
        const error = `status HTTP ${st.status}`
        updateRecomputeOverlay({ error, step: error })
        await new Promise((r) => setTimeout(r, 1200))
        hideRecomputeOverlay()
        return { ok: false, error }
      }
      j = await st.json()
    } catch (e) {
      const error = e.message || '狀態讀取失敗'
      updateRecomputeOverlay({ error, step: error })
      await new Promise((r) => setTimeout(r, 1200))
      hideRecomputeOverlay()
      return { ok: false, error }
    }
    updateRecomputeOverlay({
      step: j.step || '進行中…',
      phase: j.phase || '',
      progress: j.progress ?? null,
      paused: !!j.paused,
    })
    if (j.step) onStep(j.step)
    if (j.running) continue
    clearDataOverlay('data/metro/')
    if (j.exit === 0) {
      updateRecomputeOverlay({ step: '完成', phase: 'done' })
      await new Promise((r) => setTimeout(r, 400))
      hideRecomputeOverlay()
      return { ok: true }
    }
    const error = j.error || '重算失敗（見 terminal）'
    updateRecomputeOverlay({ error, step: error })
    await new Promise((r) => setTimeout(r, 1600))
    hideRecomputeOverlay()
    return { ok: false, error }
  }
}
