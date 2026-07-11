---
name: metro-cities
description: 城市／地區專屬的地鐵抓取與驗證規則（台北、東京、德國、紐約等）——是 [[metro-osm-fetch]]（取得）與 [[metro-audit]]（驗證）全球通用規則的「城市層例外」。當使用者要求處理、修正、重抓某個特定城市／地區的地鐵資料，或該城出現抓錯城市、混入他系統、未通車路線、機場接駁、同名誤併、逐線裁決等問題時，先查本檔有無該城專屬規則，再回到通用 skill。任何城市專屬規則變動都要同步本檔與對應的 general skill。
---

# 城市／地區專屬規則 (metro-cities)

全球通用的判準、組檔、共站、命名、rebucket、不變式、策略階梯都在 [[metro-osm-fetch]]
與 [[metro-audit]]。**本檔只收「具名城市／地區的例外」**——使用者指定的特殊範圍、
未通車例外、誤配防護、逐城裁決。通用機制不重述，只在此標明該城如何偏離通用規則。

> 修改原則：本檔每條規則在 general skill 都有一句引用指回這裡；改動時兩邊一起改，
> 並同步實作（`scripts/*.mjs`、`data/metro/_overrides/*.json`）與 `data/metro/README.md`。

---

## 台北（含新北、桃園）

一城一檔 `systems/asia/taiwan/as-twn-taipei.geojson`。相關 override：
`uc_exceptions.json`、`manual_lines.json`／`manual_curated.json`、`interchanges.json`、
`wiki_adjudications.json`、`station_names.json`。

- **城市合併 `CITY_MERGE`：桃園 → 台北**（機場捷運屬台北都會圈，一城一檔）。合併在城市
  解析唯一出口 `mkInfo`，所有路徑（geocode／座標／override／rebucket）一體適用；
  Wikipedia 的「桃園」列由 [[metro-audit]] S1 以 `covered_by: Taipei` 判定通過並註記。
  改 `buildGeojson.mjs` 的 `CITY_MERGE`。
- **只收 台北捷運／新北捷運／桃園捷運 三系統**（`CITY_NETWORK_ALLOW`，正面表列）——
  機場航廈電車（Skytrain PMS）等一律剔除（見下「機場接駁」通則）。
- **LRT 範圍**：台北（含新北）／高雄是通用 LRT 規則裡「城市檔附加 LRT 線」的兩個城市
  （淡海／安坑／環狀輕軌併入）。通用 LRT 判定見 [[metro-osm-fetch]]。
  - 淡海輕軌**綠山線↔藍海線分歧站濱海沙崙**是官方轉乘站；兩線同 ref V，但各為獨立
    營運線（pass_count≥2）→ `is_interchange`。與「七張＝綠線主線＋小碧潭支線」同屬
    「不同 route 各通過一次都算換乘」，交會判定見 [[metro-audit]] `interchange_rule`。
  - 淡海藍海線「成員 role 混標」案例（12 個成員只有臺北海洋大學標 `stop`）由通用的
    「成員 role 混標防護」處理，見 [[metro-osm-fetch]]。
- **未通車例外（使用者指定：台北要畫特定未通車線）**——「只收營運中」不變式的唯一例外：
  - **走 `uc_exceptions.json`**（OSM 有具名 stop）：**桃園捷運綠線主線**（r11330479，17 具名
    stop）。`scripts/fetchUcExceptions.mjs`（`npm run metro:fetchuc`）抓取並在抓取端
    正規化 lifecycle 標籤（`route=construction`→`subway`、車站 `railway=construction`→
    `station`、補 `network`），寫 `gap_*_uc` 快取；build 標 `status: "under_construction"`。
    **無名稱的建設中車站不收**（站名 100% 優先）。
  - **走 `manual_lines.json`**（OSM 車站無名／佔位／無節點，走不了 uc_exceptions）：
    **萬大線一期**（LG01–LG08A 9 站，淺綠 `#A9D08E`）、**汐東線首期**（SB10–SB15 6 站，
    天藍 `#7BC8E8`）。流程：`manual_curated.json` 放官方已公布站名的連續段（站名＋站序，
    來自 wiki／捷運局，agent 查證）→ `scripts/buildManualLines.mjs`（`npm run
    metro:manuallines`）以 OSM way 線形（`_cache/uc_polylines.json`）插值補座標（有 OSM
    節點的站作錨點、其餘沿線等分＋端點外推）→ `manual_lines.json` → buildGeojson 注入
    為 `status=under_construction` 的線＋站，走共站合併／snap／路段化（自動與既有站共站
    ——萬大線中正紀念堂＝G+R+LG 三線交會、汐東線東湖＝BR+SB）。**鐵律：只畫官方已命名
    的站**（站名 100%、不編造）。
  - **暫不畫（官方尚未公布站名，不編造）**：萬大線二期、民生汐止線台北段（SB04–SB09）、
    環狀線南北環（18 站僅 4 站有官方名）。官方公布站名後補 `manual_curated.json` 重跑。
  - **OSM 零資料，待使用者提供官方站點座標**：桃捷棕線、桃捷綠線中壢段。
  - under_construction 線的 wikilines 走 `line_wiki_planned` warn，不擋 audit。
