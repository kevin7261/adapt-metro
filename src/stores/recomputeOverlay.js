// 重新計算全螢幕進度（單城／全城共用）
import { reactive } from 'vue'

export const recomputeOverlay = reactive({
  open: false,
  title: '重新計算',
  step: '',
  phase: '',
  /** @type {{ current: number, total: number, item: string }|null} */
  progress: null,
  paused: false,
  error: '',
  /** 'city' | 'all' | '' */
  mode: '',
})

export function showRecomputeOverlay({ title = '重新計算', mode = '' } = {}) {
  recomputeOverlay.open = true
  recomputeOverlay.title = title
  recomputeOverlay.mode = mode
  recomputeOverlay.step = '啟動中…'
  recomputeOverlay.phase = ''
  recomputeOverlay.progress = null
  recomputeOverlay.paused = false
  recomputeOverlay.error = ''
}

export function updateRecomputeOverlay( partial = {}) {
  if (!recomputeOverlay.open) return
  if (partial.title != null) recomputeOverlay.title = partial.title
  if (partial.step != null) recomputeOverlay.step = partial.step
  if (partial.phase != null) recomputeOverlay.phase = partial.phase
  if (partial.progress !== undefined) recomputeOverlay.progress = partial.progress
  if (partial.paused != null) recomputeOverlay.paused = !!partial.paused
  if (partial.error != null) recomputeOverlay.error = partial.error
}

export function hideRecomputeOverlay() {
  recomputeOverlay.open = false
  recomputeOverlay.step = ''
  recomputeOverlay.phase = ''
  recomputeOverlay.progress = null
  recomputeOverlay.paused = false
  recomputeOverlay.error = ''
  recomputeOverlay.mode = ''
}
