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
真支線）。判定 `network` 命中 `mergeVariants` 名單（`nyc subway`／`sydney trains`／
`^mtr$`——紐約、雪梨 Sydney Trains、香港港鐵；使用者：「雪梨/香港的快車也是同一路線」）時，
把 keptAll 的變體**按「共享車站」聚成連通分量**、每分量合成 1 條線（用該分量**第一個 rid＝
最長變體＝各停/慢車**的 tags，滿足「以慢車車站為主」；其餘變體的站全部聯集進來）：A 的
5 變體共享 A 走廊→1 條 A；雪梨 T8 南線 vs 機場支線共用市中心＋南段主幹→1 條 T8；港鐵
東鐵綫馬場/落馬洲支線→1 條 EAL；**S 的 Franklin／Rockaway Park／42nd St 三條獨立 shuttle
共用 ref S、彼此不共享車站→各自獨立成 3 條**（不可無腦全合，否則 S 變 11 站怪物）。
- 共享判定用**站座標 5×5 鄰域（±2 格 ≈ ±222m）容差**——同站的上下行/快慢車常用不同月台
  節點、座標差一兩格（雪梨 T8 曾因精確網格判不出共享而未合併）；遠距 shuttle 仍分離。
  合併後紐約 route_id 44→~29、雪梨 15→10、香港 13→10。
- 副作用：線站數變成「該線變體並集」。**注意**：服務時段限定變體（`(late nights)` 各停版、
  `(am/pm rush)`）已在合併前被 **NYC 變體收斂**剔除（見下方「服務時段變體收斂」），故並集
  只含 daytime＋分支，站數對齊 wiki 平日（不再是深夜全停的膨脹值）。

**（2）渲染層——共線段依「相異色數」畫（`LayerTab`／`GalleryTile`，全球通則，含紐約）**：
即使資料層合併，不同線在同走廊仍是多個 segment。前端渲染規則（`_nc`＝該段 `route_colors`
的相異色數）：**`_nc=1`（同色共線，如紐約同 trunk 的 B+D 都橘、N+R 都黃）→ 1 條實線；
`_nc≥2`（不同色共線，如 F+G 橘+綠、1+C+2+A 紅+藍、M+E+R 三色）→ n 色交錯虛線顯示各線色**。
`routes[]` 仍在，hover／Object 面板照列所有線。
- **（歷史）** 早期曾有「紐約特例：所有共線段一律畫 1 條實線、用第一條線代表色」——因紐約
  38 段共線中 19 段是不同色的線共軌，該特例會蓋掉其他線色（G 被 F 蓋成橘），使用者遂改為
  上述全球通則（多色共線顯示各色）。`isNYC` 渲染分支已移除，紐約與其他城市一致。

## 同名合併 STRICT 模式（`STRICT_SAMENAME`，車站不相通不合併）

紐約同名站多半**不相通**——23rd St 分屬 6 條線各自獨立，官方以 station complex 定義轉乘、
OSM stop_area 是每線每方向粒度。NYC 的同名合併只在「共線（同站方向節點成對）或 <150 m」
成立，**跨線同名遠站不併**（車站不相通就不合併）；官方 complex 用
`_overrides/interchanges.json` 回補。其他城市維持「同名 ≤800 m」（東京大手町／首爾等
真轉乘靠它，**不得全域加嚴**）。通用共站合併機制見 [[metro-osm-fetch]]。

`line 頂點吸附對「合併前成員點」找最近再映射回代表點`（質心位移不甩站——NYC 125th St
案例）是通用機制，見 [[metro-osm-fetch]]。

## 服務時段變體收斂（daytime express 站型，取代舊「深夜全停」語義）