- **台北請重抓時的坑**：新增停靠站源會讓臺北捷運 geocode 重心漂到新北 → 用 `NETWORK_CITY`
  pin（台北捷運／新北捷運／桃園捷運 operator 直綁 Taipei）＋ CITY_MERGE。

---

## 東京

**不含私鐵**（`CITY_NETWORK_ALLOW`，使用者指定）——東京檔只收 Tokyo Metro（東京メトロ）
＋都營（東京都交通局），與 Wikipedia 基準一致。判定 allow＋deny 雙向：私鐵直通車是
聯合營運（operator 同時含都營與京急／京成等），**沾到私鐵即剔除**——deny 清單
京急／京成／東急／東武／西武／小田急／京王／相鉄／りんかい／ゆりかもめ…。
「直通運転」覆蓋線由通用的 through-service 排除處理，見 [[metro-osm-fetch]]。

---

## 德國（Berlin／Hamburg／Munich／Frankfurt／Nuremberg）

**U-Bahn＋S-Bahn 都要**（使用者指定），但只限這五個 wiki metro 城市。OSM 標法混雜：
- 柏林／漢堡 S-Bahn 標 `route=light_rail`（基準查詢抓得到，但會被 LRT 範圍規則剔除）→
  build 以 `isSbahnDe` 豁免（國家=Germany 且屬五城 `SBAHN_DE_CITIES` 且名稱含 S-Bahn／
  不含 Stadtbahn）。
- 慕尼黑／法蘭克福（Rhein-Main）／紐倫堡標 `route=train`（不在基準查詢）→
  `scripts/fetchSbahnDe.mjs`（`npm run metro:fetchsbahn`）以五城 bbox 補抓
  （`ref~"^S[0-9]+$"` ＋ operator/name 含 S-Bahn），寫 `gap_*_sbahn_de` 快取。
- 城市綁定：S-Bahn 的 `network` 是運輸聯盟名（VBB／MVV／RMV…）token 對不到城市，靠
  `NETWORK_CITY` 以 operator（S-Bahn Berlin／Hamburg／München／Rhein-Main／Nürnberg）
  直綁 pin。

**Stadtbahn（Karlsruhe／Stuttgart 等 tram-train）不是 metro**——名稱含「Stadtbahn」、
network 是 KVV／HNV／VRN、operator AVG 的線，是輕軌路面電車延伸，**非本資料範圍**，
`isSbahnDe` 不豁免（要求名稱含 S-Bahn 且不含 Stadtbahn），交 LRT 範圍規則剔除。

**rebucket 跳過全國性鐵路公司名（`NATIONAL_INFRA`）**——這些西南德國 Stadtbahn／S-Bahn
的 networks 常混入「DB Station&Service AG」「DB InfraGO」等**全國性**公司名，
geocode 會指到紐倫堡（Yorckstraße@8.38°E 的卡爾斯魯厄線曾整桶被搬進紐倫堡 190 km 外）。
rebucket 時比照 `Unknown` 跳過這些 network 名（`NATIONAL_INFRA` regex：DB Station／
DB InfraGO／InfraGO／DB Netz／DB Fernverkehr／Deutsche Bahn／Indian Rail…）。這是通用
rebucket 護欄的一環，但因德國最常觸發，記於此。修正後紐倫堡 31 線/248 km → 11 線/107 km
（U1–U3＋S1–S6，107 km 是 S-Bahn 區域覆蓋的正常範圍，非錯誤）。

> Ratingen／Bielefeld／Essen／Bochum 等非 wiki metro 城市的野檔是德國 Stadtbahn／
> S-Bahn 的副產物；若出現，檢查是否該由 LRT 範圍規則剔除或併入鄰近 metro 城市。

---

## 紐約（New York City）

**同名合併 STRICT 模式**（`STRICT_SAMENAME`）——紐約同名站多半**不相通**（23rd St 分屬
6 條線各自獨立，官方以 station complex 定義轉乘、OSM stop_area 是每線每方向粒度）。
NYC 的同名合併只在「共線（同站方向節點成對）或 <150 m」成立，跨線同名遠站不併；
官方 complex 用 `_overrides/interchanges.json` 回補。其他城市維持「同名 ≤800 m」
（東京大手町／首爾等真轉乘靠它，**不得全域加嚴**）。通用共站合併機制見 [[metro-osm-fetch]]。

