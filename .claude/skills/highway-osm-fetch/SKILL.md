---
name: highway-osm-fetch
description: 抓取/重抓全世界高速公路（motorway）的交流道與路網，把交流道沿高速公路串成網絡，產出 data/highway 下的 GeoJSON。當使用者要求抓取、更新、重抓高速公路/motorway/freeway/交流道/interchange 資料，或修改 data/highway 的資料管線時使用。這是 metro 管線（[[metro-osm-fetch]]）的高速公路對應版——同樣的「取得」概念，節點換成交流道、路線換成編號高速公路。
---

# 全球高速公路資料取得規則 (highway-osm-fetch)

此 skill 是 `data/highway/` 資料的**唯一權威依據**，是 [[metro-osm-fetch]] 的**高速公路對應版**。
概念一一對應，任何重抓/修改都須遵循此處規則，使不同時間抓的資料結構一致、可比較。
管線腳本在 `scripts/fetchHighways.mjs` + `scripts/buildHighwayGeojson.mjs`（純 Node.js，無外部套件）。

## 與 metro 的對應（設計原則：一一對映，可共用下游）

| metro（[[metro-osm-fetch]]） | highway（本檔） |
|---|---|
| 系統＝一城市地鐵（一城一檔） | 系統＝**一國高速公路網（一國一檔，使用者：台灣只要一個 geojson）** |
| 路線 `route=subway`（有 ref） | **編號高速公路 `highway=motorway`（依 `ref` 分組，如 國道1號）** |
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
| 高速公路線形 + 交流道 + 屬性 | **OpenStreetMap**，經 Overpass API，判準 `highway=motorway` + `highway=motorway_junction` |
| 都會區範圍（哪裡有系統、洲/國/城） | **沿用 `data/metro/index.json`** 的每個 metro 系統當錨點 |

**判準（authoritative scope，使用者指定「只抓 motorway」）**：**只收 `highway=motorway`**
（封閉式高速公路：台灣國道、美國 Interstate、德國 Autobahn…）與其上的
`highway=motorway_junction` 節點。**不抓** `trunk`（快速公路/主幹道）、`motorway_link`
（匝道）、`primary` 等一般道路，也不用 `route=road` 關係。要改判準必須先更新本文件。

## 系統單位：一國一檔（沿用 metro 錨點，不做地理編碼）

直接讀 `data/metro/index.json`，把 metro 系統**依國家分組**，每國一個高速公路檔：
1. 該國每個 metro 系統取**車站點 bbox**、外擴 `MARGIN_DEG`（0.30°≈33km）。
2. **union 成該國的總框**；若總框每邊 ≤ `SPAN_CAP`（6°）就**一次抓整國**（國道端到端完整，
   台灣/南韓…）；若過大（美國/中國會是巨框）則**逐 metro 區抓再合併**（遠隔都會區之間會有斷口）。
3. 洲/國碼由 metro 錨點 → `continentCode`/`iocCode`（`as-twn`）；**檔名 `{洲碼}-{IOC碼}.geojson`**
   （`as-twn.geojson`）；`city` 欄填國名。
4. 快取 `data/highway/_cache/hw_{cc}.json`（一國一檔）。

**輸出恆為一國一檔**（build 依國彙整）；巨國即使逐區抓、輸出仍是單一國檔（可能有都會區間斷口，
待日後補中段）。改 `MARGIN_DEG`/`SPAN_CAP` 只改 `fetchHighways.mjs`。

## Overpass 查詢（固定）

每個系統一支查詢（bbox = 擴框後的 `S,W,N,E`）：

