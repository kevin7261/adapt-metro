# Adapt-Metro — 全球地鐵響應式示意圖系統

把**真實地鐵路網**一步步變成**響應式八向示意圖**的純前端系統：
OpenStreetMap 抓取的 223 座城市地鐵／輕軌路網，經過「拓撲骨架化 → 整數格網化 →
多準則爬山最佳化＋**三步鏈循環壓縮**（端點移動 → 直線縮減 → 網格合併）→
嚴格 H/V/45° 畫線」四個階段，全部在瀏覽器內以**純函式、確定性、零求解器依賴**
完成——每一個單一移動都能逐步檢視，版面一變，圖就在新的像素座標重新求解。

- **線上版**：<https://kevin7261.github.io/adapt-metro/>
- **系統介紹投影片**：`/slides/`（37 張，含演算法與資料格式，純靜態 HTML、鍵盤／觸控翻頁）
- **技術堆疊**：Vue 3 + Pinia + Vite、MapLibre GL（地理底圖）、D3 v7（示意圖渲染）、
  純 Node.js 資料管線（`scripts/`，無外部相依）

---

## 目錄

1. [快速開始](#快速開始)
2. [介面導覽](#介面導覽)
3. [四階段管線](#四階段管線)
4. [資料管線（fetch ⇄ audit）](#資料管線fetch--audit)
5. [資料格式](#資料格式)
6. [LLM 離線整合](#llm-離線整合)
7. [專案結構](#專案結構)
8. [效能與快取](#效能與快取)
9. [演算法文獻與定位](#演算法文獻與定位)
10. [授權與資料來源](#授權與資料來源)

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
| 左側 Layers 面板 | 五個圖層群組（Metro Maps／Highways／Map Adjust／Straighten／RWD Maps）＋圖層樹、顯示切換、每層動作選單 |
| 中間編輯區 | Dockview 多分頁：MapLibre 地理地圖、D3 示意圖分頁（每個圖層一個 tab，左側可捲動的視圖清單）、三個城市畫廊 |
| 右側 Style 面板 | 依分頁型態切換的樣式與演算法參數控制（線寬/半徑/站名、**顏色點間最大跨距**、RWD 權重、LLM 面板…） |
| 底部屬性表／狀態列 | 可排序過濾的 feature 屬性表；座標／Zoom／每個視圖的演算法統計讀數 |
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
  格網規模依城市而異（台北約 67×67、紐約約 215×215）。

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
  超過 n 格（Chebyshev，樣式面板手動輸入、預設 3、按「重新計算」套用；本來就
  超過上限的舊長段只准縮短不准拉長）；
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
**223 城全量實測：全部收斂、總計約 5 秒**（單城最慢 NYC 約 0.4 秒，215×215 → 約 76×74）。

**逐步驗證**：浮動面板五顆按鈕——「下一步」（目前演算法掃一遍、掃完換下一個）、
「下一小步」（這一遍中的下一個單一移動，圖上以**前後比對**標示：舊位置虛線空心圈、
虛線軌跡、新位置橘色實圈，訊息附座標）、「上一步／上一小步」（快照堆疊復原）、
「重設」；三階段 chips 顯示目前工作，一輪全靜止顯示「✔ 收斂完成」。
全用大步跑到收斂的結果**與循環 tab 完全一致**。

直線演算法四條鏈的比較基準（迭代到不動點後）：ILP 全網 H/V +47.8%、
直角爬山 +42.9%、軸對齊 +28.5%，全數收斂。

### Stage 4 · RWD Maps（版面畫線）

把 **Straighten「循環」的收斂結果**（RWD 圖層第一個 tab「循環結果」）重繪成
**嚴格 H/V/45°** 折線（`src/stores/rwdMap.js`，skill `route-rwd-draw`）——
八方向約束以「畫面像素」為準，resize 即重新求解：

- 同軌路線合併（涵蓋性防呆：被併邊的每一站都要在保留路徑上，全 223 城 0 孤立站）；
- 候選折線依轉折數絕對優先（直線 > 單折 > 雙折），45°接45° 禁止；
- 「絕不交叉」五層衝突消解：重掃 → A* 格點佈線 → rip-up & reroute → restart-with-priority → 窄縫救援；
- 軟目標收尾：同路線續接角評分、L 形能改 45° 就改；
- 流量權重：link weight → 非均勻欄寬列高（取 max）、白點自動隱藏（全域 cutoff 一致）、~700ms 內插動畫。

---

## 資料管線（fetch ⇄ audit）

> 權威規則在兩份 skill：`metro-osm-fetch`（取得）與 `metro-audit`（驗證收斂），
> 城市專屬例外在 `metro-cities` 與各大城市專屬 skill。資料細節另見 `data/metro/README.md`。

```bash
npm run metro:all        # 完整流程：wiki 清單 → OSM 抓取 → 反查 → 組檔＋縮圖 → 逐城 audit

# 分步（皆有快取、可續跑、失敗自癒）：
npm run metro:wiki       # Wikipedia「List of metro systems」→ _cache/
npm run metro:fetch      # Overpass 抓全球 subway+light_rail（僅營運中）→ _cache/（幾何增量）
npm run metro:geocode    # Nominatim 反向地理編碼（洲/國/城，1 req/s）
npm run metro:build      # 組最終 GeoJSON ＋ 重算畫廊縮圖（= buildonly + views）
npm run metro:views      # 只重算三個畫廊的預算縮圖（_fp 增量，資料沒變的城市直接沿用）
npm run metro:audit      # 逐城市 audit⇄修補到收斂（策略階梯自動補抓/綁定）
npm run metro:maps       # 下載各系統官方路網圖（Wikidata P15 → Commons）
npm run metro:verify     # 對照 Wikipedia/urbanrail 全量報告 → verify_report.json/.md
npm run metro:wikilines  # 逐線站數比對 → line_check_report.json
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
├── index.json                  # 總索引：223 系統清單＋統計＋覆蓋率報告
├── metro_lines.geojson         # 全球所有路段（去重）
├── metro_stations.geojson      # 全球所有車站（共站已合併）
├── systems/{洲}/{國}/{id}.geojson   # 每城一檔（id = 洲2碼-IOC3碼-城，如 as-twn-taipei）
├── views/    hcviews/    rwdviews/  # 三個畫廊的預算縮圖（每城一 JSON ＋ index.json）
├── llmviews/  llmgrids/        # LLM 對齊／LLM 調整離線結果
├── maps/** ＋ maps_index.json  # 官方路網圖圖片＋逐張出處/授權
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
    "operator": "…", "official_website": "…", "official_map": "…", "wikidata": "Q…",
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

> 每站輸出**完全相同的欄位集**（21 鍵，缺值 null/false）——223 城的物件面板/hover 表格全球一致。

**共站＝可轉乘**：OSM `stop_area` ∪ 同名 ≤800 m ∪ 人工裁決 `_overrides/interchanges.json`
（**非**「同名就共站」；紐約同名不相通的站按 STRICT 規則不併）。合併站座標取平均、lines 取聯集。

### 總索引（`index.json`）

`generated_from`／`baseline`／`system_count`（223）／`wikipedia_system_count`（233）／
`line_total`（1491）／`station_total`（16902）／`systems[]`（每系統：file、洲國城、
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
  （版本註解就是演算法變更日誌，目前 25）。

### LLM 結果檔（`llmviews/`・`llmgrids/`）

| 檔 | 命名 | 內容 |
|---|---|---|
| `llmviews/<id>.<variant>.json` | variant = orig/rot | LLM 對齊結果：`fingerprint`（verts/segs/cols/rows/hvStart）、`model`、`rounds`、`prompt`、`transcript`、`hvBefore/hvAfter`、`cellAfter`（`[id, col, row]` 陣列） |
| `llmgrids/<id>.<variant>.<compact>.json` | compact = hc/rect/align/ilp/llm | LLM 調整結果：`fingerprint`、`model`、`colW[]`/`rowW[]` 逐欄列顯示權重、`note`、`userPrompt` |

兩者都以 `fingerprint` 對當前資料驗證——不符即拒載並提示重新產生；**絕不手改**結果檔，
一律經 apply 腳本的硬規則驗證寫入。

### 其他

- `maps/**`＋`maps_index.json`：官方路網示意圖圖片（多為 CC BY-SA／PD，**再散布需依索引署名**）。
- `verify_report.json/.md`：不變式違規（missing/no_line/order…）＋站數落差待查清單。
- `_overrides/`：`interchanges`（共站併/拆）、`route_excludes`、`station_excludes`、
  `station_names`、`member_appends`、`route_tag_patches`、`express_passthrough`、
  `manual_lines` 等人工裁決檔——每筆都是可重放的資料修補。

---

## LLM 離線整合

瀏覽器端沒有 API key、不做即時推論；兩個 LLM 功能都是「**離線預算、存檔、網頁載入**」：

| 功能 | 觸發 | 流程 |
|---|---|---|
| LLM 對齊（Straighten） | 網頁按鈕 → dev server `/llm-align/run` | headless Claude Code 跑 skill `route-llm-align`：export 佈局 → 模型提案短距離移動 → apply 經與其他直線演算法**相同的硬規則**套用（淨 H/V 變差整批退回）→ 寫 `llmviews/` |
| LLM 調整（RWD Maps） | 一句話輸入框 → `/llm-grid/run` | skill `route-llm-grid`：讀欄列脈絡 → 模型推理每欄/列顯示權重 → 驗證後寫 `llmgrids/`，網頁在新像素座標重畫 |

兩個端點都是 `vite.config.js` 的 dev-only plugin（需本機 `npm run dev` ＋ Claude Code CLI）；
GitHub Pages 上按鈕會顯示對應提示。**提案是模型的判斷，合法性不是**——所有結果都經
確定性硬規則把關。

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
│   │   ├── rwdMap.js            #   RWD 畫線（route-rwd-draw）
│   │   ├── rwdWeight.js         #   流量權重→欄寬列高
│   │   ├── viewGeometry.js      #   畫廊縮圖（與互動分頁同一套函式）
│   │   ├── orientation.js       #   主軸角（rotated 變體）
│   │   └── mapStore.js …        #   Pinia UI 狀態、圖層、持久化
│   └── lib/assetUrl.js          # GH Pages base 處理
├── scripts/                     # 資料管線（純 Node.js）：overpass client、fetch/geocode/
│                                #   buildGeojson/buildViews/auditLoop/verifyMetro/llmAlign/llmGrid…
├── data/metro/                  # 資料集（見上節）
├── data/thesis/                 # 演算法文獻 PDF＋逐篇中文說明
├── slides/                      # 系統介紹投影片（純靜態，build 時照抄進 dist/slides/）
├── .claude/skills/              # 30 份 skill：資料管線規則（metro-*/highway-*）
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
  存在分頁記憶體；改「顏色點間最大跨距」按「重新計算」才作廢重算
  （`appliedSpanCap` 快照保證同畫面不會新舊上限混雜）。
- **循環全量速度**：223 城循環收斂總計約 5 秒（Node 實測）；瀏覽器端單城皆在
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

**三步鏈的定位**：固定拓撲下的正交示意化＋面積最小化是經典 NP-hard 問題
（TSM 框架的 orthogonal compaction、VLSI 1-D compaction、Misue et al. 的
orthogonal ordering 保持都是零件級近親），本系統以「每種移動各守一個單調不變式
＋每個移動後立即全域壓縮（movewise）」的 local search 逼近——犧牲最佳性換取
秒級全量速度與**逐步可視化**（每一個單一移動都可以在逐步驗證裡重播、比對前後）。

---

## 授權與資料來源

- 路網幾何與屬性：© OpenStreetMap contributors，[ODbL](https://opendatacommons.org/licenses/odbl/)。
- 系統清單／站數基準：Wikipedia（CC BY-SA）；交叉驗證：urbanrail.net。
- 官方路網圖圖片：Wikimedia Commons，逐張授權見 `data/metro/maps/maps_index.json`
  （多為 CC BY-SA／Public Domain，**再散布或放進論文需依索引署名**）。
- 反向地理編碼：Nominatim（OSM）。
