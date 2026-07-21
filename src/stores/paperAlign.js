// 「論文直線演算法」後處理鏈總目錄——實作在 paper/，此檔維持既有 export 面。
import { buildRectPolish } from './hillClimb.js'
import { buildStrokeAlign } from './paper/stroke.js'
import { buildMilpAlign } from './paper/milp.js'
import { buildSatAlign } from './paper/sat.js'
import { buildForceAlign } from './paper/force.js'
import { buildLsqAlign } from './paper/lsq.js'
import { buildOctiAlign } from './paper/octi.js'
import { buildPathAlign } from './paper/path.js'

export { buildStrokeAlign } from './paper/stroke.js'
export { buildMilpAlign } from './paper/milp.js'
export { buildSatAlign } from './paper/sat.js'
export { buildForceAlign } from './paper/force.js'
export { buildLsqAlign } from './paper/lsq.js'
export { buildOctiAlign } from './paper/octi.js'
export { buildPathAlign } from './paper/path.js'

export const PAPER_KINDS = [
  { kind: 'stroke', zh: '①筆畫法', build: buildStrokeAlign },
  { kind: 'rect', zh: '②直角爬山', build: buildRectPolish },
  { kind: 'milp', zh: '③MILP規劃', build: buildMilpAlign },
  { kind: 'force', zh: '④力導向', build: buildForceAlign },
  { kind: 'lsq', zh: '⑤最小平方', build: buildLsqAlign },
  { kind: 'octi', zh: '⑥八向格網', build: buildOctiAlign },
  { kind: 'path', zh: '⑦路徑簡化', build: buildPathAlign },
  { kind: 'sat', zh: '⑧SAT規劃', build: buildSatAlign },
]
export const PAPER_BUILD = Object.fromEntries(PAPER_KINDS.map((p) => [p.kind, p.build]))
export const PAPER_ZH = Object.fromEntries(PAPER_KINDS.map((p) => [p.kind, p.zh]))
