---
name: route-hillclimb
description: Hill Climbing 多準則佈局最佳化（②，Stott et al. 2011）——以 Map Adjust「格網化後」的整數格佈局為輸入，用加權多準則適應度（角解析度/邊長/平衡邊長/平直/八方向）＋4 條硬規則（邊界/象限/遮蔽/邊環繞序）做爬山搜尋，含冷卻與超長邊群集移動；黑點沿新邊平均放回。另含三個 H/V 最大化後處理 tab（直角爬山/軸對齊/整數規劃，短距離移動彩色點讓水平垂直段最多）。當使用者要求爬山法最佳化、hill climbing、多準則佈局、水平垂直最大化後處理、或在 Hill Climbing layer group 加/改視圖時使用。實作在 src/stores/hillClimb.js（純函式）＋ D3Tab 的 hillclimb 圖層模式。
---

# Hill Climbing 多準則佈局最佳化 (route-hillclimb)

把 [[route-skeleton-grid]]（⑨ 示意格網化）的**整數格佈局**再用爬山法最佳化。依據：
Stott, Rodgers, Martínez-Ovando & Walker (2011), *Automatic Metro Map Layout Using
Multicriteria Optimization*, IEEE TVCG 17(1)。完整演算法說明見
`data/thesis/2_hillclimbing_演算法說明.md`（＋同資料夾 PDF）。此 skill 是**實作對照與契約**。

> 純函式、**格座標（cell space）**運算、確定性（無亂數）。
> 實作：`src/stores/hillClimb.js` 的 `buildHillClimb(skeleton, cellOf, cols, rows, opts)`；
> UI 在 `D3Tab.vue`（`layer.type === 'hillclimb'`），layer group「Hill Climbing」。

## 資料流

```
Map Adjust（d3 圖層）的 格網化後（每城市 2 個：原始 orig / 旋轉 rot）
  → buildSchematicGrid(...).cellOf（彩色切點的整數格）
  → buildHillClimb：頂點 = 切點、邊 = 切點間直線小段（共走廊多路線仍 1 段＋routes metadata）
  → cellAfter（新整數格）→ D3Tab 用同一套等寬格心換回像素 → placeBlacks 放回黑點
```

- 新圖層由 Layers 面板 Hill Climbing group 的 **+** 建立：選一個 Map Adjust 圖層＋
  變體（原始/旋轉格網化後），存在 `layer.sourceLayerId`（d3 圖層 id）＋ `layer.variant`。
- Tab 有 16 個視圖，左選單分 **5 個部份**：**原始**（格網化後＝輸入）、
  **Hill Climbing**（結果）、**直線演算法**（四個 H/V 最大化後處理，**原樣、不含
  端點拉直**：直角爬山／軸對齊／整數規劃＝本 skill 下節；**LLM 對齊**＝離線預算，
  見 [[route-llm-align]]，按鈕 badge 顯示「n輪 · 模型名」）、
  **端點拉直**（5 個 tab，每條鏈一個：Hill Climbing／直角爬山／軸對齊／整數規劃／
  LLM 對齊端點拉直＝在該鏈結果**之上**再做端點拉直，原 tab 不變，見下）、
  **縮減網格**（5 個，一律叫「…縮減網格」：Hill Climbing縮減網格＝壓縮 hc 鏈
  「HC→端點拉直」的結果；直角爬山／軸對齊／整數規劃／LLM 對齊縮減網格＝壓縮
  **各自的原結果**（不含端點拉直），同一個 `compactGrid`）。
  工具列在 hc/hc 縮減網格顯示適應度 before → after（越低越好）、輪數、
  移動站數/群集數，後處理與其縮減網格 tab 顯示 水平垂直 before → after／總段數
  ＋移動站數＋各自的演算法統計；所有縮減網格 tab 另顯示 網格 cols×rows → cols'×rows'；
  端點拉直 tab 顯示 移動端點數/端點總數＋水平垂直 before → after＋迭代 n/20。
- **縮減網格**＝`compactGrid(cellAfter, cols, rows)`：把**整排/整欄沒有彩色點**的
  row/col 移除（欄列各自依排名重編號）——格網變小、欄列順序（＝拓撲與象限關係）不變；
  代價是壓縮後可能出現新的視覺交錯（rank 不變但幾何變了），與格網化的等距排名同屬下游議題。