```
[out:json][timeout:180];
way["highway"="motorway"](S,W,N,E)->.mw;
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
- 原始回應**一國一檔**快取於 `data/highway/_cache/hw_{cc}.json`（cc＝`as-twn`）；`--force` 才重抓。

穩健性沿用 [[metro-osm-fetch]]：`scripts/overpass.mjs` 多端點輪替＋重試退避（Overpass 常回 504）。

## 組檔規則（`buildHighwayGeojson.mjs`）

1. **依 `ref` 分組**成「線」：`ref="1"`→國道1號、`"3甲"`→國道3甲號各自成線。
   線名優先取 `ref:zh`（國道X號）＞`ref:en`＞`name:zh`；顯示語言比照 metro `nameFor`
   （台/中/港/澳→中文、日→日文、其餘→英文）。
2. **交流道合併**（對應 metro 共站）：南下/北上車道各有一個 motorway_junction 節點，同一
   交流道名、出口編號常不同（桃園交流道 49／49A／49B）。以 **union-find**：正規化同名且
   ≤2500m、或任意 <150m ⇒ 併為一交流道；代表座標取成員平均、id 取最小節點 id。
3. **車道串接**（`buildPolylines`）：同 ref 的 ways 依**共用端點座標**貪婪串成極大 polyline，
   每條車道（oneway）成一條，南下/北上→兩條。
4. **一個 ref＝一條連續線（使用者：同一個國道名一定只會有一條線一直連下去）**：把該 ref
   **所有車道**（南下/北上/平行高架都同 ref）上的交流道**全部蒐集**，用 **`orderAlongPath`**
   排成一條路徑——從最遠一對交流道的其中一端起（＝路的一端）、**最近鄰貪婪**串接、再 **2-opt**
   消掉長跨越邊（robust：即使 OSM 把路切成很多車道碎片、沒有單一 polyline 跨全程也對）。
   這條序列就是這個國道的**唯一一條線**：依序把交流道**以直線相接**（合併後座標）——真實路形
   只用來「找出交流道」、**不畫出**（同 metro 線壓站點；每頂點都是交流道點，整條國道一條線連
   到底）。**一個 ref 只輸出一個 line feature**（`routes` 只含該 ref）。實測台灣國道1號＝
   89 交流道由高雄端一路連到基隆端、緯度僅 4 次反向（都會區彎道/高架）。
5. **degree／角色**：由各 ref 序列的相鄰交流道對建鄰接圖。`is_interchange` ⇔ **屬於 ≥2 條 ref
   （系統交流道）或 degree>2**；`is_terminus` ⇔ degree==1（框邊界被切斷的端點）。
6. 只輸出**出現在某條國道線上**的交流道（對應 metro 的 orphan-drop）。

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
`station_role`（interchange/terminus/normal）, `station_degree`, `is_interchange`, `is_terminus`,
`merged_from`（併入的車道節點數）, `merged_names`（異名成員，單一名時 null）, `wikidata`, `wikipedia`。

**高速公路線 feature（MultiLineString，一個 ref 一條，≙ metro 路線；非逐段）**：
`seg_id`（`{slug}-{n}`）, `routes`（**只含該 ref 一項**，每項 `route_id`＝`hw-{slug}-{ref}`, `route_name`
（國道X號）, `route_name_local`, `route_ref`, `route_color`（依 ref 雜湊固定調色盤）,
`network`, `network_local`, `operator`, `wikidata`, `wikipedia`, `status: null`,
`order_suspect`, `stations`（該 ref 全交流道依序、已去重）, `pass_stations: []`）,
`route_count`, `route_refs`, `route_colors`, `route_color`, `city`, `country`。

**系統中繼資料（`highway_system`，≙ `metro_system`）**：
`continent`, `country`, `city`, `osm_networks`（present 的 ref list）, `operator`,
`line_count`（ref 數）, `segment_count`, `station_count`＝`interchange_count`（交流道數）。

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
├── _cache/hw_{cc}.json           # 每國原始 Overpass 回應
└── systems/{洲全名}/{國slug}/{cc}.geojson   # cc＝{洲碼}-{IOC碼}，如 as-twn.geojson
```

洲別合併 `north-america`+`south-america`→`americas`（同 metro）。檔名用 `continentCode`+`iocCode`。

## 管線步驟

```bash
npm run highway:fetch          # scripts/fetchHighways.mjs  → data/highway/_cache/hw_*.json
npm run highway:fetch twn      # 只抓 cc/國名含 "twn" 的國家（試抓一國）
npm run highway:build          # scripts/buildHighwayGeojson.mjs → data/highway/**
npm run highway:all            # fetch + build（全部國家）
```

快取存在就跳過抓取（`--force` 重抓），可安全中斷續跑。

## 前端

`data/highway/index.json` 由左側 Layers 面板新的 **Highways** layer group 載入（`mapStore.js`
的 `groups` 新增 `highway-maps`），每個系統以與 metro 相同的 metro 圖層渲染流程開成 tab
（schema 相同，D3／MapLibre 渲染器不需改）。

## 授權與標註

- 幾何/屬性：© OpenStreetMap contributors，ODbL。
- 都會區錨點：沿用 metro（Wikipedia CC BY-SA + Nominatim）。

## 修改此管線時

任何規則變動（判準、欄位、命名、合併）**都要同步更新此 SKILL.md**；與 metro 對映的部分若
兩邊一起改，也要更新 [[metro-osm-fetch]]，維持「概念一一對應」。
