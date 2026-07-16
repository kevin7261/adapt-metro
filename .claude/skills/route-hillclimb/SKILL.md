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
- Tab 有 26 個視圖，左選單分 **8 個部份**（端點移動/直線縮減/中位集中/循環/
  逐步驗證 五區**沒有 hc 鏈**——只有 直角爬山/軸對齊/整數規劃/LLM 對齊 四條鏈
  各 4 tab，使用者 2026-07 裁決；RWD 底圖仍可建立在 hc 鏈的循環上——loop
  區塊的 isRWD fallback、key 'hc'）：**原始**（格網化後＝輸入）、
  **Hill Climbing**（結果）、**直線演算法**（四個 H/V 最大化後處理，**原樣、不含
  端點移動**：直角爬山／軸對齊／整數規劃＝本 skill 下節；**LLM 對齊**＝離線預算，
  見 [[route-llm-align]]，按鈕 badge 顯示「n輪 · 模型名」）、
  然後是每條鏈的**三步尾巴**（鏈 = 該鏈結果 → 端點移動 → 直線縮減 → 中位集中，
  每步一區、每條鏈一個 tab，前面的 tab 不受後面步驟影響。**縮減網格不再是
  獨立步驟——三個階段都是 movewise（`movewiseStage`）：每一個小步驟（單一
  移動）完成後就做 compactGrid**，網格隨時緻密、尺寸逐階段縮小）：
  **端點移動**（4 個，見下）、**直線縮減**（4 個，見下）、
  **中位集中**（4 個，見下）、
  **端點移動+直線縮減+中位集中循環**（4 個，每鏈一個：每輪＝三個演算法**各把
  整個 network 掃一遍**（movewiseSweep 一遍掃描，非各自跑到不動點）——端點移動
  一遍 → 直線縮減一遍 → 中位集中一遍 → 回到端點移動，某輪三個都沒改動才停，
  `straightenCompactLoop`，上限 LOOP_ROUND_CAP=200 輪，見下）、
  最後 **逐步驗證**（4 個，每鏈一個：手動逐步——浮動面板按「下一步」
  執行一步＝**目前演算法把整個 network 掃一遍**（movewiseSweep；掃完就換下一個
  演算法、掃不動也換，同一鍵內自動跳過空掃描）、「下一小步」＝**只做這一遍中的
  下一個單一移動**（limit=1＋opts.skip：本輪動過的元素不再動，sweepVisited 跨
  點擊延續同一遍）。
  階段：端點移動 → 直線縮減 → 中位集中；**每一步（含小步）完成後立即壓縮**
  （stepChainInit 連起點也先壓），畫面上的網格永遠緻密，步驟訊息尾巴標
  「縮減網格 a×b → c×d」。掃不動自動換下一階段、一輪三階段全沒動靜＝完成；
  「重設」回起點；**「上一小步」＝回退一個動作、「上一步」＝一路吞掉其後的
  小步、回退到上一個大步之前**（D3Tab 的 stepHistory[鏈] 復原堆疊存前一
  state 快照＋動作種類，state 是純資料、stepChainNext 不變異輸入 → pop 即
  還原；上限 400 筆）。`stepChainInit`/`stepChainNext(skeleton, state, {limit})`，
  state = { cells, cols, rows, stage, round, steps, done, lastStage, movedIds,
  moves, info }，D3Tab 存在 stepState[鏈]、非 reactive；面板顯示步數＋三階段
  chips（lastStage 亮起）＋這一步做了什麼。**前後比對**：moves =
  [{id, from, to}]（**縮減後 rank 空間**；from 的欄/列被壓掉時是 -0.5 半格，
  畫圖線性內插）——圖上舊位置畫虛線空心圈、虛線軌跡連到新位置、新位置橘色
  實圈；小步的訊息另附座標（單點 (c,r)→(c,r)、整條線顯示位移向量＋成員數，
  座標是移動當下、縮減前的值；大步不畫比對）。
  工具列在 hc 顯示適應度 before → after（越低越好）、輪數、移動站數/群集數，
  後處理 tab 顯示 水平垂直 before → after／總段數＋移動站數＋各自的演算法統計；
  端點移動/直線縮減/中位集中 tab 顯示 移動數＋水平垂直＋網格 from→to，
  每一個網格 tab（原始格網化後～循環，RWD 除外）的網格最底層都畫一個
  **黃色圓標（半徑固定 24pt）**＝該 tab 目前佈局所有有色點（頂點都非白；
  白/黑直通站不是頂點）欄、列各自中位數的位置（偶數個點取平均 → 可能落在
  半格，像素內插；cellMedian）。畫廊（hcviews）的端點移動卡片也有同款
  median 圓標（viewGeometry 輸出 `median`，改了要 bump VIEWS_VERSION 重算）。
