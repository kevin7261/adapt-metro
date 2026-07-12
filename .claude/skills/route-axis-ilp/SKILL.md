---
name: route-axis-ilp
description: 整數規劃（H/V 最大化後處理③）——逐軸 0-1 整數規劃精確解：每個可對齊端點一個 offset 變數 ∈ [-2,2]，最大化對齊段數、位移當 tie-break、象限不翻轉為 pairwise 約束；配對圖分元件用生成樹 DP 求解、環以 feedback set 枚舉，並迭代到不動點（上限 20 次）。當使用者要求修改整數規劃後處理、調 window/獎勵/DP、或問「整數規劃」tab 的行為時使用。總覽與共用機構見 [[route-hillclimb]]。
---

# 整數規劃 (route-axis-ilp)

[[route-hillclimb]] 的**第三種 H/V 最大化後處理**：輸入 = Hill Climbing 的
`cellAfter`。與軸對齊同樣利用 x/y 可分離，但每軸不用貪婪——建成 0-1 整數
規劃**精確求解**（文獻對應 Nöllenburg & Wolff 2011 的 MIP 思路，縮到
小視窗使其可解）。

## 模型（每軸一個獨立規劃）

- **變數**：可對齊段（嚴格較貼近該軸、垂距 ≤ 2k，k=`opts.window` 預設 2）
  的端點各一個 offset ∈ [-k, k]；其他頂點固定 offset 0。
- **目標**：maximize Σ(對齊段 × REWARD) − Σ|offset|（一次對齊永遠壓過任何
  總位移，位移只當 tie-break）。
- **約束**：邊界 0 ≤ 座標 < cols/rows；**象限不翻轉**（垂距 ≤ 2k 的每段是
  pairwise 約束：符號可到 0、不可過界）。

## 求解（精確、無 solver 依賴）

配對圖分連通元件；每元件取 BFS 生成樹做 **樹 DP**（domain ≤ 2k+1），
環的 back edge 用小 **feedback vertex set** 枚舉條件化（≤3125 種組合，
超過該元件退回不動、計入 `fallback`）。跨軸硬規則（遮蔽、一格一點）進不了
可分離模型，靠 `applyTargets`（同一套硬規則＋淨值變差退回）把關。
外面用 `iteratePost` 迭代到不動點（±k 視窗每輪重新置中，等效擴大範圍；
上限 20、實測 ≤8 次收斂）。

## 特性（224 城實測）

- 迭代後全網 H/V **+47.8%**——三種演算法後處理中最強。
- 「最優」是對模型而言：視窗 ±k、逐軸分離、只含象限約束；模型外靠套用層。
- 少數環太多的元件 fallback（3/224 城）。

## 實作契約

- `buildAxisIlp(skeleton, cells, cols, rows, opts)`（src/stores/hillClimb.js），
  `opts.window` 預設 2。stats 含 `hvBefore/hvAfter/comps/fallback/passes`。
- UI 經 `iteratePost(buildAxisIlp, ...)`；tab「整數規劃」badge 顯示「已迭代/20」；
  縮減 tab「整數規劃縮減」= `compactGrid`。

## 修改時

模型/DP/feedback 枚舉變動同步本檔與 `hillClimb.js`；共用機構的變動記在
[[route-hillclimb]]。
