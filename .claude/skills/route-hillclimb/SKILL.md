---
name: route-hillclimb
description: Hill Climbing 多準則佈局最佳化（②，Stott et al. 2011）——以 Map Adjust「格網化後」的整數格佈局為輸入，用加權多準則適應度（角解析度/邊長/平衡邊長/平直/八方向）＋4 條硬規則（邊界/象限/遮蔽/邊環繞序）做爬山搜尋，含冷卻與超長邊群集移動；黑點沿新邊平均放回。另含「直線演算法」H/V 最大化後處理 tab——論文①〜⑧＋LLM 對齊共 9 條（①筆畫法/②直角爬山/③MILP規劃/④力導向/⑤最小平方/⑥八向格網/⑦路徑簡化/⑧SAT規劃，短距離移動彩色點讓水平垂直段最多；名稱與 data/thesis 論文一一對應，見 route-paper-align）。當使用者要求爬山法最佳化、hill climbing、多準則佈局、水平垂直最大化後處理、或在 Hill Climbing layer group 加/改視圖時使用。實作在 src/stores/hillClimb.js（純函式）＋ D3Tab 的 hillclimb 圖層模式。
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
  →（可選）⑨ LLM 成方已「執行調整」→ 以 llmshapes 座標（含綠折）取代 cellOf
     ＋凍結成方頂點（規定 ring 站＋綠折）＝固定方形，下游全鏈都不改它
  → buildHillClimb：頂點 = 切點、邊 = 切點間直線小段（共走廊多路線仍 1 段＋routes metadata）
  → cellAfter（新整數格）→ D3Tab 用同一套等寬格心換回像素 → placeBlacks 放回黑點
  → 直線演算法／端點移動…一路往下（輸入＝HC，故會跟著成方走）