**現行（使用者 2026-07 裁決）**：OSM 把每條線拆成 daytime／`(late nights)`／`(am rush)`／
`(pm rush)`／`(evenings, weekends)` 多個 route relation；`(late nights)` 常是**各停全停版**
（4 號 daytime express 28 站 vs late-night 54 站）。若照「最長變體勝＋站聯集」，快車會**吃下
所有 local 站畫成各停**（68th/77th 錯掛 4 號）。build 端（`buildGeojson.mjs`，`routesTags`
組好後、`route_excludes` 之後）對 **network=NYC Subway 且有 daytime 基本變體（名稱無服務時段
括號）的 ref**，丟掉服務時段限定變體，只留 **daytime express 站型**——4→28、2→49（＝wiki
平日站數）等，快車跳過的 local 站由 pass-through auto 偵測**沿 local 走廊畫但不停靠**
（`lines` 不加快車），即 AEL/TCL 式共線。
**AM/PM rush 一律不抓（使用者裁決 2026-07，取代舊「尖峰限定保留」）**：`(am/pm rush)`
寫法一併命中（舊 regex 只認 `(am rush)`/`(pm rush)`、漏了 B 車的 `(am/pm rush)`），
**`<6>`/`<7>`/`<F>` 菱形尖峰車 ref 整個剔除**（6/7/F 本體仍在，40→36 條 route）；
**`Z` 保留**——J/Z skip-stop 是官方常設服務（官方幹線表列名）。
通用機制見 [[metro-osm-fetch]] 的「NYC 服務時段變體收斂」。

## 反向變體去重容差（±4 格，使用者 2026-07：「很多一模一樣的重覆路線」）

NYC 每條線的上下行是不同 relation、停靠不同月台節點；曼哈頓長月台的對向 stop 節點
可距 >250m → `dedupeSeqs` 預設 ±2 格（~222m）freshness 會把純反向變體誤判成「有新站」
→ 同名同站的第二條 route（7/R/C/E/M/D/Q/A 全中，40→36→實為 27）。NYC（network 命中
`nyc subway`）把 freshness 鄰域放寬為 **±4 格（~444m）**——真分支（Lefferts/Rockaway/
Franklin）都隔數公里，不受影響。修正後 27 條 route：23 個服務＋A 主線+Lefferts 分支
＋3 條 S 接駁（正確值）。

## S 接駁主名修正（route_tag_patches master 7894362）

net+ref 群組合併把三條 S shuttle 併進同群；代表 tags 取 master 7894362（OSM 上是
Franklin 的 master），但最長變體是 Rockaway Park 的 rows → 主 route 曾錯名
「Franklin Avenue Shuttle」。以 patch 把該 master 顯示名改為 Rockaway Park Shuttle
（Franklin/42nd 分支用自己 relation 名不受影響）；上游若把 Rockaway 拆成自己的
master 應刪除該筆。

## 官方幹線色（使用者裁決 2026-07：官方地圖連結色也不準，以幹線表為準）

OSM 自帶的 NYC 線色全是近似色（`#d82233` vs 官方 `#ee352e` 等）。build 端
`NYC_TRUNK_COLOR`（`buildGeojson.mjs`）依官方幹線表把 route＋master 兩層 colour 全部覆寫
（master colour 會蓋代表 tags）：ACE `#0039a6`（IND 第八大道）、BDFM `#ff6319`（IND 第六大道）、
G `#6cbe45`、L `#a7a9ac`、JZ `#996633`、NQRW `#fccc0a`、123 `#ee352e`、456 `#00933c`、
7 `#b933ad`、T `#00add0`、S 接駁 `#808183`。依據：zh.wikipedia「紐約地鐵路線列表」
（Pantone→hex）＋mta.info；SIR 不在表內、維持原色。

- **副作用（正面）**：站數回到 wiki infobox 平日單一時段（2 車 49＝wiki），舊「深夜全停」
  造成的膨脹（2 車 61 站）與對應 `wiki_adjudications.json` 裁決多半不再需要（計法已對齊）。
- 個別漏站仍以 `member_appends.json` 補（如 2 車 59 St–Columbus Circle）。
- **舊行為（已廢）**：曾取「深夜全停＋尖峰＋分支」全服務並集當該線站表、站數高於 wiki，
  以 `wiki_adjudications.json` 裁決；現改為 daytime express 站型，故快車正確畫成 express。
