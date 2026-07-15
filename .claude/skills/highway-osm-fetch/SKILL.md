---
name: highway-osm-fetch
description: 抓取/重抓全世界封閉式道路（國道 motorway＋封閉式快速公路 trunk+expressway）的交流道與路網，把交流道串成網絡，產出 data/highway 下的 GeoJSON。當使用者要求抓取、更新、重抓高速公路/快速公路/motorway/freeway/expressway/交流道/interchange 資料，或修改 data/highway 的資料管線時使用。這是「取得」管線；正確性驗證由 [[highway-audit]] 負責、國家專屬規則見 [[highway-cities]]，三者對應 metro 的 [[metro-osm-fetch]]/[[metro-audit]]/[[metro-cities]]。
---

# 全球高速公路資料取得規則 (highway-osm-fetch)

此 skill 是 `data/highway/` **取得**的權威依據，是 [[metro-osm-fetch]] 的**高速公路對應版**。
概念一一對應，任何重抓/修改都須遵循此處規則，使不同時間抓的資料結構一致、可比較。
管線腳本在 `scripts/fetchHighways.mjs` + `scripts/buildHighwayGeojson.mjs`（純 Node.js，無外部套件）。

> **fetch⇄audit 迴圈**：本 skill 負責「取得」；[[highway-audit]] 負責驗證正確性並把結果寫進
> `highway_system.audit`。驗證發現的缺漏/異常回饋到這裡調整查詢或重抓，再驗證，直到收斂。
> 國家/都會區專屬規則（各國 trunk 標法、路標配色、命名慣例）見 [[highway-cities]]。改判準/欄位時
> 三份 skill 一起更新（對應 metro 的 [[metro-osm-fetch]]/[[metro-audit]]/[[metro-cities]] 三件套）。

## 與 metro 的對應（設計原則：一一對映，可共用下游）

| metro（[[metro-osm-fetch]]） | highway（本檔） |
|---|---|
| 系統＝一城市地鐵（一城一檔） | 系統＝**一都會區封閉式路網（一都會區一檔，使用者：台灣也要分城市）** |
| 路線 `route=subway`（有 ref） | **編號封閉式道路（依 `ref` 分組）：國道 `highway=motorway`＋快速公路 `highway=trunk`＋`expressway`/`motorroad`** |
| 車站 station 節點 | **交流道 `highway=motorway_junction`（交流道/系統交流道/服務區/匝道）** |
| 線幾何＝車站依站序**直線**連線 | **路段幾何＝交流道依序以直線相接**（**不畫真實路形**，同 metro 線壓站點） |
| 轉乘站（degree>2） | **系統交流道（≥2 條高速公路交會，degree>2）** |
| 反向地理編碼定洲/國/城 | **不需要**——沿用 metro 錨點的 continent/country/city |

**輸出的 GeoJSON schema 刻意與 metro 相同**（`seg_id`/`routes[]`/`stations[]`／`station_id`/
`station_name`/`lines`…），因此可直接餵給同一套 D3／MapLibre 渲染與示意圖管線
（[[route-skeleton-connect]]／[[route-hillclimb]]／[[route-rwd-draw]]）。系統中繼資料放在
`highway_system`（對應 metro 的 `metro_system`），欄名一致。

## 資料來源

| 用途 | 來源 |
|---|---|
| 封閉式道路線形 + 交流道 + 屬性 | **OpenStreetMap**，經 Overpass API，判準見下 |
| 都會區範圍（哪裡有系統、洲/國/城） | **沿用 `data/metro/index.json`** 的每個 metro 系統當錨點 |

**判準（authoritative scope，使用者指定「只要封閉道路就要抓」）**：收**封閉式（控制進出）道路**——
- `highway=motorway`（國道/Interstate/Autobahn，本質全封閉）
- `highway=trunk` **且** `expressway=yes` **或** `motorroad=yes`（封閉式快速公路：台灣台61/64/66…）
- 其上的 `highway=motorway_junction` 節點（交流道）。

**不抓**一般 `trunk`（無 expressway/motorroad 的幹道）、`motorway_link`（匝道）、`primary` 等，
也不用 `route=road` 關係。要改判準必須先更新本文件。

## 目前資料範圍＝台灣（使用者 2026-07-16：只要台灣，國外不用）

npm 腳本預設只抓/組/驗**台灣三都會區**（`as-twn-taipei`／`as-twn-taichung`／`as-twn-kaohsiung`）。
管線本身仍具全球能力（外國原始快取保留於 `_cache/`、不組檔不進前端）；要恢復國外，
直接跑 `node scripts/buildHighwayGeojson.mjs`（無過濾）即可。