- **跨距上限（所有移動共同守則）**：任何移動（端點移動的點移、直線縮減的線移、
  中位集中的點滑/線移）都**不得讓受影響段的兩個顏色點橫跨超過 SPAN_CAP=3 格**
  （Chebyshev max(|dx|,|dy|)；spanOk/boundarySpanOk）——防止兩個顏色點之間的線
  被拉太長。本來就超過上限的舊長段只准縮短或不變、不准再拉長（避免永久凍結）。
- **縮減網格**＝`compactGrid(cellAfter, cols, rows)`：把**整排/整欄沒有彩色點**的
  row/col 移除（欄列各自依排名重編號）——格網變小、欄列順序（＝拓撲與象限關係）不變；
  代價是壓縮後可能出現新的視覺交錯（rank 不變但幾何變了），與格網化的等距排名同屬下游議題。
  **不再是獨立步驟／tab**——由 `movewiseStage(stage, skeleton, cells, cols, rows)`
  內嵌：以 limit=1 反覆呼叫該階段的單掃描 pass，**每一個移動後立即 compactGrid**
  （起點也先壓），到動不了為止（MOVEWISE_CAP=5000 保險）。回傳
  { cellAfter, cols, rows, stats:{ hvBefore/hvAfter/segs/verts/moved/movedPts/
  movedLines/fromCols×fromRows→cols×rows/converged } }。
- **端點移動**（鏈第 1 步）＝movewiseStage('endp')——單掃描 pass 是
  `buildEndpointStraighten(skeleton, cells, cols, rows, {limit})`，輸入是該鏈的結果佈局。
  **每個非白點（所有彩色頂點——端點/轉乘/分歧/黃色交叉；白/黑直通站不是頂點）
  都可移動**：候選＝四個 1 格單位移動（**每次移動不可超過 1 格**——1 格上限下
  「吸到鄰居欄/列」的有效候選就是這些；遠處的對齊靠 movewise 逐移動壓縮把
  距離拉近後慢慢完成）。採納條件二擇一：「自身入射段的 H/V 淨增 > 0」（全圖
  H/V 單調遞增；非入射段不受影響，不需 net-HV 退回），或「**H/V 數不變、但
  直線變長且斜線變短**（兩者都嚴格改善——典型是直線接斜線的轉折點沿直線方向
  推一格）」，或「**v 是藍點（單一入射段）且線變短**（把端點往鄰居收）」——
  收斂：每步讓 (−H/V 數, 斜線長, 總長) 字典序嚴格下降；且**既有的 H/V 段只有在「同一步有同路線的段被拉直」時才准折彎**
  （bendsPaid——犧牲 X 線的直段去拉直 Y 線即使淨增也不行）。每步走 makeMover
  的**同一套硬規則**（不新增交叉、不壓到別的線/點、
  象限與邊環繞序不變）。tie-break：淨增大者 → 順著同 route 在鄰居另一側已是
  H/V 的段接直 → 位移小者。**下游**：RWD 底圖與 llmGrid 建立在該鏈**循環**
  （straightenCompactLoop）的結果上（`layer.compact` 選鏈；使用者 2026-07 裁決）。
  畫廊（hcviews）每城 8 視圖（HC_VIEW_ORDER，卡片 2×4：格網化後→Hill Climbing→
  端點移動→直線縮減＋中位集中 ×2 變體，全部 movewise）。