**深夜全停模式的 wiki 裁決**——2／N／4 車等，OSM 常以「深夜全停」relation 建模，站數
高於 wiki infobox 的平日停站數（2 車深夜 61 站 vs 平日 49）。依「快慢車合併＋服務到的站
都畫」語義取全停集合，wiki 站數差異寫 `wiki_adjudications.json`（見 [[metro-audit]]
裁決機制）。個別漏站以 `member_appends.json` 補（如 2 車 59 St–Columbus Circle）。

`line 頂點吸附對「合併前成員點」找最近再映射回代表點`（質心位移不甩站——NYC 125th St
案例）是通用機制，見 [[metro-osm-fetch]]。

---

## 機場航廈接駁電車（全球通則，使用者：「台北不抓機場內輕軌」起）

`isAirportApm`——名稱／network／operator 含 旅客自動電車／自動電車運輸／航廈電車／
people mover／APM／Skytrain／Aerotrain／terminal shuttle 的 route 與車站一律排除
（桃園機場「旅客自動電車運輸系統」等）。**機場「快線」是真地鐵不排除**——機場捷運 A 線、
Airport Express、香港機場快線 AEL 等（regex 只擋接駁電車詞，不擋 metro/line/express）。

---

## 其他個案裁決（`_overrides/` 逐城落地）

這些是通用「未通過城市自動重抓」與「逐線 wiki 裁決」機制（見 [[metro-audit]]）在具體城市
的落地紀錄。機制通用，內容城市專屬——重跑資料若某城回退，先查這裡是否有既有裁決。

- **定向刷新（`refreshRelations.mjs` → `gap_*_refresh_*`）**：香港觀塘綫／屯馬綫／東鐵綫
  （route 漏 stop 成員／殭屍節點，17→實際站數）；蘇州 7 號線、鄭州城郊線、紹興 1 號線
  （上游延伸段舊快取不更新）。
- **人工站序補正（`member_appends.json`）**：新加坡環狀線 CCL6 閉合段（Keppel／Cantonment／
  Prince Edward Road）；成都 10 號線高升桥（中途插站）；蘇州 7 號線南段（prepend）；
  鄭州城郊線航空港站（append）；NYC 2 車 59 St–Columbus Circle。
- **未開通站剔除（`station_excludes.json`，名稱＋座標半徑匹配）**：上海龙居路、北京
  红庙／福寿岭／八角游乐园、成都天府机场3/4航站楼＋2 號線停運段、重庆玉河沟、紹興张墅、
  蘇州白荡南、天津咸水沽北、鄭州须水、Pune Range Hills——OSM 標營運但 wiki 證實未開通/
  封站/停運。
- **無名站補名（`station_names.json`）**：Seoul／Istanbul／Wuhan／Marseille／Montreal／
  Recife／Doha 等的上游無名站，由 agent 查 wiki 站序命名（豁免墓碑）。
- **逐線 wiki 站數裁決（`wiki_adjudications.json`，綁 city+wiki+ours）**：北京 1／4 號線
  （貫通運營計法）、成都 2／10／17／18 號線、蘇州 11 號線（3/11 貫通）、青島 13／4 號線、
  紹興 1 號線、Moscow 索爾采沃線（西段）、Atlanta Green（Avondale 班次）、大阪御堂筋線
  （北急直通）、平壤千里馬線、NYC 2／N／4 車（深夜模式）、台北綠山線／藍海線（全系統
  站數）、淡水信義線 等——wiki infobox 過期或計法不同、我方資料正確者。
- **Istanbul 是真實的歐亞兩岸**（博斯普鲁斯海峡分隔，欧洲侧 M1/M2/M3/M6/M7/M9/M11 ＋
  亞洲侧 M4/M5/M8 兩個不相連網絡）——**不是抓錯**，勿合併。

---

## 新增城市專屬規則時

1. 在本檔對應城市節加規則（或新增城市節）；
2. 在 [[metro-osm-fetch]] 或 [[metro-audit]] 的通用段落留一句引用指回本檔；
3. 同步實作（`scripts/*.mjs` 的 `CITY_MERGE`／`CITY_NETWORK_ALLOW`／`NETWORK_CITY`／
   `isSbahnDe`／`NATIONAL_INFRA`／`isAirportApm` 等，或 `_overrides/*.json`）；
4. 重跑 `metro:build`（涉抓取則含 `metro:fetch*`）→ `metro:audit` 驗證不回退。
