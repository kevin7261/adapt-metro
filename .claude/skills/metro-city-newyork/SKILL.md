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

## 共線只畫 1 條（使用者指定，兩個層次）

紐約共線極多（1/2/3 共 7th Av、A/C/E、B/D/F/M、N/Q/R/W…最多 9 線共軌）。「畫 1 條」
分兩處落地：

**（1）資料層——同 ref 變體合併（`mergeVariants`，phase A）**：紐約每條線的上下行／
深夜全停／尖峰／分支在 OSM 是多個 route_id（A 線 5 個、5/R/Q 各 2 個，共 44 個
route_id vs 實際 ~30 條）。這些是**同一條線的營運模式**，不拆成獨立分支（≠台北小碧潭
真支線）。判定 `network` 含 `nyc subway` 時，把 keptAll 的變體**按「共享車站」聚成連通
分量**、每分量合成 1 條線（用該分量第一個 rid 的 tags）：A 的 5 變體共享 A 走廊→1 條 A；
**S 的 Franklin／Rockaway Park／42nd St 三條獨立 shuttle 共用 ref S、彼此不共享車站→
各自獨立成 3 條**（不可無腦全合，否則 S 變 11 站怪物）。合併後 route_id 44→~30。
- 副作用：線站數變成「該線全服務並集」（深夜全停＋尖峰＋分支所有停靠站），比 wiki
  infobox 的單一時段多 → `wiki_adjudications.json` 裁決 A/D/Q/5/E/2/N/4 等（計法不同、
  我方為該線服務的所有站）。

**（2）渲染層——共線段畫單實線（`LayerTab`／`GalleryTile`）**：即使資料層合併，不同線
在同走廊仍是多個 segment。前端對 `city==='New York City'` 把所有路段（含 `route_count>1`
共線段）畫成**單一實線、用第一條線代表色（`_c0`／`route_color`）**，不生成 n 色交錯虛線。
`routes[]` 仍在，hover／Object 面板照列所有線。其他城市維持交錯虛線。

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
