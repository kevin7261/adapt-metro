// pointer 拖曳調寬的共用機構（LayerPanel / StylePanel / D3Tab 三處分隔條）：
// pointerdown 起手 → window pointermove 回報位移 → pointerup 解除監聽並復位
// dragging 旗標。夾住範圍、方向與寫回目標由呼叫端的 onMove(dx) 決定。
export function dragResize(e, { dragging, onMove }) {
  dragging.value = true
  const startX = e.clientX
  const move = (ev) => onMove(ev.clientX - startX)
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