- **Hill Climbing端點拉直**＝`buildEndpointStraighten(skeleton, cells, cols, rows)`
  （經 `iteratePost` 迭代到不動點）：**hc 鏈 = Hill Climbing → 端點拉直 → 縮減網格**。
  在 HC 結果（未壓縮的整數格）上，**每個非白點（所有彩色頂點——端點/轉乘/分歧/黃色
  交叉；白/黑直通站不是頂點）都可移動**：候選位置＝把一個座標吸到某鄰居的 row/col，
  只採納「自身入射段的 H/V 淨增 > 0」的候選 → 全圖 H/V 單調遞增（非入射段不受影響，
  不需 net-HV 退回）。每步走 makeMover 的**同一套硬規則**（不新增交叉、不壓到別的
  線/點、象限與邊環繞序不變）。tie-break：淨增大者 → 順著同 route 在鄰居另一側已是
  H/V 的段接直 → 位移小者。**下游**：只有 hc 鏈的端點拉直餵下游——hc 縮減網格、
  RWD 底圖（compact='hc'）、llmGrid 的 'hc' 鏈壓縮它的輸出；直角爬山/軸對齊/
  整數規劃/LLM 對齊與其縮減網格維持原樣（端點拉直版只是「端點拉直」區塊的顯示
  視圖）。畫廊（hcviews）每城 8 視圖（HC_VIEW_ORDER，卡片 2×4：
  格網化後→Hill Climbing→端點拉直→縮減網格 ×2 變體）。

## 主迴圈（論文 Algorithm 1）

逐頂點掃描以自身為中心、半徑 R 的矩形內所有格點 → 取局部適應度最低且通過硬規則者；
再做**群集移動**；一整輪無改善即收斂。**冷卻**：R 逐輪縮小
（預設 `[2,1,1]`，每站每輪最多 ±2 格；可用 `opts.radii` 覆寫）。
**增量計算**：移動 v 只重算 `{v} ∪ N(v)` 的節點項＋其鄰接小段（`costOfSet`）；
先算便宜的適應度、只有更優者才跑昂貴的幾何硬規則。

## 站點準則（式 1–5，權重 = 論文表 4，可用 opts.weights 覆寫）

| 準則 | 內容 | 權重 |
|---|---|---|
| c_N1 角解析度 | 相鄰邊夾角 → 2π/度數 | 30000 |
| c_N2 邊長 | 每小段長 → `hops × L`（L = 每站距的理想格數，取初始「長÷hops」中位數，clamp 1–8，可 opts.idealHop） | 50 |
| c_N3 平衡邊長 | 度 2 頂點兩鄰段等長 | 45 |
| c_N4 平直 | 共路線的相鄰段穿站直行（夾角 → π）；只算**共享 route 的邊對** | 220 |
| c_N5 八方向 | \|sin(4θ)\| | 9250 |

## 硬規則（違反即否決候選，全部整數格精確幾何）

1. **邊界**：0 ≤ c < cols、0 ≤ r < rows，且**一格一頂點**（cellOwner）。
2. **相對位置**：對每個鄰居保持象限（符號不得翻轉；原本在象限邊界 sign=0 → 兩側皆可）。
3. **無遮蔽**：候選點不落在他段上、移動後的段不吞掉其他頂點、不與不共端點的段相交
   （touch 也算，整數 orient/onSeg 精確判定）。
4. **邊環繞順序**：v 與每個鄰居的「入射段依角度的循環序」移動前後必須循環相等
   （度 ≤ 2 恆成立，跳過）。

## 群集移動（§6.1 超長邊群集）

超長邊 = 段長 > `hops×L`。以**非超長邊**做連通分量 → 每個真子集群集（≤200 頂點）
整體平移（半徑 min(R,3)），只檢查跨界硬規則、只重算邊界頂點±其外鄰的適應度。
**§6.2 折彎群集與 §6.3 二分割尚未實作**；**標籤準則（§7）不在範圍**——本管線的
站名標籤是 Style 開關、非佈局一級公民。

## H/V 最大化後處理（三個 tab，皆以 Hill Climbing 的 cellAfter 為輸入）

爬山完成後短距離移動彩色頂點、讓**水平/垂直段最多**（一段是 H/V ⇔ 兩端恰有一個
座標相同）。三者互相獨立、可比較，回傳同型 `{ cellAfter, stats }`，
`stats` 一律含 `hvBefore / hvAfter / segs / verts / moved`。三者都經
`iteratePost(build, ...)` **迭代到不動點**（餵自己的輸出直到一步都沒動，上限
`POST_ITER_CAP = 20`）——單跑一次不是不動點：直角爬山的半徑排程先用完、
軸對齊/整數規劃移動後會冒出新的可對齊機會（±k 視窗重新置中）。直角爬山由
單調適應度保證終止，另外兩個靠上限保底（實測全 224 城 ≤12 次收斂、無循環）。
迭代後 stats 另含 `iters / iterCap / converged`，tab 按鈕顯示「已迭代/上限」
badge、工具列顯示 迭代 n/20（達上限未收斂會標註）。共用機構：
`makeMover(pos, segs, inc, cols, rows)`（4 條硬規則＋移動原語，優化器同一套）與
`applyTargets(pos, M, targets, segs)`（目標座標經硬規則多輪套用：先試全目標、再
逐軸拆半；**淨 H/V 變差則整批退回** `reverted: true`）。

1. **直角爬山** `buildRectPolish(skeleton, cells, cols, rows, opts)`：
   再爬一次，c_N5 由 |sin 4θ| 換成 **|sin 2θ|**（`opts.rect`，45° 變最貴）、
   權重 ×3、半徑 `[2,1,1]`；其餘準則/硬規則/群集移動全同。
