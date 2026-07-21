// 一城的標準 RWD 組：論文①〜⑨＋ LLM 對齊（順序＝論文編號）。
// 「基本 hc」僅作 fallback、不主動建立圖層。
// vite/compactKinds.js 另含 'hc'（LLM endpoint 白名單）；改 PAPER_KINDS 時兩邊一起改。
export const RWD_COMPACTS = ['stroke', 'rect', 'milp', 'force', 'lsq', 'octi', 'path', 'sat', 'shape', 'llm']
