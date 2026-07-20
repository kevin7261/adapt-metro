# Adapt-Metro — 全球地鐵響應式示意圖系統

把**真實路網**一步步變成**響應式示意圖**（schematic map）的純前端系統：
OpenStreetMap 抓取的路網——**234 座城市地鐵／輕軌**、**12 國國家鐵路**（含高鐵/新幹線）、
**高速公路網**——經過「拓撲骨架化 → 整數格網化 → 多準則爬山最佳化＋**三步鏈循環壓縮**
（端點移動 → 直線縮減 → 網格合併）→ 嚴格方向約束畫線（**4／8／16 方向**可選，預設
H/V/45° 八向）」四個階段，全部在瀏覽器內以**純函式、確定性、零求解器依賴**完成——
每一個單一移動都能逐步檢視，版面一變（resize、裝置版面模擬、權重、魚眼放大鏡），
圖就在新的像素座標重新求解。

三條資料管線（Metro／Railway／Highway）**schema 相同、下游共用同一套演算法與渲染器**；
railway 與 highway 是 metro 的「軌道／道路對應版」，概念一一對應（見〈[三條並列資料管線](#三條並列資料管線)〉）。

- **線上版**：<https://kevin7261.github.io/adapt-metro/>
- **系統介紹投影片**：`/slides/`（純靜態白底 HTML，含演算法與資料格式，鍵盤／觸控翻頁）
- **技術堆疊**：Vue 3 + Pinia + Vite、MapLibre GL（地理底圖）、D3 v7（示意圖渲染）、
  dockview-vue（分頁）、`marked`（Markdown）、純 Node.js 資料管線（`scripts/`，無外部相依）

---

## 目錄

1. [快速開始](#快速開始)
2. [介面導覽](#介面導覽)
3. [四階段管線](#四階段管線)
4. [三條並列資料管線](#三條並列資料管線)
5. [資料管線（fetch ⇄ audit）](#資料管線fetch--audit)
6. [資料格式](#資料格式)
7. [LLM 離線整合](#llm-離線整合)
8. [專案結構](#專案結構)
9. [效能與快取](#效能與快取)
10. [演算法文獻與定位](#演算法文獻與定位)
11. [授權與資料來源](#授權與資料來源)

---

## 快速開始

```bash
npm install
npm run dev        # http://localhost:5173（dev server 直接掛載 data/ 與 .claude/skills/）
npm run build      # 產出 dist/（slides/ 會原樣複製進 dist/slides/）
npm run deploy     # build:pages + gh-pages 部署到 GitHub Pages（base=/adapt-metro/）
```

需求：Node.js ≥ 18。資料檔已隨 repo 附上（`data/metro/`，約 54 MB GeoJSON＋預算縮圖），
**不需要**先跑資料管線就能啟動介面。要重抓／更新資料見〈[資料管線](#資料管線fetch--audit)〉。

---

## 介面導覽

介面外殼源自 [GeoLibre](./GeoLibre-main)（shadcn 風格 HSL design token，見 `src/style.css`），
核心概念是「**圖層即產線**」——Layers 面板中每個圖層群組對應管線的一個階段，
可逐步檢視、比較、回溯，不是黑盒子一次生成：

| 區域 | 內容 |
|---|---|
| 頂部選單列 | Project／Edit／View／Add Data／Processing／Controls／Plugins／Settings／Help，右側深淺色切換 |
| 左側 Layers 面板 | 圖層群組（Metro Maps／Railways／Highways／Map Adjust／Straighten／RWD Maps）＋圖層樹、顯示切換、每層動作選單 |
| 中間編輯區 | Dockview 多分頁：MapLibre 地理地圖、D3 示意圖分頁（每個圖層一個 tab，左側可捲動的視圖清單）、城市畫廊 |
| 分頁工具列（StyleBar） | 第 1 排：線寬/半徑/站名/軌道底圖/路線中線等顯示開關；第 2 排依視圖切換——**Straighten**：顏色點間最大跨距（SPAN_CAP 只約束爬山 movewise）；**RWD**：方向數（4/8/16）、版面（裝置預設模擬）、網格（均勻/方形/權重）、權重數字、車站白點/最小站距、隨機權重、放大鏡（魚眼） |
| 右側 Style 面板 | 依分頁型態切換的 tab：資訊／樣式／物件／（RWD）LLM互動・LLM評價・LLM比較／（Straighten）LLM自動對齊・LLM指定對齊 |
| 底部屬性表／狀態列 | 可排序過濾的 feature 屬性表；座標／Zoom／每個視圖的演算法統計讀數（直線/單折/雙折/多折/共線/殘留衝突…） |
| 指令面板 | `⌘K`；快捷鍵表 `?` |

三個**城市畫廊**（Map Adjust＝8 視圖、Hill Climbing＝8 視圖、RWD Maps＝8 視圖）
的縮圖全部**離線預算**（見 [資料格式](#資料格式) 的 `views/`），點卡片即建立對應圖層分頁。

---

## 四階段管線

> 每一階段都是純函式：同一份輸入永遠得到同一份輸出（無亂數）。
> 唯一例外是選用性的 LLM 對齊／LLM 調整——離線預算、存檔、網頁只載入。
> 每個演算法都有對應的 skill（`.claude/skills/route-*`）作為實作契約。

### Stage 1 · Metro Maps（真實路網輸入）

匯入某城市的 GeoJSON（原始地理座標、官方線色），畫在 MapLibre 底圖上。
資料的抓取、清理、驗證見〈[資料管線](#資料管線fetch--audit)〉。

### Stage 2 · Map Adjust（骨架與整數格）

- **骨架化**（`src/stores/skeleton.js`，skill `route-skeleton-connect`）：
  拓撲收縮、不拉直、不新增——以 route 站序建無向圖，節點依 degree 分
  紅（分歧/轉乘）／藍（端點）／黑（直通），幾何真交叉補黃點，
  degree-2 黑點鏈收成一條保留原折線的「邊」，再標紫（切點）／粉紅（代表性轉折）／灰（分隔）。
  跳站特快段的折點不是車站：拓撲一律由停靠站建圖、畫線一律用原始幾何。
- **示意格網化**（`src/stores/schematicGrid.js`，skill `route-skeleton-grid`）：
  彩色點以 x/y「排名」吸附到整數格（一格一點、撞格 Chebyshev 外擴），
  每條路線在彩色點切開、端點吸附、黑點沿新段平均放回。
  格網規模依城市而異（台北約 68×68、北京約 169×169、紐約約 160×160）。

### Stage 3 · Straighten（爬山最佳化＋三步鏈循環壓縮）

本階段分兩層：**先**依 Stott et al. (2011) 的多準則爬山把佈局整理好，**再**用一條
自製的「movewise 三步鏈」把網格壓到最小、線拉到最直——後者是本系統的核心貢獻
（定位論述見〈[演算法文獻與定位](#演算法文獻與定位)〉）。
實作全部在 `src/stores/hillClimb.js`（純函式）；D3 分頁左選單分 **8 個部份、26 個視圖**：

| 部份 | 視圖 | 內容 |
|---|---|---|
| 原始 | 格網化後 | Stage 2 的輸出（輸入基準） |
| Hill Climbing | Hill Climbing | 5 準則（角解析度/邊長/平衡/平直/八方向）＋4 硬規則（邊界/象限/遮蔽/邊環繞序）逐頂點爬山，半徑 [2,1,1] 冷卻，超長邊群集平移（skill `route-hillclimb`） |
| 直線演算法 | 直角爬山／軸對齊／整數規劃／LLM 對齊 | 四種 H/V 最大化後處理（＝四條「鏈」），互相獨立可比較，共用同一套硬規則，各自迭代到不動點（skills `route-rect-polish` / `route-axis-align` / `route-axis-ilp` / `route-llm-align`） |
| 端點移動 | 每條鏈一個 tab（共 4 個） | 三步鏈第 1 步（skill `route-endpoint-move`） |
| 直線縮減 | 每條鏈一個 tab（共 4 個） | 三步鏈第 2 步（skill `route-line-compact`） |
| 網格合併 | 每條鏈一個 tab（共 4 個） | 三步鏈第 3 步（skill `route-grid-merge`） |
| 端點移動+直線縮減+網格合併循環 | 每條鏈一個 tab（共 4 個） | 三個演算法各掃整個 network 一遍、輪替到全靜止（skill `route-movewise-loop`） |
| 逐步驗證 | 每條鏈一個 tab（共 4 個） | 一鍵一步看演算法怎麼收斂（skill `route-step-verify`） |

**movewise 三步鏈**（skill `route-movewise-loop`）的共同機構：

- **每一個單一移動完成後立即縮減網格**（`compactGrid`：移除整排/整欄沒有彩色點的
  欄列、排名重編）——縮減不是獨立步驟，網格隨時緻密、尺寸逐移動縮小；
- **一次只能移動一格**（三個演算法一致）；
- **跨距上限**（skill `route-span-cap`）：任何移動不得讓受影響段的兩個顏色點橫跨
  超過 n 格（Chebyshev，Straighten 工具列「線段最大跨距」輸入、預設 3、改數字即
  重算——SPAN_CAP **只約束爬山 movewise**，RWD 畫線不用；本來就超過上限的舊長段
  只准縮短不准拉長）；
- **拓撲鐵律**：所有移動走同一套硬規則（不壓點、不新增交叉、不產生路線重疊、
  象限與邊環繞序不變）——版面怎麼壓，拓撲與相對位置關係都不變。

三個演算法各自的規則與收斂保證：

| 步 | 演算法 | 移動 | 採納條件 | 收斂單調量 |
|---|---|---|---|---|
| 1 | **端點移動** | 每個非白點移 1 格（四方向） | 三擇一：入射段 H/V 淨增＞0；H/V 不變但「直線變長且斜線變短」；藍點（單段）「線變短」。另有 bendsPaid 護欄：既有直段只有同路線同步被拉直才准折彎 | (−H/V 數, 斜線長, 總長) 字典序嚴格下降 |
| 2 | **直線縮減** | 跨相交點串接的整條直線垂直平移 ±1（水平線只上下、垂直線只左右） | 嚴格減少佔用欄列數，且全網 H/V 段數不減 | 網格欄列數嚴格遞減 |
| 3 | **網格合併** | 相鄰 row 兩兩合併、col 兩兩合併（半平面整體移 1 格、自帶壓縮） | validShift 硬規則全過（不壓點/不新增交叉/拓撲不變）；附帶保證跨距只縮不增、H/V 只增不減 | 網格欄列數每次 −1 |

**循環**＝每輪「端點移動掃整個 network 一遍 → 直線縮減掃一遍 → 網格合併掃一遍」
輪替（一遍掃描中每個元素最多動一次），某一輪三個演算法都沒有改動才停止。
**234 城全量實測：全部收斂、總計約 5 秒**（單城最慢 NYC 約 0.4 秒，160×160 → 約 31×34）。

**逐步驗證**：浮動面板五顆按鈕——「下一步」（目前演算法掃一遍、掃完換下一個）、
「下一小步」（這一遍中的下一個單一移動，圖上以**前後比對**標示：舊位置虛線空心圈、
虛線軌跡、新位置橘色實圈，訊息附座標）、「上一步／上一小步」（快照堆疊復原）、
「重設」；三階段 chips 顯示目前工作，一輪全靜止顯示「✔ 收斂完成」。
全用大步跑到收斂的結果**與循環 tab 完全一致**。

直線演算法四條鏈的比較基準（迭代到不動點後）：ILP 全網 H/V +47.8%、
直角爬山 +42.9%、軸對齊 +28.5%，全數收斂。

### Stage 4 · RWD Maps（版面畫線）

把 **Straighten「循環」的收斂結果**（RWD 圖層第一個 tab「循環結果」）重繪成
**嚴格方向約束**的折線（`src/stores/rwdMap.js`，skill `route-rwd-draw`）。
方向約束以「畫面像素」為準——不是整數格索引，圖**隨板面變形**（欄寬 ≠ 列高是常態），
resize／換版面／改權重都會在新像素座標**重跑整個佈線器**。

**線方向數**（工具列「方向」下拉：4／8／16，預設 8）——三個方向級同一套判斷邏輯：

- **4 方向**（只 H/V）：不產任何 45° 候選；對角段用與 8/16 相同的候選骨架，唯一差別是
  每條 45° 腿展開成 H/V 階梯，另直接生成真 Z 字（V–H–V／H–V–H，分點 50/25/75）；
  A* 佈線改純直角步進。實測全城 45°＝0。
- **8 方向**（＋45°）：預設。折線只用 H/V/45° 三種方向的腿。
- **16 方向**（＋22.5°/67.5°）：加 22.5° 族候選（單折、雙折斜–軸–斜／軸–斜–軸、
  45＋22.5 混合家族——同一條路可以 45 與 22.5 組合，所有斜腿一律被軸向腿隔開）。

**方向級嚴格優先＝tie-break，不是硬閘**：能用 H/V 就不用 45、能用 45 就不用 22.5——
但衝突數（含近距貼線）排在方向級之前：零衝突的 22.5° 贏過有重疊或貼線的 45°；
兩者都乾淨時 45° 一定優先。收尾另有 **deskewPass**：衝突消解後走廊空出來的 22.5 段
一律升回乾淨的 45 級（折數可以增加——方向級優先於折數）。

其餘核心機制：

- **同軌路線合併**（`mergeParallelSegs`）：重疊就畫一條、不錯開成平行線；涵蓋性防呆
  ——被併邊的每一站都要在保留路徑上（全 234 城 0 孤立站）；環邊正反去重。
- **候選折線依轉折數絕對優先**（直線 > 單折 > 雙折 > 三折混合 > 任意次交替階梯，
  硬頂 ≤20 折）；**45° 接 45° 禁止**（斜腿一律被軸向腿隔開）；**直角樓梯禁止**
  （對角走向用 45°，不畫 vh-vh-vh）；**規則 0 直線鐵律**（可直線且零衝突就鎖定直線）。
- **候選選擇序（`pickBest`）八鍵字典序**：衝突數 → 近距貼線長 → 45 優於 22.5 →
  折數 → 硬共線重疊長 → 分點 50/25/75 → 軟共線 → 路徑總長（線越短越好，最弱一階）。
- **「絕不交叉」多層衝突消解**（依序升級）：衝突消減重掃 → **成對線聯合重算**
  （`jointReroutePairs`：真交叉直接偵測入場、bounded-bend 組合、深輪成對 rip——
  「這對線到底有沒有不交叉畫法」的實質驗證）→ A* 格點佈線（限 S–T 走廊窗，
  **大環繞禁止**）→ rip-up & reroute（PCB 手法拆牆）→ restart-with-priority →
  窄縫救援 → **共線救援**（萬不得已可共線、交叉依然絕禁）→ 殘留 forced（琥珀標示，
  深度 Jordan 封閉的極限案例）。衝突判定含：貼線重疊（累積 ≤25% 弧長硬上限）、
  同一對線最多交叉一次、壓過節點直接淘汰、**節點環狀順序不可變**（rotation system）。
- **收尾軟目標迭代**（跑兩輪）：A* 樓梯轉 45（destairPass）→ 22.5 升回 45（deskewPass）
  → 壓短共線 → 同路線續接角軟調整（180°>135°>90°>45°）→ 降折到定點（含協商式拉直）
  → L 形能改 45° 就改（最後一步）。
- **版面模擬**（工具列「版面」下拉）：目前面板／網頁橫直／手機直橫／iPad／IG 貼文與
  限動等固定尺寸 artboard（`src/lib/rwdFrames.js`），以該寬高當畫線座標系、letterbox 置中。
- **流量權重**：link weight（相鄰兩站為單位）→ 非均勻欄寬列高（取 max）、白點自動隱藏
  （全域 cutoff 一致）、~700ms 格線內插動畫（中間幀 fast 佈線、最後一幀完整品質）。
- **滑鼠放大鏡（魚眼）**：游標所在細格為焦點、附近欄列撐開遠處壓扁（外框固定），
  每幀在變形後的像素空間重繞線。

---

## 三條並列資料管線

上面四階段管線的**輸入**由三條 schema 相同、下游共用的資料管線提供，加上一個獨立的地標圖層。
三條管線概念一一對應——railway 與 highway 是 metro 的「軌道／道路對應版」——所以同一套骨架化／
爬山／畫線演算法與 D3／MapLibre 渲染器**完全不改**就能吃三種資料。

| | **Metro**（地鐵/輕軌） | **Railway**（國家鐵路） | **Highway**（高速公路） |
|---|---|---|---|
| 系統單位 | 一城市（一城一檔） | 一國家（一國拆高鐵/一般兩檔） | 一都會區（一都會區一檔） |
| OSM 判準 | `route=subway` / `route=light_rail` | `railway=rail` 且 `usage=main\|branch`（`highspeed=yes`＝高鐵） | `highway=motorway` ＋封閉式快速道路 |
| 「站」＝ | 地鐵站節點 | 車站 `railway=station`/`halt`（吸附到軌道圖） | 交流道 `motorway_junction` |
| 線幾何 | 車站依站序連線 | 相鄰車站沿軌道連線 | 交流道依序相接 |
| 範圍判定 | Nominatim 反查洲/國/城 | ISO3166-1 國界 area | 沿用 metro 錨點 |
| 取得 skill | `metro-osm-fetch` | `railway-osm-fetch` | `highway-osm-fetch` |
| 驗證 skill | `metro-audit` | `railway-audit` | `highway-audit` |
| 資料規模 | 234 城 / 1,744 線 / 16,970 站 | 12 國 / 368 線 / 6,779 站 | 3 都會區 / 261 交流道 |

**GeoJSON schema 三者相同**（`seg_id`／`routes[]`／`stations[]`／`station_id`／`lines`…）；系統中繼
放在各自的 `metro_system`／`railway_system`／`highway_system`，並鏡射一份 `metro_system{kind}`
讓前端一律當 metro 圖層處理。前端左側 Layers 面板有 Metro Maps／Railways／Highways 三個群組，
各自的 Import 對話框（快速選擇／依站數排序／全球地圖三分頁）。

### Railway：國家鐵路

- **收**：`railway=rail` 幹線＋高鐵（新幹線／TGV／高鐵／KTX），**不含**地鐵/輕軌/路面電車。私鐵預設
  收、用 `_overrides/{cc}_exclude.json` 兩層過濾（保護白名單 ＞ 排除黑名單 ＞ 預設留）逐國排除。
- **一國拆兩檔**：高鐵 `-hsr`／一般國鐵 `-rail`，各成一圖層；高鐵由 OSM `route=railway` 關聯的**有序
  停站**建以保證串接。上色依鐵路類別（高鐵 vs 一般），非每線一色。
- **日本再拆 JR 六社**：一般國鐵拆成 JR 東日本／西日本／東海／北海道／四國／九州各自成系統
  （`as-jpn-{east|west|central|hokkaido|shikoku|kyushu}-rail`），**新幹線仍維持單一檔**（`as-jpn-hsr`，
  顯示「日本 新幹線」不是「高鐵」）。跨社幹線（東海道本線＝東/海/西 一條關聯 4140 成員）依成員 way
  佔比讓每社各拿自己的區間。
- **逐線串接（核心演算法）**：每條線用自己的關聯 member way 建自己的軌道圖——但一條線的 way 在 18m
  grid 幾乎不會是單一連通圖（山陰本線 1784 way→22 元件），故**逐元件取 diameter 再依最近端點串接成
  一條完整主線**（`CHAIN_GAP` 上限擋掉遠碎片的假長線），沿主線弧長排站。這解決了「只取最大元件會漏
  掉大半站、被丟進無名 connector 顯示成斷開」的問題（山陰本線 61→158 站、對 wiki）。

### Highway：高速公路

- **收**：封閉式道路（國道 motorway ＋封閉式快速公路 trunk/expressway），交流道串成網絡、依 ref 分組。
- **交流道＝站**、依交流道命名率／里程單調／無假長線等結構不變式驗證。目前資料：台灣三都會區
  （台北 126／台中 83／高雄 52 交流道）。國家專屬封閉式判準與路標配色見 `highway-cities`。

### Landmark：地標圖層

- `data/metro/landmarks`：與 metro 路線/車站 geojson **完全分離**的獨立圖層。
- **河流＝骨架線**（取 graph diameter 主線，不抓面域）；**皇居／中央公園＝面域**。skill `landmark-osm-fetch`。

---

## 資料管線（fetch ⇄ audit）

> 權威規則在成對的 skill：取得（`metro-osm-fetch`／`railway-osm-fetch`／`highway-osm-fetch`）
> 與驗證收斂（`metro-audit`／`railway-audit`／`highway-audit`）互為 fetch⇄audit 迴圈；
> 城市/國家專屬例外在 `metro-cities`／`highway-cities` 與各大城市專屬 skill。
> 資料細節另見 `data/metro/README.md`。下段以 metro 為例，railway/highway 同構。

```bash
npm run metro:all        # 完整流程：wiki 清單 → OSM 抓取 → 反查 → 組檔＋縮圖 → 逐城 audit

# 分步（皆有快取、可續跑、失敗自癒）：
npm run metro:wiki       # Wikipedia「List of metro systems」→ _cache/
npm run metro:fetch      # Overpass 抓全球 subway+light_rail（僅營運中）→ _cache/（幾何增量）
npm run metro:geocode    # Nominatim 反向地理編碼（洲/國/城，1 req/s）
npm run metro:build      # 組最終 GeoJSON ＋ 重算畫廊縮圖（= buildonly + views）
npm run metro:views      # 只重算三個畫廊的預算縮圖（_fp 增量，資料沒變的城市直接沿用）
npm run metro:audit      # 逐城市 audit⇄修補到收斂（策略階梯自動補抓/綁定）
npm run metro:sites      # 官方網站索引（Wikidata P856／營運商條目→官網，223 城已解 221）
npm run metro:verify     # 對照 Wikipedia/urbanrail 全量報告 → verify_report.json/.md
npm run metro:wikilines  # 逐線站數比對 → line_check_report.json

# 選用的軌道底圖（與示意層分離，不影響演算法）：
npm run metro:fetchtracks       # 抓每線 OSM 真實軌道 way 幾何 → _cache/
npm run metro:buildtracks       # 組 data/metro/tracks/<id>.geojson（「軌道」疊加層）
npm run metro:buildcenterlines  # 每線收成一條中心線 → tracks-center/（「路線中線」疊加層）
```

**判準**：只收 `route=subway` 與 `route=light_rail`（LRT），不含 train／railway／tram，
僅營運中（lifecycle 過濾是不變式）。**城市判定**三層護欄（泛用詞黑名單、rebucket 250 km、
線級 250 km）；都會圈合併一城一檔（桃園→台北）；東京不含私鐵；德國五城／雪梨有
route=train 例外。**驗證不變式**（error 級違反必修到 0）：城市不可缺、站必有名、
站必有線、線必有站、逐線站數以 wiki 為準、interchange ⇔ 相異路線通過 ≥2。
人工裁決一律落地 `_overrides/`，重抓自動套用、不失傳。

---

## 資料格式

### 目錄總覽（`data/metro/`）

```
data/metro/
├── index.json                  # 總索引：234 系統清單＋統計＋覆蓋率報告
├── metro_lines.geojson         # 全球所有路段（去重）
├── metro_stations.geojson      # 全球所有車站（共站已合併）
├── systems/{洲}/{國}/{id}.geojson   # 每城一檔（id = 洲2碼-IOC3碼-城，如 as-twn-taipei）
├── views/    hcviews/    rwdviews/  # 三個畫廊的預算縮圖（每城一 JSON ＋ index.json）
├── llmviews/  llmgrids/        # LLM 對齊／LLM 互動離線結果
├── llmevals/  llmcompares/     # LLM 評價（含 moves）／LLM 八結果比較（唯讀評審）
├── tracks/    tracks-center/   # 真實軌道 way 幾何＋每線中心線（MapLibre 底圖疊加層，選用）
├── landmarks/                  # 地標圖層（河流骨架線、皇居/中央公園面域）
├── official_sites.json         # 官方網站索引（223 城已解 221）
├── maps/** ＋ maps_index.json  # （legacy）官方路網圖圖片，已退役、僅供人工查閱
├── verify_report.json/.md      # 全量驗證報告
├── line_check_report.json      # 逐線站數比對
├── _overrides/                 # 人工裁決（重跑自動套用）
└── _cache/                     # Overpass/Wikipedia/geocode 原始回應（可刪）
```

### 每城 GeoJSON（`systems/**/*.geojson`）

一份 `FeatureCollection`，頂層掛 `metro_system` 中繼資料，features 只有兩種：

```jsonc
{
  "type": "FeatureCollection",
  "metro_system": {
    "continent": "asia", "country": "Taiwan", "city": "Taipei",
    "osm_networks": ["台北捷運", "…"],          // 合併進此城的 OSM network
    "operator": "…", "official_website": "…", "official_map": "…", // official_map 是 legacy 欄位名，實存 Wikipedia 連結
    "wikidata": "Q…",
    "line_count": 18, "segment_count": 20, "station_count": 197,
    "audit": { /* metro-audit 逐城驗證結果；未跑時 null */ }
  },
  "features": [ /* Point 車站…, MultiLineString 路段… */ ]
}
```

**幾何語意（三條鐵律）**：
1. **線永遠壓在站點上**——路段幾何＝共站合併後的車站點依站序連線，每個折點/端點都是車站
   （唯一例外：跳站服務沿本地走廊彎行的 pass-through 頂點，資料以 `pass` 標記）；
2. **重疊路段只畫一條、且每段必連續**——相鄰站對被多線共用時只輸出一個 feature，`routes[]`
   記行經路線；同 route 集合的**不相連走廊會拆成多個 feature**（每段單一連通，hover 不斷開），
   一條 route 的完整路徑＝所有含它的路段之聯集；
3. **快車一律不抓**——只跳站的快車（站點是慢車子集）不另成線，各停站表為準；
   交錯停站（NYC J/Z）或獨立編號快線（香港 AEL）自然保留，跳過的站標 `pass` 畫共線。

**車站（Point）properties**：

| 欄位 | 內容 |
|---|---|
| `station_id` / `station_name`(`_local`/`_en`) | 穩定 id、**在地語言**站名（台繁/中簡/港繁/日日）＋英文名 |
| `routes[]` | 此站的路線清單 `{ref, name, pass?}`——`pass:true`＝行經但不停靠（快車跳站） |
| `lines` | 停靠 refs（**至少一條**，空值＝資料錯誤，verify 標 `no_line`） |
| `codes` | 官方站碼清單（台北車站 `[A1, BL12, R10]`；無則 null） |
| `station_role` / `is_interchange` / `is_terminus` | interchange／terminus／normal |
| `merged_from` / `merged_names` | 共站合併來源數；異名轉乘站保留所有成員站名（含各名所屬 lines） |
| `pass_count` / `station_degree` | 路線通過次數／相異鄰站數（interchange 不變式用） |
| `network`(`_local`) / `operator` / `city` / `country` / `wikidata` / `wikipedia` | 歸屬與外部鏈結 |

**路段（MultiLineString）properties**：

| 欄位 | 內容 |
|---|---|
| `seg_id` | 路段 id（重疊已去重） |
| `routes[]` | 行經此路段的每條路線：`route_id`・`route_name`(`_local`/`_en`，在地語言＋去方向尾綴)・`route_ref`（BL/R…）・`route_color`（#rrggbb 官方色）・`network`・`operator`・`wikidata`・`osm_route_ids`・`order_suspect` |
| `routes[].stations` | 該線的**完整行經序** `{station_id, station_name, code?, pass?}`——pass 站就地標記、依官方站碼正規化方向（A1 在前）；下游拓撲取非 pass 項建圖 |
| `route_count` / `route_refs` / `route_colors` | 共線摘要（交錯色線繪製用；**無單數 `route_color`**——路段可多線） |

> 每站輸出**完全相同的欄位集**（21 鍵，缺值 null/false）——234 城的物件面板/hover 表格全球一致。

**共站＝可轉乘**：OSM `stop_area` ∪ 同名 ≤800 m ∪ 人工裁決 `_overrides/interchanges.json`
（**非**「同名就共站」；紐約同名不相通的站按 STRICT 規則不併）。合併站座標取平均、lines 取聯集。

### 總索引（`index.json`）

`generated_from`／`baseline`／`system_count`（234）／`wikipedia_system_count`（233）／
`line_total`（1744）／`station_total`（16970）／`systems[]`（每系統：file、洲國城、
osm_networks、operator、official_website、wikidata、線/段/站數）／
`wikipedia_cities_without_match`（Wikipedia 有但未比對到的系統，覆蓋率報告）。

### 畫廊預算縮圖（`views/`・`hcviews/`・`rwdviews/`）

由 `npm run metro:views`（`scripts/buildViews.mjs` → `src/stores/viewGeometry.js`，
**與互動分頁同一套純函式**，縮圖必然和實際視圖一致）產出，每城一個 JSON：

```jsonc
{
  "id": "as-twn-taipei", "file": "systems/…", "city": "Taipei", "cityZh": "台北", …,
  "tilt": 11.3, "canRotate": true,          // 主軸角（rotated 變體用）
  "W": 200, "H": 150,                       // viewBox 尺寸
  "views": {                                 // 視圖 id → 可直接渲染的 SVG 資料
    "grid-orig-post": {
      "lines": [{ "d": "M95.7,119.3L102.1,…", "color": "#e3002c", "dash": null }],
      "hl":    [{ "d": "…", "color": "#f59e0b" }],   // 邊分類/衝突襯底
      "dots":  [{ "x": 109.7, "y": 34.8, "fill": "#ffffff" }],
      "grid":  { "xs": [24, 26.5, …], "ys": [24, …] } // 藍色分隔格線
    }, …
  },
  "stats": { /* hcviews 才有：爬山適應度/輪數/網格尺寸 */ },
  "_fp": "25:14lzlqj"                       // 增量指紋 = VIEWS_VERSION:geojson內容雜湊
}
```

- 視圖組成：`views/` 8 個（原始/旋轉/骨架化/格網化前後 ×2）、`hcviews/` 8 個
  （格網化後 → Hill Climbing → 端點移動 → 直線縮減＋網格合併 ×2 變體，全部 movewise）、
  `rwdviews/` 8 個（4 條鏈的循環結果 ×〔循環結果｜RWD 路網〕）。
- **`_fp` 增量重算**：`metro:views` 重跑時指紋沒變的城市直接沿用舊檔，只重算資料變了的城市；
  **改了任何演算法**要把 `buildViews.mjs` 的 `VIEWS_VERSION` +1 強制全量重算
  （版本註解就是演算法變更日誌，目前 34；RWD 佈線器另有 `RWD_ROUTER_REV` 修訂字串）。

### LLM 結果檔（`llmviews/`・`llmgrids/`・`llmevals/`・`llmcompares/`）

| 檔 | 命名 | 內容 |
|---|---|---|
| `llmviews/<id>.<variant>.json`（指定對齊另存 `.prompt.json`） | variant = orig/rot | LLM 對齊結果：`fingerprint`（verts/segs/cols/rows/hvStart）、`model`、`rounds`、`prompt`、`transcript`、`hvBefore/hvAfter`、`cellAfter`（`[id, col, row]` 陣列） |
| `llmgrids/<id>.<variant>.<compact>.json` | compact = hc/rect/align/ilp/llm | LLM 互動結果：`fingerprint`、`model`、`colW[]`/`rowW[]` 逐欄列顯示權重、`note`、`userPrompt` |
| `llmevals/<id>.<variant>.<compact>.json` | 同上 | LLM 評價：逐線評語＋建議 moves（經硬規則 apply 後的調整佈局，網頁「執行調整」切換前後） |
| `llmcompares/<id>.json` | 每城一份 | LLM 八結果比較：`winner`/`winnerOrig`/`winnerRot`＋逐結果 strengths/weaknesses（唯讀評審） |

全部以 `fingerprint` 對當前資料驗證——不符即拒載並提示重新產生；**絕不手改**結果檔，
一律經 apply 腳本的硬規則驗證寫入。

### 軌道底圖（`tracks/`・`tracks-center/`，選用）

- `tracks/<id>.geojson`：`npm run metro:fetchtracks` ＋ `metro:buildtracks`——抓每條
  路線 OSM relation 的**真實軌道 way 幾何**（上下行雙股＋渡線），MapLibre 地圖的
  「軌道」疊加層用；與 `systems/` 的站對站示意層完全分離、絕不影響下游演算法。
- `tracks-center/<id>.geojson`：`metro:buildcenterlines`——每線收成**一條中心線**
  （最長股當骨幹、垂直方向朝軌道點雲中心修正，讓去回兩股疊回同一條線），
  「路線中線」疊加層用。

### 其他

- `official_sites.json`：**官方網站索引**（`npm run metro:sites` 產出，223 城已解 221）。
  來源階梯：`_overrides/site_overrides.json` 釘選 > Wikidata 系統條目 P856 > 營運商條目
  P856（系統條目常是死域名）> OSM `website` tag > enwiki infobox；前端 Info tab 的
  「官網」列讀此檔，缺項才 fallback 到 geojson 的 `official_website`。
- `maps/**`＋`maps_index.json`：**官方路網示意圖圖片管線（已退役、保留為遺留檔案）**——
  曾用 `npm run metro:maps`（腳本 `downloadMaps.mjs` 仍在但不在 `metro:all` 內）從
  Wikidata P15 → Commons 下載，465 MB；前端已改抓官方網站（見上），這批圖片與
  `maps_index.json` 只保留供人工查閱、不參與任何渲染路徑。
- `verify_report.json/.md`：不變式違規（missing/no_line/order…）＋站數落差待查清單。
- `_overrides/`：`interchanges`（共站併/拆）、`route_excludes`、`station_excludes`、
  `station_names`、`member_appends`、`route_tag_patches`、`express_passthrough`、
  `manual_lines` 等人工裁決檔——每筆都是可重放的資料修補。

---

## LLM 離線整合

瀏覽器端沒有 API key、不做即時推論；兩個 LLM 功能都是「**離線預算、存檔、網頁載入**」：

前端模型下拉**預設 Fable 5**（可選 Opus 4.8／Sonnet 5／Haiku 4.5，或沿用 CLI 預設）。

| 功能 | 觸發 | 流程 |
|---|---|---|
| LLM 對齊（Straighten，分**自動**與**指定**兩 tab） | 網頁按鈕 → dev server `/llm-align/run` | skill `route-llm-align`：export 佈局 → 模型提案短距離移動 → apply 經與其他直線演算法**相同的硬規則**套用（淨 H/V 變差整批退回）→ 寫 `llmviews/`。是第四種 H/V 最大化後處理；指定對齊（`--prompt`）依使用者一句話另存 `.prompt.json` |
| LLM 互動（RWD Maps） | 一句話輸入框 → `/llm-grid/run` | skill `route-llm-grid`：讀欄列脈絡 → 模型推理每欄/列顯示權重 → 驗證後寫 `llmgrids/`，網頁在新像素座標重畫；「執行調整」切換套用⇄恢復 |
| LLM 評價（RWD Maps） | 網頁按鈕 → `/llm-eval/run` | skill `route-llm-eval`：模型讀佈局幾何寫評價（哪些線可更直/更方正/彎太多）＋把建議轉成具體 moves → 寫 `llmevals/`。**最優先消除銳角**（進出兩段夾角<90° 的尖折 → 改成 90° L 形直角或 180° 直通；export 直接點名 `acute`/`acuteAt` 在哪些站）。「執行調整」按鈕只切換套用⇄恢復比較前後，不再跑 LLM |
| LLM 比較（RWD Maps） | 網頁按鈕 → `/llm-compare/run` | skill `route-llm-compare`：唯讀評審——一次比較原始與旋轉變體的直角爬山/軸對齊/整數規劃/LLM 對齊（最多 8 個結果），依方正/直線/轉折/平衡/硬失敗選出全體最佳、原始最佳、旋轉最佳並逐一列優缺點 → 寫 `llmcompares/` |

四個端點都是 `vite.config.js` 的 dev-only plugin（需本機 `npm run dev` ＋ Claude Code CLI）；
GitHub Pages 上按鈕會顯示對應提示。**提案是模型的判斷，合法性不是**——所有結果都經
確定性硬規則把關（拓撲不變，違反進 rejected 迭代）；LLM 比較是唯讀評審、不動任何座標。

---

## 專案結構

```
├── index.html / src/            # Vue 3 應用
│   ├── components/              # D3Tab（示意圖分頁核心：26 視圖＋逐步驗證面板）、
│   │                            #   LayerPanel、三個畫廊、StylePanel、AttributeTable…
│   ├── stores/                  # 演算法全在這裡（純函式，UI 無關）：
│   │   ├── skeleton.js          #   骨架化（route-skeleton-connect）
│   │   ├── schematicGrid.js     #   示意格網化（route-skeleton-grid）
│   │   ├── hillClimb.js         #   爬山＋直線演算法＋movewise 三步鏈＋循環＋逐步驗證
│   │   │                        #   （route-hillclimb / route-endpoint-move /
│   │   │                        #    route-line-compact / route-grid-merge /
│   │   │                        #    route-movewise-loop / route-step-verify / route-span-cap）
│   │   ├── rwdMap.js            #   RWD 畫線（route-rwd-draw：候選/衝突消解/收尾 pass）
│   │   ├── rwdWeight.js         #   流量權重→欄寬列高、白點隱藏、LLM 區間權重末端變形
│   │   ├── viewGeometry.js      #   畫廊縮圖（與互動分頁同一套函式）
│   │   ├── orientation.js       #   主軸角（rotated 變體，Boeing 2019 方向熵）
│   │   └── mapStore.js …        #   Pinia UI 狀態、圖層、持久化
│   └── lib/                     # assetUrl（GH Pages base）、rwdFrames（版面預設）、
│                                #   hcCache（爬山 localStorage LRU）、headlessRun（LLM 串流）
├── scripts/                     # 資料管線（純 Node.js）：overpass client、fetch/geocode/
│                                #   buildGeojson/buildViews/auditLoop/verifyMetro/
│                                #   llmAlign/llmGrid/llmEval/llmCompare/
│                                #   fetchMetroTracks/buildMetroTrackCenterline…
├── data/metro/                  # 資料集（見上節）
├── data/thesis/                 # 演算法文獻 PDF＋逐篇中文說明
├── slides/                      # 系統介紹投影片（純靜態，build 時照抄進 dist/slides/）
├── .claude/skills/              # 36 份 skill：資料管線規則（metro-*/railway-*/highway-*）
│                                #   ＋演算法契約（route-*）——skill 即文件
└── vite.config.js               # data/ 與 skills/ 靜態掛載、LLM dev 端點、Pages base
```

**Skill 即規格**：每個演算法都有對應的 `.claude/skills/route-*/SKILL.md` 作為實作契約
（改演算法必同步改 skill＋bump `VIEWS_VERSION`）；每份 skill 並記錄歷次設計裁決
（如「一次只能移一格」「hc 鏈不進後處理各區」「預設跨距 3」），規則的來龍去脈不失傳。
資料管線的判準、城市例外、audit 策略階梯全在 `metro-*` skills——「用 Claude Code
重抓/修資料」因此可重現。

---

## 效能與快取

- **畫廊秒開**：三個畫廊的縮圖全部離線預算（`views/` 等），前端只 fetch JSON 畫 SVG；
  `_fp` 增量讓 `metro:build` 之後只重算資料變了的城市。
- **爬山快取**：Hill Climbing＋直線演算法結果依「資料指紋＋變體」存 `localStorage`
  （LRU 12 份佈局）——關分頁、重新整理、重建同視圖都直接載回不重跑。
- **三步鏈快取**：端點移動/直線縮減/網格合併/循環/逐步驗證的結果以「鏈」為 key
  存在分頁記憶體；改「線段最大跨距」即作廢重算
  （`appliedSpanCap` 快照保證同畫面不會新舊上限混雜）。
- **循環全量速度**：234 城循環收斂總計約 5 秒（Node 實測）；瀏覽器端單城皆在
  數十毫秒～0.5 秒之間，切 tab 即算即畫。
- **RWD 動畫**：權重/網格變化以 ~700ms 內插格線位置，每幀跑快速版佈線、最後一幀 settle
  到完整品質（無交叉）。
- 全部演算法皆確定性（無 `Math.random`）——同輸入同輸出，快取永不失真。

---

## 演算法文獻與定位

`data/thesis/` 收錄核心文獻 PDF 與逐篇中文演算法說明：

| # | 文獻 | 對應 |
|---|---|---|
| 1 | Stroke-based schematic maps | 骨架化思路對照 |
| 2 | **Stott et al. 2011**, Automatic Metro Map Layout Using Multicriteria Optimization (TVCG) | **Stage 3 爬山法主依據** |
| 3 | Nöllenburg & Wolff, Mixed-Integer Programming | 整數規劃後處理對照 |
| 4 | 力導向自動視覺化 | 對照法 |
| 5 | Focus+Context Metro Maps | 流量權重／概括化思路 |
| 6 | Bast et al., Octilinear Grid Graphs | 八向格佈線對照（目標最接近三步鏈的「格子越少越好」） |
| 7 | Merrick & Gudmundsson, Path Simplification | 路徑簡化對照 |
| 8 | SAT-based Octolinear Layouts | 求解器路線對照 |
| 9 | Batik et al. 2022, Shape-Guided Mixed Metro Map Layout (Pacific Graphics) | 對照法（使用者自訂形狀嵌入示意圖佈局，本系統未實作對應章節） |

`data/thesis/` 另收 Boeing 2019《Urban Spatial Order: Street Network Orientation,
Configuration, and Entropy》——**非上表編號文獻，但有直接程式對應**：`src/stores/orientation.js`
的長度加權方向熵／φ 計算（Stage 2 示意格網化 rotated 變體的主軸角偵測，`tilt`／`canRotate`
即由此而來）直接沿用該文的公式（φ = 1 − ((H−H_grid)/(H_max−H_grid))²）。

**三步鏈的定位**：固定拓撲下的正交示意化＋面積最小化是經典 NP-hard 問題
（TSM 框架的 orthogonal compaction、VLSI 1-D compaction、Misue et al. 的
orthogonal ordering 保持都是零件級近親），本系統以「每種移動各守一個單調不變式
＋每個移動後立即全域壓縮（movewise）」的 local search 逼近——犧牲最佳性換取
秒級全量速度與**逐步可視化**（每一個單一移動都可以在逐步驗證裡重播、比對前後）。

---

## 授權與資料來源

- 路網幾何與屬性：© OpenStreetMap contributors，[ODbL](https://opendatacommons.org/licenses/odbl/)。
- 系統清單／站數基準：Wikipedia（CC BY-SA）；交叉驗證：urbanrail.net。
- 官方網站連結：Wikidata（CC0）／各系統官方網站本身（`official_sites.json`）。
- 反向地理編碼：Nominatim（OSM）。
- （legacy）官方路網圖圖片：Wikimedia Commons，逐張授權見 `data/metro/maps/maps_index.json`
  （多為 CC BY-SA／Public Domain）——此批圖片管線已退役、前端不再使用，僅供人工查閱；
  若仍要引用圖片本身（如放進論文），需依索引署名。
