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

1. **依 `ref` 分組**成「線」：`ref="1"`→國道1號、`"3甲"`→國道3甲號各自成線。
   線名優先取 `ref:zh`（國道X號）＞`ref:en`＞`name:zh`；顯示語言比照 metro `nameFor`
   （台/中/港/澳→中文、日→日文、其餘→英文）。
2. **交流道合併＝一交流道一個點在中間（對應 metro 共站；使用者：同一交流道只能一個點）**：
   一個交流道有多個 motorway_junction 子節點（南下/北上、各匝道、A/B 子出口）。**union-find**
   併為一個，判準（任一成立）：正規化**同名** ≤2500m｜**同 exit 編號 base**（美國 36/36A/36B
   去尾碼字母→"36"，多半無名）≤2000m｜純距離 <250m（無名車道對）。代表座標取成員**質心**
   （＝落在交流道中間）、id 取最小節點 id。**沒併好會畫成多點＋平行重複線**（見步驟 6）。
3. **車道串接**（`buildPolylines`）：同 ref 的 ways 依**共用端點座標**貪婪串成極大 polyline，
   每條車道（oneway）成一條，南下/北上→兩條。
4. **一個 ref＝一條線，只連「路上真正相鄰」的交流道（使用者：長直線一看就是錯的）**：
   對該 ref 每條車道（`buildPolylines`），取其上交流道依頂點序，**相鄰兩個**（中間沒有別的
   交流道）才算一條邊（road adjacency）；南下/北上同一對只留一條。**只畫這些相鄰邊**——每邊
   ＝兩交流道合併座標間的**直線**（同 metro 線壓站點，真實路形只用來找相鄰、**不畫出**）。
   如此連續路段是一條線（各段共用交流道點）、**真有斷口才斷、絕不會有橫跨地圖的假長線**
   （早期把全 ref 交流道用最近鄰硬串成一條會產生跨越邊——已淘汰）。`routes[].stations` 的
   線性順序改由**走訪相鄰圖**（每連通分量從端點走）取得。**一個 ref 只輸出一個 line feature**
   （MultiLineString，parts＝各相鄰邊；`routes` 只含該 ref）。實測台灣國道1號＝89 交流道、
   1 個連通分量（完整一條線）、最長段 18km（真實鄉間間距，非假長線）。
4b. **去三角化（使用者：好多抓錯變成三角形）**：相鄰邊有時形成三角形 A-B-C（三邊皆存在）——
   來源①同 ref 平行道路（國道1號主線 vs 五股楊梅高架）：主線 A→B→C 與高架 A→C 直連；
   來源②近距同站未併（五股轉接道 vs 五股交流道 88m 異名）兩者都連到三重。**每個三角形一律
   刪最長邊**（跳過中間交流道的「捷徑」邊），先**逐 ref**、再**全域跨 ref**（並行的 local/express、
   共線 concurrent 路段）各掃一遍。刪後仍連通（兩短邊仍串起三點）。verify 有 `no_triangles`(error) 把關。
5. **degree／角色**：由各 ref 序列的相鄰交流道對建鄰接圖。`is_interchange` ⇔ **屬於 ≥2 條 ref
   （系統交流道）或 degree>2**；`is_terminus` ⇔ degree==1（框邊界被切斷的端點）。
6. **一個交流道對＝一個 segment feature（全域邊去重，使用者：單一路線只能一條線）**：把各 ref
   的相鄰邊**跨 ref 去重**，共線走廊（concurrent、local/express 並行）只畫**一次**，`routes[]` 列
   所有行經它的 ref（同 metro 路段化）。一條國道的完整路徑＝所有 `routes` 含它的 segment 之聯集、
   同 class 同色 → 讀成一條連續線。只輸出出現在某段上的交流道（orphan-drop）。

**已知限制（ordering imperfection）**：部分國道有**與主線平行、同 `ref` 的高架路段**
（如國道1號五股楊梅高架），其交流道與主線交錯，`orderAlongPath` 排序在該處可能小幅跳動。線是
**連續一條**沒問題，但因為畫直線、錯序會顯示成一條橫跨的長直線段（不像真實路形那樣被藏起來）。
以 `order_suspect` 表示（比照 metro，未來可用官方里程/交流道表、或把高架 way 另分線來校正）。

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