## 台灣里程權威＝Wikipedia 交流道里程表（使用者：可以用 wiki 查哩程）

`scripts/fetchWikiHighwayTw.mjs` 抓 zh.wikipedia 各路條目的 wikitext、**確定性解析**結構化模板
（`{{台灣公路交流道|KM|名}}`／`系統連結`／`兩端`／`設施|ser/res/er`；LLM 萃取表格會錯、已否決），
輸出 `_overrides/wiki_mileage_tw.json`（20/21 條路；國5/台61 頁無結構表 → fallback 出口編號，
其值本就＝公里數）。build 對台灣各路以**正規化名稱比對**（含去「高架道路」前綴），命中者
**wiki 公里數覆蓋出口編號**（小數精度、補服務區/休息站的缺里程）。上游條目改版重跑腳本即可。

## 系統單位：一都會區一檔（使用者：台灣也要分城市）

直接讀 `data/metro/index.json`，**每個 metro 系統就是一個高速公路系統**（一都會區一檔）：取該城
**車站點 bbox**、外擴 `MARGIN_DEG`（0.30°≈33km）、在框內抓封閉式道路。洲/國/城/slug **直接沿用
metro 錨點**（`as-twn-taipei`／`am-usa-new-york-city`），`unit: 'metro'`，**不需 geocoding**。
跨都會區重疊正常（國道1號貫穿台北/台中/高雄，各檔各收框內段）。快取 `hw_{slug}.json`。中英文名：
build 由 metro `cityNamesZh.json` 給 `city_zh`（城市）與 `country_zh`（國名）。改 `MARGIN_DEG`
只改 `fetchHighways.mjs`。

## Overpass 查詢（固定）

每個系統一支查詢（bbox = 擴框後的 `S,W,N,E`）：

```
[out:json][timeout:300];
(
  way["highway"="motorway"](S,W,N,E);
  way["highway"="trunk"]["expressway"="yes"](S,W,N,E);
  way["highway"="trunk"]["motorroad"="yes"](S,W,N,E);
)->.mw;
node(w.mw)["highway"="motorway_junction"]->.jn;
.mw out geom tags;
.jn out;
```

- `.mw out geom tags` 給 **way 的線形座標 + tags**（`ref`/`name:zh`/`ref:zh`/`oneway`…），
  但**不含 node id**（本端點的 `out geom` 只回 `geometry` 陣列）。
- `.jn out` 給交流道**節點 id + lat/lon + tags**（`name:zh`＝交流道名、`ref`＝出口編號、
  `wikidata`/`wikipedia`）。
- **交流道→高速公路→位置的對應靠「座標完全相符」**：交流道節點本身就是其車道 way 的一個
  頂點，故 `key(lon,lat)`（toFixed(7)）與 way 頂點座標比對即可定位；毋須 node id。
- 原始回應**一都會區一檔**快取於 `data/highway/_cache/hw_{slug}.json`（`hw_as-twn-taipei.json`）；`--force` 才重抓。

穩健性沿用 [[metro-osm-fetch]]：`scripts/overpass.mjs` 多端點輪替＋重試退避（Overpass 常回 504）。

## 組檔規則（`buildHighwayGeojson.mjs`）

1. **依 `ref` 分組**成「線」，**分號/逗號要拆開（使用者：一堆路線重覆）**：共線 way 常被標成
   `ref="G1503;S20"`（兩條路共用車道，OSM 把兩個 ref 用 `;`／`,` 併寫）。**必須以 `[;,]` 拆開**，
   讓該 way **同時進 G1503 與 S20 兩組**；否則 `"G1503;S20"` 會變成第三條假路、與 G1503／S20
   整條重疊 → 整個走廊畫 2–3 次。拆開後靠步驟 6 全域邊去重把共用段畫一次（`routes` 列兩 ref）。
   `ref="1"`→國道1號、`"3甲"`→國道3甲號各自成線。線名優先 `ref:zh`＞`ref:en`＞`name:zh`
   （含 `;`／`,` 的合併字樣一律退回乾淨的拆開 ref）；顯示語言比照 metro `nameFor`。
2. **交流道合併＝一交流道一個點在中間（對應 metro 共站；使用者：同一交流道只能一個點）**：
   一個交流道有多個 motorway_junction 子節點（南下/北上、各匝道、A/B 子出口）。**union-find**
   併為一個，判準（任一成立）：正規化**同名** ≤2500m｜**同 exit 編號 base**（美國 36/36A/36B
   去尾碼字母→"36"，多半無名）≤2000m｜純距離 <250m（無名車道對）。代表座標取成員**質心**
   （＝落在交流道中間）、id 取最小節點 id。**沒併好會畫成多點＋平行重複線**（見步驟 6）。
