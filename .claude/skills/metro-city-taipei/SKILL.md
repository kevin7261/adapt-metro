---
name: metro-city-taipei
description: 台北（含新北、桃園）地鐵資料的城市專屬規則——桃園→台北合併、只收台北/新北/桃園三系統、LRT 範圍（淡海/安坑/環狀）、未通車例外（桃捷綠線/萬大一期/汐東線）、濱海沙崙與七張轉乘。是 [[metro-osm-fetch]]（取得）與 [[metro-audit]]（驗證）全球通用規則的台北層例外。處理、重抓或修正台北捷運資料時先查此檔，通用機制仍以 general skill 為準。
---

# 台北（含新北、桃園）城市專屬規則

一城一檔 `systems/asia/taiwan/as-twn-taipei.geojson`。相關 override：
`uc_exceptions.json`、`manual_lines.json`／`manual_curated.json`、`interchanges.json`、
`wiki_adjudications.json`、`station_names.json`。全球通用判準見 [[metro-osm-fetch]]、
[[metro-audit]]。

## 城市範圍

- **城市合併 `CITY_MERGE`：桃園 → 台北**（機場捷運屬台北都會圈，一城一檔）。合併在城市
  解析唯一出口 `mkInfo`，所有路徑（geocode／座標／override／rebucket）一體適用；
  Wikipedia 的「桃園」列由 [[metro-audit]] S1 以 `covered_by: Taipei` 判定通過並註記。
  改 `buildGeojson.mjs` 的 `CITY_MERGE`。
- **只收 台北捷運／新北捷運／桃園捷運 三系統**（`CITY_NETWORK_ALLOW`，正面表列）——
  機場航廈電車（Skytrain PMS）等一律剔除（機場接駁通則見 [[metro-cities]]）。
- **重抓的坑**：新增停靠站源會讓臺北捷運 geocode 重心漂到新北 → 用 `NETWORK_CITY`
  pin（台北捷運／新北捷運／桃園捷運 operator 直綁 Taipei）＋ CITY_MERGE。

## LRT 範圍與轉乘

- 台北（含新北）／高雄是通用 LRT 規則裡「城市檔附加 LRT 線」的兩個城市（淡海／安坑／
  環狀輕軌併入）。通用 LRT 判定見 [[metro-osm-fetch]]。
- **淡海輕軌綠山線↔藍海線分歧站濱海沙崙**是官方轉乘站；兩線同 ref V，但各為獨立營運線
  → 網絡圖度數 =3 → `is_interchange`。與「**七張**＝松山新店線主線＋小碧潭支線」同屬
  「不同 route 各通過一次都算換乘」（degree>2），共軌重疊段中間站（竿蓁林等 degree=2）
  不算。判定見 [[metro-audit]] `interchange_rule`。
- 淡海藍海線「成員 role 混標」（12 個成員只有臺北海洋大學標 `stop`）由通用「成員 role
  混標防護」處理，見 [[metro-osm-fetch]]。

## 未通車例外（使用者指定，「只收營運中」不變式的唯一例外）

- **走 `uc_exceptions.json`**（OSM 有具名 stop）：**桃園捷運綠線主線**（r11330479，17 具名
  stop）。`scripts/fetchUcExceptions.mjs`（`npm run metro:fetchuc`）抓取並在抓取端正規化
  lifecycle 標籤（`route=construction`→`subway`、車站 `railway=construction`→`station`、
  補 `network`），寫 `gap_*_uc` 快取；build 標 `status: "under_construction"`。
  **無名稱的建設中車站不收**（站名 100% 優先）。
- **走 `manual_lines.json`**（OSM 車站無名／佔位／無節點）：**萬大線一期**（LG01–LG08A
  9 站，淺綠 `#A9D08E`）、**汐東線首期**（SB10–SB15 6 站，天藍 `#7BC8E8`）。流程：
  `manual_curated.json` 放官方已公布站名的連續段（站名＋站序，來自 wiki／捷運局，agent
  查證）→ `scripts/buildManualLines.mjs`（`npm run metro:manuallines`）以 OSM way 線形
  （`_cache/uc_polylines.json`）插值補座標 → `manual_lines.json` → buildGeojson 注入為
  `status=under_construction` 的線＋站，走共站合併／snap／路段化（萬大線中正紀念堂＝
  G+R+LG 三線交會、汐東線東湖＝BR+SB）。**鐵律：只畫官方已命名的站**（站名 100%、不編造）。
