---
name: metro-city-newyork
description: 紐約地鐵資料的城市專屬規則——同名站 STRICT 合併（23rd St 等分屬多線不相通的同名站不併，只認 stop_area 或 <150m）、2/N/4 車等深夜全停模式的 wiki 站數裁決。抓取、重抓、修正紐約地鐵資料，或紐約同名站誤併、某線站數比 wiki 多很多時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 紐約（New York City）城市專屬規則

## 只收 MTA 的線（`CITY_NETWORK_ALLOW`，使用者指定）

紐約檔只收 **MTA 系統**——NYC Subway（1–7、A–Z 各線）＋ **Staten Island Railway**（SIR，
MTA 子公司運營）。**PATH**（Port Authority of NY&NJ，跨哈德遜河到新澤西的 5 條線）
**不是 MTA，剔除**。判定 allow（nyc subway／new york city transit／mta／staten island rail）
＋ deny（`\bpath\b`／port authority）。⚠️ ckey `new york city` 含空格，city 比對兩邊都要
`normCity`（否則 "newyorkcity" ≠ "new york city"、規則整個失效、PATH 漏剔——這是實際踩過的坑）。

## 共線段只畫 1 條實線（渲染，使用者指定）

紐約共線極多（1/2/3 共 7th Av、A/C/E、B/D/F/M、N/Q/R/W…最多 9 線共軌）。**幾何**上
共軌段本就已路段化成 1 條 feature（`route_count>1`＋`routes[]` list，通用機制）；
**渲染**上紐約特例——前端 `LayerTab`／`GalleryTile` 對 `city==='New York City'` 把所有
路段（含共線段）畫成**單一實線、用第一條線代表色（`_c0`／`route_color`）**，**不生成
n 色交錯虛線**。其他城市維持交錯虛線。`routes[]` 仍在，hover／Object 面板照樣列出該段
所有線。這是**渲染層**的城市例外，資料（geojson）不變。

## 同名合併 STRICT 模式（`STRICT_SAMENAME`，車站不相通不合併）

紐約同名站多半**不相通**——23rd St 分屬 6 條線各自獨立，官方以 station complex 定義轉乘、
OSM stop_area 是每線每方向粒度。NYC 的同名合併只在「共線（同站方向節點成對）或 <150 m」
成立，**跨線同名遠站不併**（車站不相通就不合併）；官方 complex 用
`_overrides/interchanges.json` 回補。其他城市維持「同名 ≤800 m」（東京大手町／首爾等
真轉乘靠它，**不得全域加嚴**）。通用共站合併機制見 [[metro-osm-fetch]]。

`line 頂點吸附對「合併前成員點」找最近再映射回代表點`（質心位移不甩站——NYC 125th St
案例）是通用機制，見 [[metro-osm-fetch]]。

## 深夜全停模式的 wiki 裁決

2／N／4 車等，OSM 常以「深夜全停」relation 建模，站數高於 wiki infobox 的平日停站數
（2 車深夜 61 站 vs 平日 49）。依「快慢車合併＋服務到的站都畫」語義取全停集合，wiki 站數
差異寫 `wiki_adjudications.json`（見 [[metro-audit]] 裁決機制）。個別漏站以
`member_appends.json` 補（如 2 車 59 St–Columbus Circle）。
