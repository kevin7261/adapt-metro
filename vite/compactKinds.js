// 縮減網格鏈 id 白名單（LLM 端點的 compact 參數）：hc ＋ 論文①〜⑨的九條鏈
// ＋ llm（src/stores/paperAlign.js 的 PAPER_KINDS——vite 側不 import src，
// 避免拖進瀏覽器依賴）。align/ilp 已移除（2026-07：只留與論文對應的鏈）。
// 改 PAPER_KINDS 時請同步此清單。
export const COMPACT_KINDS = ['hc', 'stroke', 'rect', 'milp', 'force', 'lsq', 'octi', 'path', 'sat', 'shape', 'llm']
