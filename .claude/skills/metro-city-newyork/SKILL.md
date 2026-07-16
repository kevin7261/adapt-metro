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

## 同色幹線合併成 1 條（使用者 2026-07：1/2/3 同紅＝共線的同一條線，pass 是特例）

**紐約專屬、資料輸出層**：同一 route_color 的多個服務（1/2/3 全紅、A/C/E 全藍、B/D/F/M
全橘、N/Q/R/W 全黃…）＝官方幹線（by trunk/color）的**同一條線**，輸出時合成 1 條——
route_ref/route_name＝該色 refs 排序併寫（`1/2/3`／`A/C/E`／`B/D/F/M`），route_id＝
`nyc-trunk-{color}`。**快車跳站以 pass 表示**：合併線上，某站被同色快車跳過（express
沿 local 走廊 pass-through）就標 `pass:true`（如紅線 23rd/28th＝2/3 快車跳、1 慢車停；
34th–Penn／Times Sq 全停無 pass）。紐約 line_count 27→**11**（1/2/3・4/5/6・7・A/C/E・
B/D/F/M・G・J/Z・L・N/Q/R/W・S・SIR）。**不同色共軌仍各自一條**（Queens Blvd 的
B/D/F/M 橘＋E 藍＋R 黃 → route_count=3 → 渲染層交錯虛線不變）。

- 實作：`buildGeojson.mjs` 末端 per-system 寫檔前的 `mergeSameColourTrunks(feats)`，**只作用於
  `/new york/i` 的 city**（後處理最終 feature list）：路段 routes[] **只 relabel 顯示身分
  （route_ref/route_name→trunk），route_count＝相異色數**；車站 routes[] 依 ref→色→trunk 收名去重，
  pass＝任一同色服務 pass 的 OR。其他 222 城不受影響（逐服務一線不變）。
- **⚠️ 路段每個服務的 `route_id` 與 `stations` 絕不可合併/去重**（踩過的坑：曾把 1/2/3 併成同一
  route_id、只留第一條的 stations → 示意圖骨架 `skeleton.js` 以 route_id 為鍵逐路線建拓撲，
  其餘服務的站變成孤兒白點散布成團＝使用者截圖的 Straighten 白點畫錯）。同色畫一條實線只靠
  **渲染層 `_nc`（相異色數＝1）**，資料層維持逐服務 route_id/stations 完整（NYC 仍 27 條 route_id）。
- 與下方「渲染層 _nc」相容：合併後同幹線 route_colors 只剩 1 色→`_nc=1`→實線；跨色共軌 `_nc≥2`→
  交錯虛線。與「服務時段變體收斂／daytime express pass-through」相容（pass 由後者先算好、合併只做 OR）。
- **副作用**：audit 的逐線 wiki 站數對照（`line_wiki_stations`）以逐服務為單位，合併後 line_count
  變幹線數 → 該 audit 對照失準屬預期（幹線非逐服務）；不影響地圖／物件面板。

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

## 拆站 override（`interchanges.json` 的 `split`，同名站分屬不相通的不同線）

紐約下曼哈頓的 7 Av 線（1/2/3）與平行的 8 Av（A/C/E）、Broadway（N/Q/R/W）常同名卻**不轉乘**，
STRICT 的 <150m 仍會鏈式併起來（centroid 漂移，Canal 1 與 A/C/E 相距 255m 卻經中間節點併成一站）。
`_overrides/interchanges.json` 的 **`split`** 陣列逐站裁決：`{city,name,groups:[[refs]…]}`——每個
line-group 各自成站，**未列出 refs＝`rest` 那一站**（真 complex，如 Canal 東側 6/J/Z/N/Q/R/W）。
實作在 `buildGeojson.mjs` 共站合併的 **materialize**（合併之後）：一個合併簇裡**任一成員名 ==
split 站名**，就把整簇依 line-group 重拆成多站。

> **⚠️ 一定要在合併「之後」用簇代表名重拆，不能在合併前用逐 feat 名擋**（試過 union guard，
> 但 WTC 一帶是**跨名合併**：Cortlandt Street 併進了 WTC Cortlandt/Park Place 等異名節點，
> 逐 feat 名的 guard 對異名成員失效）。materialize 重拆用「簇裡有沒有 split 名的成員」判定 →
> 整簇（含異名成員）一起依 line 重分組。只對命中 split 名的簇生效，其他城市/站不受影響。

已裁決（使用者 2026-07 逐站回報，下曼哈頓 7 Av 線 1/2/3 與平行線多不轉乘）：
Canal St [1/2/3 | A/C/E | rest東側 6/J/Z/N/Q/R/W]、Rector St [1/2/3 | N/Q/R/W]、
Cortlandt St [1/2/3 | A/C/E | rest N/Q/R/W]（紅→WTC Cortlandt、藍→Chambers A/C/E）、
Chambers St [1/2/3 | A/C/E | rest]——**rest 讓 J/Z 與 Brooklyn Bridge–City Hall (4/5/6) 保持共站**
（使用者裁決：Chambers J/Z 與 Brooklyn Bridge 是同一 complex，故不把 J/Z 單獨列 group）。

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

## 紅/藍/白點判定（使用者裁決 2026-07-17，**NYC 純以畫線度數、視覺為主**）

使用者定案：**紅/藍/白點看「畫出幾條線」，不是停靠服務數；共線（多服務/多色共用同一
段畫線）算一條線、色數與服務數皆不計**（「就是以視覺上看到的樣子為主」）。落地＝
`buildGeojson.mjs` station_role **純看 `station_degree`（＝相異相鄰站數；共線給相同
前後鄰→collapse 成一條，正是「畫出幾條線」）**：

