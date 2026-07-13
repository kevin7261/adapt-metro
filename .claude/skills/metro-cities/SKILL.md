---
name: metro-cities
description: 城市專屬規則的總索引與跨城通則。大城市各有專屬 skill——處理台北用 [[metro-city-taipei]]、東京/日本用 [[metro-city-tokyo]]、德國五城用 [[metro-city-germany]]、紐約用 [[metro-city-newyork]]。本檔收：機場航廈接駁電車通則、以及尚未獨立成 skill 的城市（香港/上海/北京/成都/蘇州/紹興/新加坡…）逐城個案裁決索引。抓某城前若不確定有無專屬規則，先查此索引。
---

# 城市專屬規則索引 (metro-cities)

全球通用判準、組檔、共站、命名、rebucket、不變式、策略階梯都在 [[metro-osm-fetch]]
（取得）與 [[metro-audit]]（驗證）。城市層的**例外**依城市拆成專屬 skill；本檔是索引，
外加機場通則與未拆分城市的個案裁決。

## 有專屬 skill 的城市（處理該城先用對應 skill）

| 城市／地區 | 專屬 skill | 主要例外 |
|---|---|---|
| 台北（含新北、桃園） | [[metro-city-taipei]] | 桃園→台北合併、三系統白名單、LRT、未通車例外 |
| 東京／大阪／日本 | [[metro-city-tokyo]] | 不含私鐵、站名線名用日文 |
| 柏林／漢堡／慕尼黑／法蘭克福／紐倫堡 | [[metro-city-germany]] | U-Bahn+S-Bahn、Stadtbahn 排除、DB 護欄 |
| 紐約 | [[metro-city-newyork]] | 同名 STRICT 合併、深夜模式裁決 |
| 香港 | [[metro-city-hongkong]] | 觀塘/屯馬/東鐵定向刷新、殭屍節點 |
| 上海 | [[metro-city-shanghai]] | 龙居路未開通剔除 |
| 北京 | [[metro-city-beijing]] | 1/4 號線貫通計法、預留/封站剔除 |
| 成都 | [[metro-city-chengdu]] | 停運段剔除、高升桥漏站插補、線站數裁決 |
| 蘇州 | [[metro-city-suzhou]] | 7 號線南段補正、11 號線貫通、白荡南剔除 |

## 機場航廈接駁電車（全球通則，使用者：「台北不抓機場內輕軌」起）

`isAirportApm`——名稱／network／operator 含 旅客自動電車／自動電車運輸／航廈電車／
people mover／APM／Skytrain／Aerotrain／terminal shuttle 的 route 與車站一律排除
（桃園機場「旅客自動電車運輸系統」等）。**機場「快線」是真地鐵不排除**——機場捷運 A 線、
Airport Express、香港機場快線 AEL 等（regex 只擋接駁電車詞，不擋 metro/line/express）。

## 其他個案裁決（未拆分城市，`_overrides/` 逐城落地）

通用「未通過城市自動重抓」與「逐線 wiki 裁決」機制（見 [[metro-audit]]）在具體城市的落地
紀錄。機制通用、內容城市專屬——重跑資料若某城回退，先查這裡是否有既有裁決。

- **定向刷新（`refreshRelations.mjs` → `gap_*_refresh_*`）**：香港觀塘綫／屯馬綫／東鐵綫
  （route 漏 stop 成員／殭屍節點）；蘇州 7 號線、鄭州城郊線、紹興 1 號線（上游延伸段
  舊快取不更新）。
- **人工站序補正（`member_appends.json`）**：新加坡環狀線 CCL6 閉合段（Keppel／Cantonment／
  Prince Edward Road）；成都 10 號線高升桥（中途插站）；蘇州 7 號線南段（prepend）；
  鄭州城郊線航空港站（append）；NYC 2 車 59 St–Columbus Circle。
- **未開通站剔除（`station_excludes.json`，名稱＋座標半徑匹配）**：上海龙居路、北京
  红庙／福寿岭／八角游乐园、成都天府机场3/4航站楼＋2 號線停運段、重庆玉河沟、紹興张墅、
  蘇州白荡南、天津咸水沽北、鄭州须水、Pune Range Hills——OSM 標營運但 wiki 證實未開通/
  封站/停運。
- **無名站補名（`station_names.json`）**：Seoul／Istanbul／Wuhan／Marseille／Montreal／
  Recife／Doha 等的上游無名站，由 agent 查 wiki 站序命名（豁免墓碑）。
- **逐線 wiki 站數裁決（`wiki_adjudications.json`，綁 city+wiki+ours）**：北京 1／4 號線、
  成都 2／10／17／18 號線、蘇州 11 號線、青島 13／4 號線、Moscow 索爾采沃線、Atlanta
  Green、平壤千里馬線 等——wiki infobox 過期或計法不同、我方資料正確者。
- **Istanbul 是真實的歐亞兩岸**（博斯普鲁斯海峡分隔，欧洲侧 M1/M2/M3/M6/M7/M9/M11 ＋
  亞洲侧 M4/M5/M8 兩個不相連網絡）——**不是抓錯**，勿合併。
- **雪梨 Sydney Trains（舊稱 CityRail）市郊線＝route=train scope 例外**（使用者指定「雪梨
  要抓 CityRail」，性質同德國 S-Bahn）：市郊 T 線 T1–T9 在 OSM 標 `route=train`，不在基準
  查詢範圍，由 `scripts/fetchSydneyTrains.mjs`（`npm run metro:fetchsydney`）以雪梨 bbox＋
  `ref~"^T[0-9]"`＋network=Sydney Trains 補抓，寫 `gap_*_sydney` 快取；build 端 `NETWORK_CITY`
  以 network/operator「Sydney Trains」pin 到雪梨。**站源用乾淨的 `railway=station`＋`train=yes`
  節點與 way 中心**（不用月台 stop_position 具名——OSM 把 Sydney Trains 月台逐個具名成
  「Central, Platform 18」會把一站拆成多個點；Olympic Park 是 way，需 `out center` 才抓得到，
  否則 T7 只剩 1 站被丟）。NSW TrainLink 城際線 ref 非 T#，天然排除。**T 線的分支/快車變體
  （T1 Richmond／Emu Plains、T4 Cronulla／Waterfall、T8 南線／機場支線…）＝同一條線**，
  network「Sydney Trains」已納入 `mergeVariants`（見 [[metro-city-newyork]]），收斂成 T1–T9
  各 1 條（雪梨 15→10 route_id）。詳見 [[metro-osm-fetch]]。

## 新增城市專屬規則時

1. 若該城規則多，**新建 `metro-city-<城市>` skill**（description 寫明城市名＋觸發場景，
   讓抓該城時自動被參考）；規則少則加到本檔「其他個案裁決」。
2. 在 [[metro-osm-fetch]] 或 [[metro-audit]] 的通用段落留一句引用指回城市 skill。
3. 同步實作（`scripts/*.mjs` 的 `CITY_MERGE`／`CITY_NETWORK_ALLOW`／`NETWORK_CITY`／
   `isSbahnDe`／`NATIONAL_INFRA`／`isAirportApm` 等，或 `_overrides/*.json`）。
4. 重跑 `metro:build`（涉抓取則含 `metro:fetch*`）→ `metro:audit` 驗證不回退。