- **暫不畫（官方尚未公布站名）**：萬大線二期、民生汐止線台北段（SB04–SB09）、環狀線南北環
  （18 站僅 4 站有官方名）。官方公布後補 `manual_curated.json` 重跑。
- **桃園綠線延伸線／支線（航空城支線、中壢延伸線）**：OSM 上只有 **construction way**
  （`桃園捷運綠線中壢延伸線`／`捷運航空城支線`），**沒有 route relation**，故 relation-based
  抓取抓不到。沿線有零星具名建設中站（橫山等，部分與主線共用）。這是規劃中延伸線——
  要畫得先確認官方三站站單齊全，再走 `manual_lines`（OSM way 線形插值），站名未定不畫。
- **OSM 零資料，待使用者提供官方站點座標**：桃捷棕線。
- under_construction 線的 wikilines 走 `line_wiki_planned` warn，不擋 audit。

## 路線名＝官方線名（使用者規則 2026-07，通則見 [[metro-osm-fetch]]）

OSM 上游線名雜訊由 `_overrides/route_tag_patches.json` 修成官方名（設 name/name:zh/
name:zh-Hant；master 錯就 patch master id）：板南線（原「臺北捷運 南港-板橋-土城線」）、
文湖線、松山新店線（原竟為端點名「台電大樓」）、小碧潭支線、新北投支線（原整串塞在
ref，補 ref=R 併入紅線分組）、環狀線（原「臺北捷運環狀線（大坪林」截斷）、中和新蘆線
（迴龍/蘆洲兩分支同官方名）、淡海輕軌藍海線（紅樹林–漁人碼頭 12 站）／淡海輕軌綠山線
（紅樹林–崁頂 11 站）、三鶯線、桃園國際機場捷運直達車（原「（快車）」合成標記；名含
「直達」故 expressMark 不再疊加）。

## 桃園捷運路線 id 加 TY- 前綴（使用者規則 2026-07）

桃園併入台北同一都會圈檔後，桃捷的字母 ref 會與台北自家線同字母混淆，故桃捷線 id
加 `TY-` 前綴（同樣走 `route_tag_patches.json` 設 `ref`）：
- **機場捷運（機捷）A → TY-A**：patch 打在 **route_master r6937084**（master ref 覆蓋
  4 條 route 變體 2108764/6937083/8487050/8487062 的 ref，見 buildGeojson `repTags`）。
- **桃園捷運綠線 G → TY-G**：與台北松山新店線/小碧潭支線同為 `G` → 改 TY-G 區別。此線
  無 master（未通車例外，走 uc_exceptions/gap_routes_uc），patch 直接打 route r11330479。

只改**線 id/`route_ref`**（UI 線徽與 refColor 由 geojson 自身 route_ref 推導，自洽）；
**車站代碼 A1–A22／G01… 不動**（另源、實體站號）。改後須重跑 `metro:buildonly`
＋`buildLandmarkCombined`（-lm 檔同步）。

## 手工線站名/線名一律中文（台灣 nameFor＝繁中）

`buildGeojson` 注入 manual_lines 時 `station_name`/`route_name` 用 `name_zh`（**不是**
name_en）——否則與 OSM 站異名、同名 ≤800m 合併對不上，轉乘站會分裂成兩點（中正紀念堂
曾分裂成 G+R 紅點＋LG 英文名藍點蓋在上面、東湖分裂成 BR＋SB「Donghu」；2026-07 修正）。

## 逐線裁決

`wiki_adjudications.json`：台北綠山線／藍海線（全系統站數）、淡水信義線等——wiki infobox
過期或計法不同、我方資料正確者（見 [[metro-audit]] 裁決機制）。