2. **軸對齊** `buildAxisAlign(...)`（`opts.maxShift` 預設 2）：方向指派＋座標指派。
   逐軸把「嚴格較貼近該軸（45° 不算）且 |垂距| ≤ 2·maxShift」的段做 union-find
   併群 → 每群取成員**中位數**座標（L1 最小移動；超出 maxShift 的成員逐輪剔除、
   中位數重算）→ applyTargets。stats 另含 `groupsH / groupsV / passes`。
3. **整數規劃** `buildAxisIlp(...)`（`opts.window` 預設 2）：逐軸 0-1 整數規劃
   **精確解**。可對齊段的端點各得一個 offset 變數 ∈ [-k,k]；目標 = 最大化對齊段數
   （位移總量當 tie-break）；象限不翻轉為 pairwise 約束。x/y 可分離 → 兩個獨立
   規劃；配對圖分連通元件，生成樹 DP 求解、環用小 feedback vertex set 枚舉
   （枚舉量超過上限該元件退回不動，計入 `fallback`）→ 跨軸硬規則（遮蔽/一格一點）
   進不了可分離規劃，靠 applyTargets 把關。stats 另含 `comps / fallback / passes`。
4. **LLM 對齊**（第四種，詳見 [[route-llm-align]]）：由 Claude Code 的模型離線
   當最佳化器（export → 提案 → `applyLlmTargets` 經同一套硬規則套用 → 存
   `data/metro/llmviews/`），網頁只載入；不迭代包裝（LLM 迴圈本身就是迭代）。

224 城實測（迭代到不動點後）：ILP 全網 H/V +47.8%、直角爬山 +42.9%、
軸對齊 +28.5%；最大迭代次數 rect 12 / ilp 8 / align 5，全數收斂；
單城最慢（NYC 直角爬山）約 1.4s。
每個後處理各有自己的縮減網格 tab（壓縮**該 pass 的原結果**）；
**「Hill Climbing縮減網格」本體 tab 與 RWD（compact='hc'）吃 端點拉直 的 cellAfter**
（hc 鏈 = HC → 端點拉直 → 縮減網格），不吃直角爬山/軸對齊/整數規劃/LLM 的結果。
另外「端點拉直」區塊每條鏈各有一個 tab（END_KIND：hc-end／hc-rect-end／hc-align-end／
hc-ilp-end／hc-llm-end）＝在該鏈結果之上再做端點拉直——**只是顯示視圖**，除 hc 外
不餵任何下游（縮減網格/RWD/llmGrid 都不吃）。

## 實作契約

- `buildHillClimb(skeleton, cellOf, cols, rows, opts)`：`skeleton` = connect 骨架
  （[[route-skeleton-connect]]）、`cellOf/cols/rows` 來自 `buildSchematicGrid`
  （[[route-skeleton-grid]]）。回傳 `{ cellAfter: Map<id,[col,row]>, stats }`，
  `stats = { before, after, rounds, moved, clusterMoves, idealHop, verts, segs,
  hvBefore, hvAfter }`。
- 三個後處理的 `cells` 參數＝上游的 `cellAfter`（同型 Map，直接餵給
  `buildHcGraph` 當 cellOf）；輸入 Map 不被改動、輸出是新 Map。
- `compactGrid(cellAfter, cols, rows)`：純函式，回傳
  `{ cellAfter, cols, rows, removedCols, removedRows }`——只重編排名，不動拓撲。
- **黑點不是頂點**：呼叫端把 cellAfter 換回像素後用 `placeBlacks(skeleton, posMap, snap)`
  （schematicGrid.js）沿新段平均放回。
- 格是排名制 → cellAfter 與視窗大小無關，D3Tab 只在 resize 重算像素映射並快取 cellAfter。
- 頂點含黃色交叉點；退化段（a===b 的小環）跳過。
- **跨 reload 持久快取（D3Tab.vue，localStorage `d3tab-hc-cache-v1`）**：爬山＋後處理
  （iteratePost）是最貴的計算，其輸出（cellAfter/stats，純資料、無畫布相依）依「資料
  內容指紋＋變體」存進 localStorage——關 tab 再開／新建同視圖／重新整理都直接載回、
  不重跑爬山（LLM 對齊視圖本來只為做指紋比對而跑爬山，載回快取後也免重算）。資料一變
  指紋就變 → 自動 miss 重算覆寫，永不載到舊佈局；quota／無痕模式 try/catch 靜默退回
  現算；LRU 上限 12 個佈局。**未涵蓋**：buildConnectSkeleton（識別耦合，仍重算，較便宜）
  與 RWD 佈線（buildRwdMap，像素相依）。

## 修改此轉換時

準則/硬規則/群集規則變動，**同步更新本 SKILL.md 與 `src/stores/hillClimb.js`**；
輸入契約變動（cellOf 等）同步 [[route-skeleton-grid]]。