3. **車道串接**（`buildPolylines`）：同 ref 的 ways 依**共用端點座標**貪婪串成極大 polyline，
   每條車道（oneway）成一條，南下/北上→兩條。
4. **一個 ref＝一條有序序列（使用者：路要整條同一條線，跟 metro map 一樣）**：一條路是其
   交流道的**單一線性序列**，依序以直線相接（同 metro 線壓站點；真實路形只用來「找出哪些
   交流道屬於這條路」與 fallback 排序、**不畫出**）。排序兩層：
   - **里程優先**：該 ref ≥60% 交流道有里程（出口編號數字：台灣＝公里、美國＝mile）→ 依
     里程排序當骨幹，**無里程者以「最小繞路」插入**（detour = d(A,X)+d(X,B)−d(A,B) 最小處）。
     **里程必須是「每路各自的」（`refMileage`）**：只取該 ref 自己 way 上節點的出口編號——
     系統交流道合併了多條路的節點，拿全域第一個編號會抓到別條路的（機場系統在國道1號是
     52K，卻拿到國道2號的 8）→ 整條路排序飛來飛去。`stations[].mileage` 也用每路里程。
   - **fallback（無出口編號的國家）**：取**最長車道相鄰鏈**當骨幹，其餘交流道同樣最小繞路插入。
   序列制使同 ref 平行道路（國道1號主線 vs 汐止五股高架，都 `ref=1`）**結構上不可能**畫成
   交錯辮子——高架的交流道被插進主線順序，輸出永遠一條線。相鄰對距離 > `MAX_EDGE_M`（30km）
   ＝真斷口 → 斷開不畫（絕無橫跨地圖的假長線）；**環線**（上海 G1503）頭尾在路上真正相鄰則補
   閉合邊。被斷口孤立的交流道不輸出（orphan-drop）、也不進 `stations`。
   歷史淘汰法：最近鄰+2-opt 硬串（假長線）、backbone 投影（亂序）、相鄰邊集合＋去三角化
   （擋不住主線/高架的四邊形辮子、又把路砍成一段一段）。verify 以 **`single_line_per_ref`**
   (error) 把關：同一 ref 內每交流道 degree ≤2（路徑或環，絕無分叉/辮子）。
5. **degree／角色**：由各 ref 序列的相鄰交流道對建鄰接圖。`is_interchange` ⇔ **屬於 ≥2 條 ref
   （系統交流道）或 degree>2**；`is_terminus` ⇔ degree==1（框邊界被切斷的端點）。
6. **一個交流道對＝一個 segment feature（全域邊去重，使用者：單一路線只能一條線）**：把各 ref
   的相鄰邊**跨 ref 去重**，共線走廊（concurrent、local/express 並行）只畫**一次**，`routes[]` 列
   所有行經它的 ref（同 metro 路段化）。一條國道的完整路徑＝所有 `routes` 含它的 segment 之聯集、
   同 class 同色 → 讀成一條連續線。只輸出出現在某段上的交流道（orphan-drop）。

**已知限制**：無出口編號國家走 fallback（骨幹＋最小繞路插入），順序偶有小幅跳動（audit 的
`mileage_order` warn 監看）；序列排錯時因畫直線會露出小段折返（不像真實路形被藏住），
以 `order_suspect` 表示，可用官方里程/交流道表校正。

## 欄位 schema（與 metro 對齊，必要欄位不可刪）

**交流道點 feature（Point，≙ metro 車站）**：
`station_id`（`n{osmId}`）, `station_name`（交流道名，依顯示語言）, `station_name_local`,
`network`（`"{國} Motorways"`）, `network_local`, `operator`, `city`, `country`,
`lines`（停靠＝行經此交流道的高速公路線名 list，**不變式：≥1**）,
`line_ids`（`hw-{slug}-{ref}`）, `line_names`, `exit_refs`（出口編號 list，highway 專屬）,
`mileage`（**里程/哩程**——交流道出口編號的數值；台灣交流道編號＝公里數、美國 exit＝mile，
故取 exit ref 的數字；無數字 ref 則 null。實測沿國道1號嚴格單調＝順序正確的佐證）,
`station_role`（interchange/terminus/normal）, `station_degree`, `is_interchange`, `is_terminus`,
`merged_from`（併入的車道節點數）, `merged_names`（異名成員，單一名時 null）, `wikidata`, `wikipedia`。