- **deg ≥3（畫線在此分岔/交會 junction）→ 紅點**：Rockaway Blvd（A 分岔 Lefferts/
  Rockaway，1 線 deg=3）、Rockefeller（4 向 deg=4）、135 St（2/3）、Brooklyn 59 St（N/R）。
- **deg ≤1（單一畫線盡頭）→ 藍點 terminus**：**即使該段是多色共線**——Jamaica Center
  （E+J/Z 共線盡頭、2 色仍 1 條畫線）、Astoria（N/W）、Broad St（J/Z）皆藍。
- **deg ==2（畫線直線通過）→ 白點**：**即使多服務同走廊**——5th Av-59（N/R/W）、
  72 St（1/2/3）、Euclid Av（A 貫通、C 在此終點但畫線 deg=2 續行→白，使用者「不是末端」）。

實測一致性：NYC 每站 role⟺deg 完全對齊（terminus⟺deg≤1、interchange⟺deg≥3、normal⟺deg==2）。

**⚠️ 旗標必須跟 role 一起覆寫（2026-07-17 修正）**：前端四處（`LayerTab`/`D3Tab`/
`GalleryTile`/`viewGeometry`）著色**只看 `is_interchange`/`is_terminus` 旗標、不看
`station_role`**。NYC 分支算完 role 後必須 `is_terminus = role==='terminus'` 覆寫——
舊旗標語義是「**任一服務**在此終點」（G 在 Church Av、C 在 Euclid、4 在 Utica、6 在
Brooklyn Bridge 終點→true），role=normal 的站照樣被畫成藍點（使用者回報 Church Av/
Crown Heights–Utica/Euclid/Chambers–Brooklyn Bridge 四站全中）。`is_interchange` 本就
以 isIx 同步寫入，不會漂。

**只限 NYC**（`isNYC` 分支）。**他城維持既有「相異色 ≥2 ＋（junction/端點）」規則**——
台北大橋頭（orange 分岔 deg=3、同色）在他城仍 normal（官方不算轉乘）；崁頂 2 筆同 V
仍藍。曾試「停靠服務數 ≥3 紅」「藍點限 1 服務」皆已廢（誤把 N/R/W 共線判紅、把
Jamaica Center 多色共線盡頭判非藍）——服務數/色數都不是判準，**畫線度數**才是。

## 快車 pass-through 走廊必須同色（seg-52 修正 2026-07-17）

自動快車跨站共線（`buildGeojson.mjs`，「自動快車跨站共線」段）原本在所有 ≤1.35× 直達的
平行鄰線裡挑**最長 inner** 當走廊——會抓到恰好也連 A→C 的**異色鄰線**。實例 seg-52：
N/Q 快車 Canal→Union Sq 跳站，被接到**綠線 Lexington 6**（Spring/Bleecker/Astor），畫成
假的黃綠共線、且 N/Q/R/W 在該段重覆。**修正**：快車與它的慢車是同一幹線＝**同色**
（黃線 N/Q 的走廊是黃線 R/W：Canal→Prince→8th St→Union，絕非綠線 6）。故**同色候選優先**
（`bestSameColor || bestVia`）；無同色候選才 fallback 異色（保留雪梨式「不同色線官方
共線」T1 快車＝T2 慢車）。

## 車站 routes 內嵌個別線色（停靠路線顏色修正 2026-07-17）

前端 hover（`popupHtml.js`）與物件 tab（`StylePanel.vue`）畫停靠路線色 swatch，原本靠
「以站 route 的 ref/name 對**路段** routes 建的 refColor 查表」。**trunk 合併後路段 ref
＝幹線值（"1/2/3"、"N/Q/R/W"），車站 route 卻是個別 ref（"2"、name "NYCS - 2 Train"）
→ 查表全 miss → swatch 全退預設玫瑰紅 `#e11d48`**（使用者：「物件tab hover 都變成紅色」）。
**修正**：`buildGeojson.mjs` 車站 `routes[]` 每筆直接內嵌 `route_color`（個別線色，
`routeMeta` 本就有）；`popupHtml.js` routeRow 與 `StylePanel.vue` stationRoutes 一律
`r.route_color ?? (查表) ?? '#e11d48'`。實測 Union Sq 4/5/6 綠、L 灰、N/Q/R/W 黃等正確。
（`H.swatch`／StylePanel 缺色一律退 `#e11d48`＝紅，故「缺色」的症狀就是「整片紅」。）

**共站（各線）chips 同病（2026-07-17 修正）**：`StylePanel` mergedNames 的 colorByRef
與 `popupHtml` 共站 chips 原本只以 **metroLines／路段 refColor**（trunk 合併後鍵是
"4/5/6"/"J/Z"）查 merged_names 的**個別 ref**（"4"/"J"）→ 全 miss 退玫瑰紅（使用者：
「共站（各線）的顏色也好多錯」）。**修正**：兩處都改成先用**本站 routes 自帶的個別線色**
（ref→route_color；共站 lines ⊆ 本站 routes 聯集，必然覆蓋），查不到才退 refColor 查表。

## 拆站 `names` 抑制 merged_names（Fulton/Lafayette 修正 2026-07-17）

`interchanges.json` 的 `split` spec 帶 `names`＝使用者裁定的**獨立站**。合併簇被 line-group
重拆後，各子站原本仍繼承整簇的 `merged_names`（兩名都列），前端把 merged_names 以「/」
串接顯示 → Fulton St[G] 與 Lafayette Av[C] 都顯示成「Fulton Street / Lafayette Avenue」、
誤讀為共站。**修正**：materialize 時只要該子站有 `forced`（來自 split `names`），
`merged_names` 一律設 null、`station_name`/`_local` 用 forced 名（單成員與多成員分支都做）。
