// 縮減網格鏈 id 白名單（LLM 端點的 compact 參數）：hc ＋ 論文①〜⑧的八條鏈
// ＋ llm（src/stores/paperAlign.js 的 PAPER_KINDS——vite 側不 import src，
// 避免拖進瀏覽器依賴）。align/ilp／shape 已移除（Shape-Guided 改掛循環之後）。
// 改 PAPER_KINDS 時請同步此清單。
export const COMPACT_KINDS = ['hc', 'stroke', 'rect', 'milp', 'force', 'lsq', 'octi', 'path', 'sat', 'llm']