**高速公路路段 feature（MultiLineString，一個交流道對一段，≙ metro 路段；全域去重）**：
`seg_id`（`{slug}-{n}`）, `routes`（**行經此段的所有 ref**，共線走廊會有多項，每項 `route_id`＝`hw-{slug}-{ref}`, `route_name`
（國道X號）, `route_name_local`, `route_ref`,
`road_class`（`'motorway'`＝國道／`'expressway'`＝封閉式快速公路，依該 ref 的 way 是否含 motorway 判定）,
`route_color`（**依道路層級上色，非每線一色**——使用者：同一層同同色、可參考該國路標選色；
`SIGN_COLORS[country][road_class]`，如台灣國道藍#12489b／快速公路綠#1f8a4c，Autobahn 藍…，
未列國家用 default 藍/綠）,
`network`, `network_local`, `operator`, `wikidata`, `wikipedia`, `status: null`,
`order_suspect`, `stations`（該 ref 全交流道依序、已去重，每項 `{station_id, station_name,
mileage}`）, `pass_stations: []`）,
`route_count`, `route_refs`, `route_colors`, `route_color`, `city`, `country`。

**系統中繼資料（`highway_system`，≙ `metro_system`）**：
`continent`, `country`, `country_zh`（中文國名，由 metro `cityNamesZh.json` 推得，讓前端顯示
中英文如 metro maps）, `city`, `osm_networks`（present 的 ref list）, `operator`,
`line_count`（ref 數）, `segment_count`, `station_count`＝`interchange_count`（交流道數）。
index.json 的每筆 system 亦帶 `country_zh`；前端 `highwayCatalog.js`／Import 對話框以此顯示
中文＋English（layer 名＝中文國名）。

## 不變式（抓完必須成立）

1. metro 有錨點的都會區，高速公路檔**可為空**（有些都會區框內沒有 motorway）——與 metro
   的「清單有就不可能沒資料」不同，這裡允許空系統（0 features 則不寫檔）。
2. **不可能有交流道沒有線**——每個輸出的交流道 `lines` ≥1（不在任何邊上者不輸出）。
3. **不可能有路段沒有交流道**——每段幾何 ≥2 座標、兩端為交流道。
4. **交流道命名盡量高**（實測台灣 ~94%；無名者以出口編號合成 `交流道 {ref}`）——**不像
   metro 要求站名 100%**，因各國交流道命名習慣不同（美國多只有出口號）。

## 檔名與目錄結構（比照 metro）

```
data/highway/
├── highway_lines.geojson         # 全球所有高速公路路段
├── highway_interchanges.geojson  # 全球所有交流道
├── index.json                    # 系統清單
├── _cache/hw_{slug}.json         # 每都會區原始 Overpass 回應
└── systems/{洲全名}/{國slug}/{cc}.geojson   # cc＝{洲碼}-{IOC碼}，如 as-twn.geojson
```

洲別合併 `north-america`+`south-america`→`americas`（同 metro）。檔名用 `continentCode`+`iocCode`。

## 管線步驟

```bash
npm run highway:fetch          # scripts/fetchHighways.mjs  → data/highway/_cache/hw_*.json
npm run highway:fetch twn      # 只抓 cc/國名含 "twn" 的國家（試抓一國）
node scripts/fetchHighways.mjs as-chn,as-jpn,eu-   # 多國：逗號分隔；"eu-"＝全歐洲
npm run highway:build          # scripts/buildHighwayGeojson.mjs → data/highway/**
npm run highway:all            # fetch + build（全部國家）
```

快取存在就跳過抓取（`--force` 重抓），可安全中斷續跑。

## 前端

`data/highway/index.json` 由左側 Layers 面板新的 **Highways** layer group 載入（`mapStore.js`
的 `groups` 新增 `highway-maps`），每個系統以與 metro 相同的 metro 圖層渲染流程開成 tab
（schema 相同，D3／MapLibre 渲染器不需改）。**匯入對話框與 metro 一樣三分頁**（`DialogHost.vue`
的 `HIGHWAY_DIALOGS`）：**快速選擇**（常用國家依洲別分組）／**依交流道數排序**／**全球高速公路
地圖**（**洲別→國家→都會區** 三欄 miller，同 metro）。物件 tab 站序以「里程 K」徽章顯示。
Info 面板對 highway 圖層（`isHighway`）藏掉地鐵專屬連結（Wikipedia 地鐵/urbanrail/官方路線圖）、
標籤改「道路數/交流道數」。

## 授權與標註

- 幾何/屬性：© OpenStreetMap contributors，ODbL。
- 都會區錨點：沿用 metro（Wikipedia CC BY-SA + Nominatim）。

## 修改此管線時

任何規則變動（判準、欄位、命名、合併）**都要同步更新此 SKILL.md**；與 metro 對映的部分若
兩邊一起改，也要更新 [[metro-osm-fetch]]，維持「概念一一對應」。
