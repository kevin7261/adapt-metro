# 全球地鐵資料 (Metro data)

從 **OpenStreetMap**（透過 Overpass API，**`route=subway` 與 `route=light_rail`（LRT）**——
不含 train/一般 railway/tram，**僅營運中**——排除建設中/規劃中/停用）
抓取的全球地鐵/輕軌路線與車站，以 **Wikipedia [List of metro systems](https://en.wikipedia.org/wiki/List_of_metro_systems)**
為覆蓋率基準，並對照 [urbanrail.net](https://www.urbanrail.net/) 驗證。

**線路幾何＝「共站合併後的車站點」依站序連線、重疊路段只畫一條**（route relation 只提供
成員與順序），**不是**真實軌道線形——**線永遠壓在站點上**：每個折點、端點都是車站本身；
同一路段被多線共用時只有一個幾何（`routes` list 記行經路線）；**快/慢車合併為一條線**。
**共站＝可轉乘**（OSM stop_area ∪ 同名 ≤800 m ∪ 人工裁決 overrides；非「同名就共站」），
座標取平均、lines 取聯集。

**城市規則（使用者指定）**：桃園併入台北（一城一檔）；LRT 線只有台北（含新北）/高雄
附加進城市檔，其他城市僅當其 Wikipedia 基準系統本身是 LRT（無 subway，或剔除後覆蓋率
跌破 0.6）才保留；其餘純 LRT 一律剔除。直通運轉覆蓋線（through-service）排除。
**東京不含私鐵**（只收 Tokyo Metro＋都營，私鐵直通聯運沾到即剔）。
**同一城市＝同一系統**：泛用交通詞不得決定城市、network 解析與線位置有 250 km 距離護欄
（防 Frankfurt→Berlin 類跨城誤配）。詳見 skill。

**不變式（每次抓完必以 Wikipedia＋urbanrail 驗證，違反＝資料有錯）**：
1. Wikipedia 清單上有的城市不可能沒資料；2. 不可能有車站沒有路線（每站 `lines` ≥ 1）；
3. 不可能有路線沒有車站、折點/端點必為車站（每線每段 ≥2 站，`vertex`）；
4. 站序必須正確（可疑者由 `verify_report` 標 `order`，逐線人工比對確認）。

> **權威依據（兩份 skill，互為 fetch⇄audit 迴圈）**：
> - 取得：`.claude/skills/metro-osm-fetch/SKILL.md`（OSM 資料 + 反查 + 組檔 + 下載官方路網圖）
> - 驗證與收斂：`.claude/skills/metro-audit/SKILL.md`（**逐城市** audit⇄修補迴圈＋全量
>   `verify_report`；策略階梯自動補抓/綁定，結果嵌入每系統 `metro_system.audit`，
>   前端 Info 面板顯示通過與否及原因）
>
> 任何重抓/更新都遵循該 skill；改動判準、欄位、命名時需同步更新 skill 與本檔。

## 產生方式

```bash
npm run metro:all      # 完整流程：wiki 清單 → OSM 抓取 → 反向地理編碼 → 組檔 → 逐城市 audit

# 或分步（每步都有快取，可續跑；失敗會留 .partial 標記，重跑自癒）：
npm run metro:wiki     # 抓 Wikipedia 地鐵系統清單 -> _cache/wiki_metro_systems.json
npm run metro:fetch    # 抓 OSM 全球 subway+LRT 路線/車站原始資料 -> _cache/*.json（幾何增量）
npm run metro:geocode  # 反向地理編碼每個系統中心點 -> _cache/geocode.json（洲/國/城）
npm run metro:build    # 組成最終 GeoJSON（含同名站合併、_overrides 綁定、audit 嵌入）
npm run metro:fetchtracks  # 抓 OSM route relation 的實際軌道 way 幾何 -> _cache/tracks_v*.json
npm run metro:buildtracks  # 產生地圖可選的 25% 透明實際軌道路線圖層 -> tracks/**
npm run metro:audit    # 逐城市 audit⇄修補到收斂 -> _cache/audit_state.json + metro_system.audit

npm run metro:maps     # 下載各系統官方路網圖 -> maps/**（需先有 index.json）
npm run metro:verify   # 對照 Wikipedia/urbanrail 全量報告 -> verify_report.json/.md
```

腳本在 `scripts/`（純 Node.js，無外部套件）：`overpass.mjs`（多端點重試+快取的 Overpass client）、
`fetchWikiList.mjs`、`fetchMetro.mjs`、`geocodeSystems.mjs`（Nominatim 反向地理編碼，限速 1 req/s）、
`continents.mjs`（ISO 國碼→洲對照）、`buildGeojson.mjs`、`fetchMetroTracks.mjs`、
`buildMetroTrackGeojson.mjs`。

## 輸出檔案

| 檔案 | 內容 |
|---|---|
| `metro_lines.geojson` | 全球所有**路段**（MultiLineString，重疊已去重，`routes` list 記行經路線） |
| `metro_stations.geojson` | 全球所有地鐵**車站**（Point，共站已合併） |
| `systems/{洲全名}/{國全名}/{洲2碼}-{IOC3碼}-{城}.geojson` | 每個城市/系統一個檔；**資料夾用全名**（洲：asia/europe/americas（北美南美合併）/africa/oceania，**不會有 unknown**——定位不到城市的雜訊不輸出；國家 slug 全名），**檔名用代碼**（洲 2 碼 as/eu/am/af/oc＋國家奧運 IOC 3 碼小寫，台灣 twn（ISO，使用者指定）、德國 ger…，對照表 `scripts/countryCodes.mjs`），例如 `systems/asia/taiwan/as-twn-taipei.geojson`；含該系統的路段+車站，並附系統中繼資料 |
| `systems/…/{城}-{jr\|lm\|lrt}.geojson` | **additive／split 變體系統**（由獨立後處理腳本產出、buildGeojson 不刪）：`-jr`＝城市＋JR 環線（`buildJrCombined.mjs`）、`-lm`＝城市＋地標（`buildLandmarkCombined.mjs`）、`-lrt`＝新加坡＋LRT＋Sentosa Express（`buildSingaporeVariants.mjs`；同時把 base `as-sgp-singapore` 覆寫成純 MRT） |
| `tracks/{洲全名}/{國全名}/{洲2碼}-{IOC3碼}-{城}.geojson` | 與 `systems/` 同路徑命名的**實際 OSM 軌道 way**（LineString）；僅供地圖底下的可選 25% 透明圖層，絕不取代站序 network |
| `index.json` | 所有系統清單、統計、以及 Wikipedia 有但 OSM 未比對到的系統（覆蓋率報告） |
| `maps/{洲全名}/{國全名}/{洲2碼}-{IOC3碼}-{城}.{png\|svg}` | 各系統**官方路網示意圖圖片**（與 systems/ 同名不同副檔名），另有 `maps/maps_index.json` 記錄每張圖的出處與授權。由 `npm run metro:maps` 下載 |
| `verify_report.json` / `.md` | 對照 Wikipedia/urbanrail 的**驗證報告**：不變式違規（`missing` 缺城市／`no_line` 車站無路線／`order` 站序可疑）＋站數落差待查清單，由 `npm run metro:verify` 產出，見 skill `metro-audit` |
| `_cache/` | Overpass/Wikipedia 原始回應（可刪，重跑會重抓） |

## 欄位 (properties)

**路段 (segment feature，MultiLineString；重疊路段只畫一條、每段必連續):**
`routes`（**list**，行經此路段的每條 route：`route_id`, `route_name`（在地語言＋去方向尾綴）,
`route_name_local`, `route_name_en`, `route_ref`（代號如 BL/R）, `route_color`（`#rrggbb`）,
`network`, `network_local`, `operator`, `wikidata`, `wikipedia`, `osm_route_ids`, `order_suspect`,
`stations`（該 route 的**完整行經序**，每項 `{ station_id, station_name, code?, pass? }`——
`pass:true`＝行經但不停靠（快車跳站）、`code`＝該線官方站碼，站序依碼正規化方向（A1 在前）；
站數/建圖一律取非 pass 項）），
頂層 `seg_id`, `route_count`, `route_refs`, `route_colors`, `city`, `country`
（**無單數 `route_color`**——路段可多線）。

> 幾何＝各 stop 依 relation 順序、吸附到共站合併後的車站點連成的折線（示意，非軌道線形）；
> 相鄰車站對被多條 route 共用時只輸出一次（路段化），同 route 集合的**不相連走廊拆成多個
> feature**（每段單一連通、hover 不斷開）。一條 route 的完整路徑＝所有含它的路段之聯集。
> **快車一律不抓**：只跳站的快車（子集）不另成 route；交錯停站（NYC J/Z）或獨立編號快線
> （香港 AEL）自然保留，跳過的站標 pass 畫共線。

**車站 (station feature):**
`station_id`, `station_name`（**在地語言**：台繁/中簡/港繁/日日）, `station_name_local`,
`station_name_en`（英文名，標題/hover 第二行）, `network`, `network_local`,
`operator`, `city`, `country`,
`routes`（此站的路線清單，每項 `{ ref, name, pass? }`——`pass:true`＝行經但不停靠）,
`lines`（停靠 refs，**至少一條**——空值屬資料錯誤，verify 標 `no_line`）,
`codes`（官方站碼清單，如台北車站 `[A1, BL12, R10]`；無則 null）,
`station_role`（interchange/terminus/normal）,
`is_interchange`, `is_terminus`, `merged_from`（共站合併來源數）,
`merged_names`（異名轉乘站合併後保留所有成員站名的 list，每項含 station_id/站名/在地名／
該名所屬路線 lines，單一名時為 null）, `pass_count`, `station_degree`, `wikidata`, `wikipedia`。

> 每站輸出**完全相同的欄位集**（缺值 null/false）——223 城的顯示表格全球一致。

**系統中繼資料（每個 `systems/*.geojson` 的 `metro_system` 欄位）:**
`continent`, `country`, `city`, `osm_networks`（合併進此城市的 OSM network 清單）, `operator`,
`official_website`, `official_map`, `wikidata`,
`line_count`（route 數）, `segment_count`（路段 feature 數）, `station_count`,
`audit`（[[metro-audit]] 逐城市驗證結果；未跑 audit 時 `null`）。

> `continent` / `country` / `city` 由各系統車站中心點經 Nominatim 反向地理編碼取得（座標為準），
> 檔名即由此三者組成。**一城一檔**：反查到同一城市的多個 OSM network 會合併進同一個檔。

## 關於「官方 metro map」

官方路網示意圖（schematic diagram）是圖片，**無法內嵌進 GeoJSON**，因此分兩種形式提供：

1. **地理版的地圖**＝這些路線的站序示意線形與車站座標（在 `metro_lines.geojson` / `systems/**`，可直接畫在地圖上）；
   每個系統的 `metro_system.official_map` 另存該系統 Wikipedia 連結、`official_website` 存營運單位官網。
2. **官方示意圖圖片本身**＝存在 `maps/{洲}/{國}/*.png|svg`，由 `npm run metro:maps` 從
   Wikimedia（Wikidata `P15` route map → Commons）下載，出處與**授權**記在 `maps/maps_index.json`。
   下載規則見 skill `metro-osm-fetch`（官方路網圖下載段）。

> 這些示意圖多為 CC BY-SA / Public domain（各圖不同），**再散布/放進論文時需依 `maps_index.json` 的授權署名**。

## 資料來源與授權

- 幾何與屬性：© OpenStreetMap contributors，[ODbL](https://opendatacommons.org/licenses/odbl/)。
- 系統清單/城市對照：Wikipedia（CC BY-SA）。
- 使用 `route=subway|light_rail` 作為判準（詳細範圍規則見 skill），與 Wikipedia 的 metro 定義高度重疊但非 100% 一致；
  `index.json` 內 `wikipedia_cities_without_match` 會列出未自動比對到的系統供人工檢視。