```

有 [[route-llm-shape]] 結果且套用時，② 標籤顯示「←LLM成方」；詳見該 skill。

**固定方形（② 吃 LLM 成方時）**：成方路段的頂點一律凍結、下游全鏈（爬山＋①〜⑧＋
端點/直線/合併/循環/逐步/RWD）都不改變這個方形。機構＝模組級 `FROZEN`＋`setFrozen(set)`
（比照 movewise `SPAN_CAP`），`makeMover` 建構時擷取：`validMove` 擋凍結頂點單點移動、
`validShift` 擋含凍結頂點的群集平移——所有下游都經 `makeMover` 唯一關口故一次生效。
凍結集＝規定表 `stations`＋本輪 `greens` id；`D3Tab.computeHcLayout` 只在真下游
`setFrozen(frozenIds)`（layout-* 比較視圖已先 return、不凍結），非成方輸入為 null。
詳見 [[route-llm-shape]]。

- 新圖層由 Layers 面板 Hill Climbing group 的 **+** 建立：選一個 Map Adjust 圖層＋
  變體（原始/旋轉格網化後），存在 `layer.sourceLayerId`（d3 圖層 id）＋ `layer.variant`。
- Tab 有多個視圖，左選單分組——分組標題可點開合（手風琴，預設只
  展開含目前視圖的組；Map Adjust／RWD 的左選單共用同一套分組版面）——（端點移動/直線縮減/網格合併/循環/
  逐步驗證 五區**沒有 hc 鏈**——只有論文①〜⑧＋LLM 對齊 九條鏈；
  **Shape-Guided** 另掛在循環與逐步之間，只對①〜⑧循環結果，見 [[route-shape-align]]）
  （見 [[route-paper-align]]）各 9 tab，使用者 2026-07 裁決；RWD 底圖仍可建立在
  hc 鏈的循環上——loop 區塊的 isRWD fallback、key 'hc'）：**原始**（格網化後＝
  輸入）、**Hill Climbing**（**8 個主佈局比較**：①筆畫法／②Hill Climbing／③MILP／
  ④力導向／⑤最小平方／⑥八向格網／⑦路徑簡化／⑧SAT——皆以格網化後為輸入；
  左側標籤特別註記：**②Hill Climbing（往後執行）**＝真正的多準則爬山、下游唯一
  來源；其餘 7 個標 **（僅比較）**＝論文鏈 build 直接餵格網，mode=`layout-<kind>`；
  直線演算法／端點移動／RWD 仍只吃 `hc`）、
  **直線演算法**（9 個 H/V 最大化後處理，
  **原樣、不含端點移動**：①〜⑧＝[[route-paper-align]]（②直角爬山＝本 skill 下節）；
  **LLM 對齊**＝離線預算，
  見 [[route-llm-align]]，按鈕 badge 顯示「n輪 · 模型名」）、
  然後是每條鏈的**三步尾巴**（鏈 = 該鏈結果 → 端點移動 → 直線縮減 → 網格合併，
  每步一區、每條鏈一個 tab，前面的 tab 不受後面步驟影響。**縮減網格不再是
  獨立步驟——三個階段都是 movewise（`movewiseStage`）：每一個小步驟（單一
  移動）完成後就做 compactGrid**，網格隨時緻密、尺寸逐階段縮小）：
  **端點移動**（9 個，見下）、**直線縮減**（9 個，見下）、
  **網格合併**（9 個，見下）、
  **端點移動+直線縮減+網格合併循環**（9 個，每鏈一個：每輪＝三個演算法**各把
  整個 network 掃一遍**（movewiseSweep 一遍掃描，非各自跑到不動點）——端點移動
  一遍 → 直線縮減一遍 → 網格合併一遍 → 回到端點移動，某輪三個都沒改動才停，
  `straightenCompactLoop`，上限 LOOP_ROUND_CAP=200 輪，見下）、
  最後 **逐步驗證**（9 個，每鏈一個：手動逐步——浮動面板按「下一步」
  執行一步＝**目前演算法把整個 network 掃一遍**（movewiseSweep；掃完就換下一個
  演算法、掃不動也換，同一鍵內自動跳過空掃描）、「下一小步」＝**只做這一遍中的
  下一個單一移動**（limit=1＋opts.skip：本輪動過的元素不再動，sweepVisited 跨
  點擊延續同一遍）。
  階段：端點移動 → 直線縮減 → 網格合併；**每一步（含小步）完成後立即壓縮**
  （stepChainInit 連起點也先壓），畫面上的網格永遠緻密，步驟訊息尾巴標
  「縮減網格 a×b → c×d」。掃不動自動換下一階段、一輪三階段全沒動靜＝完成；
  「重設」回起點；**「上一小步」＝回退一個動作、「上一步」＝一路吞掉其後的
  小步、回退到上一個大步之前**（D3Tab 的 stepHistory[鏈] 復原堆疊存前一
  state 快照＋動作種類，state 是純資料、stepChainNext 不變異輸入 → pop 即
  還原；上限 400 筆）。`stepChainInit(skeleton, cells, cols, rows)`/
  `stepChainNext(skeleton, state, {limit})`，
  state = { cells, cols, rows, stage, round, steps, done, lastStage, movedIds,
  moves, info }，D3Tab 存在 stepState[鏈]、非 reactive；面板顯示步數＋三階段
  chips（lastStage 亮起）＋這一步做了什麼。**前後比對**：moves =
  [{id, from, to}]（**縮減後 rank 空間**；from 的欄/列被壓掉時是 -0.5 半格，
  畫圖線性內插）——圖上舊位置畫虛線空心圈、虛線軌跡連到新位置、新位置橘色
  實圈；小步的訊息另附座標（單點 (c,r)→(c,r)、整條線顯示位移向量＋成員數，
  座標是移動當下、縮減前的值；大步不畫比對）。
  工具列在 hc 顯示適應度 before → after（越低越好）、輪數、移動站數/群集數，
  後處理 tab 顯示 水平垂直 before → after／總段數＋移動站數＋各自的演算法統計；
  端點移動/直線縮減/網格合併 tab 顯示 移動數＋水平垂直＋網格 from→to，
  （中位點已停用：網格合併重定義後不再計算，黃色中位圓標一併移除，2026-07。）
- **跨距上限（所有移動共同守則）**：見 [[route-span-cap]]（樣式 tab 手動輸入
  ＋「重新計算」套用，per-layer、預設 3）。
- **縮減網格**＝`compactGridSafe`：整排/整欄沒有彩色點的 row/col 移除——但每個
  移除都走 validShift 硬規則（移除空欄＝右半平面左移 1 格，跨縫段會變形、可能
  壓點/交叉/重疊），會出事的空帶**保留**（純排名版 `compactGrid` 僅存為內部原始
  實作，movewise／逐步驗證不再用）。
  **不再是獨立步驟／tab**——movewise 內嵌（每一個移動後立即壓縮），
  見 [[route-movewise-loop]]。
- **端點移動**（鏈第 1 步）：見 [[route-endpoint-move]]。
- **直線縮減**（鏈第 2 步）：見 [[route-line-compact]]。
- **網格合併**（鏈第 3 步，原「中位集中」）：見 [[route-grid-merge]]。
- **循環**（三演算法各掃一遍輪替）與 RWD／llmGrid 下游：見 [[route-movewise-loop]]。
- **逐步驗證**（下一步/下一小步/上一步/前後比對）：見 [[route-step-verify]]。

## 主迴圈（論文 Algorithm 1）

逐頂點掃描以自身為中心、半徑 R 的矩形內所有格點 → 取局部適應度最低且通過硬規則者；
再做**群集移動**；一整輪無改善、或一整輪後總適應度不再下降即收斂。
**冷卻**：R 從 8 起（論文表 4「最大站移動 8」）每輪 −1、最低 1，最多 5 輪
（表 4「迭代輪數 5」）；可用 `opts.maxMove` / `opts.maxRounds` 覆寫。
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
   **③′ 群集平移的變形段檢查（大邱重疊案 2026-07）**：剛性平移下兩端同動或全靜態
   的段相對幾何不變，唯一會「變形」的是**恰一端在群集內**的段——validShift 對每條
   變形段補檢：不得吞任何頂點（**含群集內頂點**，舊檢查只看靜態頂點）、不得與任何
   不共端點的段（含整體移動段、其他變形段）相交或共線重疊。共端點的共線重疊由吞
   頂點檢查涵蓋（較短段的遠端必在較長段上）。
4. **邊環繞順序**：v 與每個鄰居的「入射段依角度的循環序」移動前後必須循環相等
   （度 ≤ 2 恆成立，跳過）。

**不變式：整條鏈不新增 壓點/交叉/共線重疊**——單點移動（validMove）、群集平移
（validShift ③′）、movewise 三演算法、與**每步後的縮減網格**（`compactGridSafe`：
移除空欄＝右半平面左移 1 格＝validShift 同一套硬規則，會出事的空帶保留、畫面略寬）
全部把關。輸入（格網化後）既有的重疊只會持平或減少、不會增加；要全零得從
[[route-skeleton-grid]] 的排名吸附下手（尚未做）。

## 群集移動（§6.1 超長邊群集 ＋ §6.2 折彎群集）

- **§6.1 超長邊群集**：超長邊 = 段長 > `hops×L`。以**非超長邊**做連通分量 →
  每個真子集群集（≤200 頂點）整體平移（半徑 R），只檢查跨界硬規則、只重算邊界
  頂點±其外鄰的適應度。
- **§6.2 折彎群集**：度 2 且兩鄰段共路線的頂點 v，若 `∠(u→v, u→w) > 22.5°`
  （＝八方向間隔的一半，c_N5 的 |sin 4θ| 峰值處）就是 kink，`{v}` 自成一個群集
  單獨平移——單點移動被其他準則卡住的小歪折靠它拉直。
- **§6.3 二分割**（對偶圖切割）論文列為選配，未實作。

**標籤準則（§7）不在範圍**——本管線的站名標籤是 Style 開關、非佈局一級公民。

## H/V 最大化後處理（直線演算法＝論文①〜⑧＋LLM 對齊，皆以 Hill Climbing 的 cellAfter 為輸入）

爬山完成後短距離移動彩色頂點、讓**水平/垂直段最多**（一段是 H/V ⇔ 兩端恰有一個
座標相同）。各鏈互相獨立、可比較，回傳同型 `{ cellAfter, stats }`，
`stats` 一律含 `hvBefore / hvAfter / segs / verts / moved`。全部經
`iteratePost(build, ...)` **迭代到不動點**（餵自己的輸出直到一步都沒動，上限
`POST_ITER_CAP = 20`）——單跑一次不是不動點：直角爬山的半徑排程先用完、
target 型鏈移動後會冒出新的可對齊機會（±k 視窗重新置中）。直角爬山由
單調適應度保證終止，其餘靠上限保底（實測全 224 城 ≤12 次收斂、無循環）。
迭代後 stats 另含 `iters / iterCap / converged`，tab 按鈕顯示「已迭代/上限」
badge、工具列顯示 迭代 n/20（達上限未收斂會標註）。共用機構：
`makeMover(pos, segs, inc, cols, rows)`（4 條硬規則＋移動原語，優化器同一套）與
`applyTargets(pos, M, targets, segs)`（目標座標經硬規則多輪套用：先試全目標、再
逐軸拆半；**淨 H/V 變差則整批退回** `reverted: true`）。

1. **②直角爬山** `buildRectPolish(skeleton, cells, cols, rows, opts)`（＝論文②
   Stott 爬山法的直角變體，PAPER_KINDS 以 kind 'rect' 掛載）：
   再爬一次，c_N5 由 |sin 4θ| 換成 **|sin 2θ|**（`opts.rect`，45° 變最貴）、
   權重 ×3；冷卻/輪數/準則/硬規則/群集移動全同論文本體。
2. **其餘論文鏈 ①③④⑤⑥⑦⑧**（詳見 [[route-paper-align]] 與各自 skill）：
   `src/stores/paperAlign.js`，同契約、同 `iteratePost` 包裝；接受準則用
   `countHVD`——八方向系演算法，45° 不算退步。
   `countHV/countHVD/makeMover/applyTargets` 因此由 hillClimb.js **export**
   供 paperAlign.js 重用。
3. **LLM 對齊**（第九種，詳見 [[route-llm-align]]）：由 Claude Code 的模型離線
   當最佳化器（export → 提案 → `applyLlmTargets` 經同一套硬規則套用 → 存
   `data/metro/llmviews/`），網頁只載入；不迭代包裝（LLM 迴圈本身就是迭代）。

（**已下架（2026-07）**：自創的軸對齊與整數規劃鏈——不對應任何 data/thesis
論文，使用者裁決直線演算法只留與論文一一對應的 8 條＋LLM；實作已從
`hillClimb.js` 移除。paperAlign 的 MILP/SAT 沿用其生成樹 DP＋feedback 枚舉機構。）

每條鏈各有自己的縮減網格 tab，且一律壓縮
**該鏈「端點移動後」的結果**（鏈 = 該鏈結果 → 端點移動 → 縮減網格）；
RWD 底圖與 llmGrid 也吃同一條鏈（`layer.compact` 選鏈）。
另外「端點移動」區塊每條鏈各有一個 tab（`hc-<kind>-end`）＝在該鏈結果之上做
端點移動的顯示視圖，與縮減網格吃的是同一份結果（cachedEndp 同 key 共用）。

## 實作契約

- `buildHillClimb(skeleton, cellOf, cols, rows, opts)`：`skeleton` = connect 骨架
  （[[route-skeleton-connect]]）、`cellOf/cols/rows` 來自 `buildSchematicGrid`
  （[[route-skeleton-grid]]）。回傳 `{ cellAfter: Map<id,[col,row]>, stats }`，
  `stats = { before, after, rounds, moved, clusterMoves, idealHop, verts, segs,
  hvBefore, hvAfter }`。
- 各後處理鏈的 `cells` 參數＝上游的 `cellAfter`（同型 Map，直接餵給
  `buildHcGraph` 當 cellOf）；輸入 Map 不被改動、輸出是新 Map。
- `compactGrid(cellAfter, cols, rows)`：純函式，回傳
  `{ cellAfter, cols, rows, removedCols, removedRows }`——只重編排名，不動拓撲。
- **黑點不是頂點**：呼叫端把 cellAfter 換回像素後用 `placeBlacks(skeleton, posMap, snap)`
  （schematicGrid.js）沿新段平均放回。
- **移動後視圖的畫線走 skeleton 拓撲邊、不走原始 feature 幾何**（格網化後／Hill
  Climbing／端點移動／直線縮減／網格合併／縮減網格，皆同）：D3Tab `edgeD(e.path)`＋
  viewGeometry `edgeLinesFromPos(skeleton, posOf)`，逐 `skeleton.edges` 的 path 用搬移後
  座標連線、共線多色交錯依 `e.routeColors`（`strokesOf`），與 RWD／原始一致。**為何不用
  feature 幾何**：一條路線的 feature 幾何含它「只通過、不停靠」的 pass 站（如香港機場
  快綫 AEL 實體軌道經 東涌／欣澳），這些站被吸到自己路線（東涌綫）的格子、遠離本線停靠
  鏈——逐 feature 頂點畫會把線拉去繞經它們，讓白色**直通站**（機場站）落在折角（使用者
  回報的「香港機場站轉折」bug，2026-07 修正）。skeleton 邊的 path 已排除 pass 站、黃色
  交叉點是邊端點 → edgeD 自然穿過交叉、直通站沿邊內插保持共線、不繞行。移動後視圖**不
  畫**邊分類襯底（hl=[]，共線僅靠交錯虛線表示）；地理視圖（原始／骨架／格網化前）仍用
  feature 幾何 `path(f)`＋沿 `e.geom` 的邊分類襯底（那裡 pass 站在真實軌道上、不會繞行）。
  改這段畫線程式必須把 `scripts/buildViews.mjs` 的 `VIEWS_VERSION` 遞增、重跑 metro:views
  （否則畫廊縮圖沿用舊圖）。
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

## 爬山結果的 localStorage 快取（HC_LS_KEY，2026-07-17 Kilburn 案）

D3Tab 把爬山＋後處理結果存 localStorage（鍵＝`HC_LS_KEY` store × `資料指紋:variant`）。
**資料指紋只看資料**——資料沒變但**演算法變了**（骨架建圖、格網、爬山任一）時，舊快取的
佈局與新骨架結構對不上：節點缺格子 → RWD/HC **整段線消失、站點退回舊座標懸空**（倫敦
Kilburn／Jubilee×Met 走廊案）。且 localStorage 不隨 dev server 重啟或硬重載清除、殘留跨天，
極難用「重新整理」排除。兩道防線（`D3Tab.vue`）：
1. **改了 `skeleton.js`／`schematicGrid.js`／`hillClimb.js` 的演算法就把 `HC_LS_KEY` 版本 +1**
   （v3＝骨架建圖含 pass）。
2. **use-time 結構驗證**：快取的 `cellAfter` 必須涵蓋目前 `grid.cellOf` 的所有節點，否則作廢
   重算——就算忘了 +1 也不會再出現殘缺畫面。
