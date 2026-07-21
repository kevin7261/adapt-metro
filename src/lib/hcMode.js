// HC／RWD 視圖 mode id 解析（純字串／regex，無 Vue／DOM）。
// mode 形狀：`hc`｜`hc-<kind>[-<step>]`｜`layout-<kind>`｜`hc-compact`｜`rwd`
// kind ∈ 論文①〜⑧（PAPER_KINDS）＋ llm；
// step ∈ end|line|gather|loop|shape|step
//   （shape＝對該鏈循環結果跑 Shape-Guided，見 route-shape-align）。
import { PAPER_KINDS } from '../stores/paperAlign.js'

export const PAPER_KIND_IDS = PAPER_KINDS.map((p) => p.kind)
export const HC_MODE_RE = new RegExp(
  `^hc-(llm|${PAPER_KIND_IDS.join('|')})(?:-(end|line|gather|loop|shape|step))?$`)

// 「Hill Climbing」區的主佈局比較（不含 rect——② 就是爬山本體）。
export const LAYOUT_KINDS = PAPER_KINDS.filter((p) => p.kind !== 'rect')
export const LAYOUT_KIND_IDS = LAYOUT_KINDS.map((p) => p.kind)
export const LAYOUT_MODE_RE = new RegExp(`^layout-(${LAYOUT_KIND_IDS.join('|')})$`)

export const layoutKindOf = (m) => {
  const mm = LAYOUT_MODE_RE.exec(m)
  return mm ? mm[1] : null
}

// 該 step 專屬的鏈 kind（step 不符 → null）。
export const kindAtStep = (m, step) => {
  const mm = HC_MODE_RE.exec(m)
  return mm && mm[2] === step ? mm[1] : null
}
export const endKindOf = (m) => kindAtStep(m, 'end')
export const lineKindOf = (m) => kindAtStep(m, 'line')
export const gatherKindOf = (m) => kindAtStep(m, 'gather')
export const loopKindOf = (m) => kindAtStep(m, 'loop')
// Shape-Guided 只對①〜⑧（不含 LLM）
export const shapeKindOf = (m) => {
  const k = kindAtStep(m, 'shape')
  return k && k !== 'llm' ? k : null
}
export const stepKindOf = (m) => kindAtStep(m, 'step')

// 瀏覽器端後處理 kind——llm 不在內（LLM 對齊在檔案端算好）。
export const postKindOf = (m) => {
  const mm = HC_MODE_RE.exec(m)
  return mm && mm[1] !== 'llm' ? mm[1] : null
}

export const needsHcLayout = (mode) =>
  mode === 'hc' || HC_MODE_RE.test(mode) ||
  !!layoutKindOf(mode) ||
  mode === 'hc-compact' ||
  mode === 'rwd'