- **直線縮減**（鏈第 2 步）＝movewiseStage('line')——單掃描 pass 是
  `lineCompactPass`，輸入是該鏈「端點移動後」的佈局：把**直線**——同軸共線段經 union-find 串成的
  連通元件，**跨相交點串接**（轉乘/分歧/黃色交叉點若被直線直穿就一起動）——
  整條剛體平移，**只准垂直於線移動**（水平線只能上下移、垂直線只能左右移），
  只採納「**嚴格減少佔用欄數＋列數**（＝之後縮減網格能壓到的大小）」且
  「**整個 network 的 H/V 段數不減**（剛體平移只有邊界段會變，其淨變 ≥ 0）」
  的平移，並走爬山法群集移動的**同一套 validShift 硬規則**（不新增交叉/遮蔽、
  象限與邊環繞序不變）→「網格越少越好、network 結構不變、直線不變少」。
  候選＝垂直於線 **±1（一次只能移一格，使用者規則）**——movewise 下網格隨時
  緻密、相鄰欄列必有佔用，逐格合併即可。tie-break：縮越多 → 邊界段 H/V 淨增
  大者。movewise：每個移動後立即壓縮；每步嚴格縮小網格（有下界）→ 保證收斂。
- **中位集中**（鏈第 3 步）＝movewiseStage('gather')——單掃描 pass 是
  `medianGatherPass`，輸入是該鏈「直線縮減後」的佈局，兩種移動都**往中位點**（黃色圓標＝全頂點
  欄列中位數）：①**任何有色頂點，只要入射段 ≤2 且同軸**（左右兩段皆水平 →
  只可左右移往中位欄；上下兩段皆垂直 → 只可上下移往中位列；紅轉乘/紫切點
  躺在直線上也算，**藍端點單段必可動、但不得把線拉長**——否則會和端點移動的
  「線變短就收」在循環裡拉鋸，收線方向優先）就沿線滑動；真轉折（一橫一豎）與
  ≥3 段的分歧/黃交叉不動；每步走 makeMover 同一套
  validMove 硬規則（不壓點/不跨線、象限不變 → 滑不過鄰居）。②**串起來的
  直線**（lineComponents，同直線縮減的跨相交點串接）整條**垂直於線**往中位
  點移（水平線上下往中位列、垂直線左右往中位欄），須全網 H/V 不減
  （boundaryHvDelta ≥ 0）、不增加佔用欄列數（否則吐回直線縮減的成果、在循環
  裡互相拉扯）、走 validShift 硬規則。兩種移動都不減 H/V，且**一次只能移動
  一格**（使用者規則）：朝中位點跨一步、不越過中位點；movewise：每個移動後
  立即壓縮、中位數每次重算，到沒有點/線可動為止。stats 含 movedPts/movedLines。
- **端點移動+直線縮減+中位集中循環**＝`straightenCompactLoop(skeleton,
  cells, cols, rows)`：在該鏈結果之上每輪跑**三個一遍掃描（movewiseSweep：
  每個元素本輪最多動一次、每一個移動後仍立即壓縮）**，跑到某輪**三者都沒有
  改動**為止（上限 LOOP_ROUND_CAP=200 輪；一遍掃描制的輪數比階段固定點制多）。每個移動後的壓縮持續重編欄列座標——硬規則的阻擋
  （遮蔽/壓點）跟著變，階段間/輪間不斷解鎖新的移動。拉直嚴格增加 H/V
  （上界＝段數）、直線縮減嚴格縮小網格（有下界）；集中滑動 H/V 中性，靠輪數
  上限擋滑動/中位數震盪。回傳 stats 含 rounds/moved（端點移動）/lineMoved
  （直線縮減）/gatherMoved（中位集中）/hvBefore→hvAfter/
  fromCols×fromRows→cols×rows/converged。**RWD 底圖與 llmGrid 建立在循環
  結果之上**（RWD 圖層第一個 tab「循環結果」沿用 id 'hc-compact'）。

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
每條鏈（hc／rect／align／ilp／llm）各有自己的縮減網格 tab，且一律壓縮
**該鏈「端點移動後」的結果**（鏈 = 該鏈結果 → 端點移動 → 縮減網格）；
RWD 底圖與 llmGrid 也吃同一條鏈（`layer.compact` 選鏈）。
另外「端點移動」區塊每條鏈各有一個 tab（END_KIND：hc-end／hc-rect-end／hc-align-end／
hc-ilp-end／hc-llm-end）＝在該鏈結果之上做端點移動的顯示視圖，
與縮減網格吃的是同一份結果（cachedEndp 同 key 共用）。

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
