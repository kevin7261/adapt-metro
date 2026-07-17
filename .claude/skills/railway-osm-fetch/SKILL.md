---
name: railway-osm-fetch
description: 抓取/重抓全世界國家鐵路（railway=rail 幹線＋高鐵，不含地鐵/輕軌/路面電車；私鐵預設收、可用 _overrides 排除）的路線與車站，產出 data/railway 下的 GeoJSON。當使用者要求抓取、更新、重抓國家鐵路/national railway/幹線鐵路/高鐵/HSR/新幹線/TGV/台鐵/JR 資料，或修改 data/railway 的資料管線時使用。這是 metro（[[metro-osm-fetch]]）與 highway（[[highway-osm-fetch]]）的「國家鐵路對應版」，schema 相同、下游共用；一國拆兩檔（高鐵 -hsr／一般國鐵 -rail，高鐵由 OSM route=railway 關聯的有序停站建以保證串接）；日本的一般國鐵再拆 JR 六社（東日本/西日本/東海/北海道/四國/九州 各自成系統，不全部一起），新幹線仍維持單一檔。正確性驗證（結構不變式＋逐線對照 wiki 站數）由 [[railway-audit]] 負責，兩者互為 fetch⇄audit 迴圈。
---

# 全球國家鐵路資料取得規則 (railway-osm-fetch)

此 skill 是 `data/railway/` **取得＋組檔**的權威依據，是 [[metro-osm-fetch]]／[[highway-osm-fetch]]
的**國家鐵路對應版**（第三條並列管線）。任何重抓/修改都須遵循此處規則，使不同時間抓的資料
結構一致、可比較。管線腳本：`scripts/railwayCountries.mjs`（國家清單）＋
`scripts/fetchRailways.mjs`（抓）＋`scripts/buildRailwayGeojson.mjs`（組），純 Node.js、無外部套件。

## 與 metro / highway 的對應（設計原則：一一對映，可共用下游）

| metro（[[metro-osm-fetch]]） | highway（[[highway-osm-fetch]]） | railway（本檔） |
|---|---|---|
| 系統＝一城市地鐵（一城一檔） | 一都會區封閉式路網（一都會區一檔） | **系統＝一國家的國鐵網（一國家一檔）** |
| `route=subway`（有 ref） | 編號封閉式道路（依 ref 分組） | **實體路線（依 `railway=rail` way 的線名分組：縱貫線 / 山手線 / TGV…）** |
| 車站 station 節點 | 交流道 motorway_junction | **車站 `railway=station`／`halt`（吸附到軌道圖上）** |
| 線幾何＝車站依站序直線連線 | 交流道依序直線相接 | **相鄰車站沿軌道以直線相接**（示意，不畫真實軌形，同 metro/highway） |
| 反向地理編碼定洲/國/城 | 沿用 metro 錨點 | **用國界 area（ISO3166-1）定範圍，不需 geocoding** |

**輸出的 GeoJSON schema 刻意與 metro 相同**（`seg_id`／`routes[]`／`stations[]`／`station_id`／
`station_name`／`lines`…），可直接餵給同一套 D3／MapLibre 渲染與示意圖管線
（[[route-skeleton-connect]]／[[route-hillclimb]]／[[route-rwd-draw]]）。系統中繼資料放在
`railway_system`（並鏡射一份 `metro_system{kind:'railway'}` 讓前端當 metro 圖層處理）。

## 判準（authoritative scope，使用者選：OSM 標籤啟發式，不看營運商）

**收（track-based，與 highway=motorway 同理）**：
- `railway=rail` **且** `usage=main` 或 `usage=branch`（幹線／支線的營運正線）
- 其中 `highspeed=yes` 的段 ＝ **高鐵**（新幹線／高鐵／TGV／ICE／AVE／KTX，使用者：高鐵要算）

**不收**：
- `railway=subway`／`tram`／`light_rail`／`monorail`（別的 railway 值，天然排除 → 不含地鐵/輕軌/路面電車）
- 帶 `service=*` 的 way（yard／siding／spur／crossover 側線調車線）、`usage=industrial`

> **為何 track-based 而非 route=train relation**：OSM 的 `route=train` relation 是**逐車次**的
> （ref＝車次號、name＝「區間 2703 彰化→車埕」），且**覆蓋不全**（台灣只涵蓋 ~111/295 站）。
> `railway=rail` 軌道**線名完整**（縱貫線/宜蘭線…）、**站站覆蓋完整**，且 `usage=main|branch`
> 正是使用者選的啟發式（way 標籤）。改判準必須先更新本文件。

### 私鐵：預設收，`_overrides` 兩層過濾（`include` 保護 ＞ `operators` 排除 ＞ 預設留）
使用者原則「私鐵不算」，但選了「不看營運商」的啟發式。多數國家 `railway=rail usage=main`
＝國鐵網，啟發式乾淨（台/韓/歐/美/加）。`data/railway/_overrides/{cc}_exclude.json` 支援兩個欄位，
皆比對 way/station 的 `operator`/`network`/`name`（正規化為 regex），優先序 **保護 ＞ 排除 ＞ 預設留**：
- **`operators`（排除黑名單）**：命中即丟。台灣 `as-twn_exclude.json`：**台糖五分車**（觀光糖鐵）、
  **臨港線**（貨運，花蓮/基隆/高雄臨港線客運已廢，wiki 證實）、**花蓮港站**、**鐵博東/西站**（博物館）。
  **貨運/博物館線 usage 仍是 main|branch，啟發式擋不掉 → 用 name/operator 排除**。
- **`include`（保護白名單，最高優先）**：命中即留，蓋過黑名單。用於「只收某營運商」的國家。

**日本例外（`as-jpn_exclude.json` 已建）**：私鐵（近鉄/京急/東武/名鉄/南海/阪急…）與第三セクター
（青い森/しなの/肥薩おれんじ/IGR/えちごトキめき/あいの風とやま…，多為原 JR 移交，使用者：**只收 JR＋新幹線**、
第三部門不收）也是 `rail usage=main`，啟發式擋不掉。做法：`include` 放 **JR 保護標記**（`旅客鉄道`/`JR`/
`新幹線`）→ JR 一律留，即使 way 名被誤標成並行私鐵線名（`op=東海旅客鉄道 nm=名古屋鉄道名古屋本線`）或
JR/私鐵**共線**（`op=西日本旅客鉄道;井原鉄道`、関西空港線、肥薩/くま川）也保得住；`operators` 放 **154 家
私鐵/第三セクター/貨物/觀光/保存鐵道黑名單**（由 rw_as-jpn 快取的 OSM `operator` 欄全量枚舉，連 no-operator
但 name 嵌公司名如 `南海電気鉄道南海本線` 一併排除）。`highspeed=yes` 一律保留（日本高鐵＝新幹線＝JR）。
**bare 線名無 operator 的 JR 線（東海道本線/常磐線/千歳線…）預設留**＝正確（不在黑名單即留）。
實測：軌道 kept 63366/dropped 26352，JR 誤刪 0、私鐵洩漏 0（12 個 `旅客鉄道;私鐵` 共站是真 JR 站，正確保留）。
日本 JR vs 私鐵白名單可用**官網／Wikipedia 的 JR 路線表**校準（使用者：可去官網與 wiki 確認）。

### 日本拆 JR 六社（使用者：一般國鐵不要全部一起，改成 JR東日本/西日本/北海道…；新幹線只要一個檔）
日本的**一般國鐵**不是單一系統：`buildRailwayGeojson.mjs` 的 `splitJapanByCompany` 在 buildSystem
**之前**把全國切成六個 JR 旅客會社（北海道/東日本/東海/西日本/四國/九州），各出一個
`as-jpn-{company}-rail.geojson`；**新幹線仍是全日本單一檔 `as-jpn-hsr.geojson`**（使用者：沒這麼多，
不拆社）——實作為 7 個 variant：第 1 個＝完整國家但只輸出 -hsr（`classOnly:'hsr'`，與拆分前的高鐵檔
位元等價，實測逐線站數相同）、後 6 個＝分社且只輸出 -rail（`classOnly:'rail'`）。分社分配規則：
- **way** → operator regex 命中（共營 `東;西` 取**字串最早出現**的公司）→ 新幹線線名對照表
  （`JP_SHINKANSEN`，長 key 先比：西九州⊃九州；補 op 缺漏如 `op=九州新幹線`、無 op 的東海道新幹線段）
  → **地理最近已分配 way，迭代傳播**（整條無 operator 的支線如鹿島線/久留里線從交會點鏈狀延伸補齊；
  12 輪內收斂）。私鐵 way 也會被地理分配到某社，但 buildSystem 內的 exclude override 照樣把它們丟掉
  （**分社≠收錄**）。
- **relation** → operator regex 收**所有**命中公司（共營關聯兩社都拿、各建自己軌道的區間）→ 新幹線
  線名 → **成員 way 佔比 ≥15% 或 ≥10 條**（東海道本線＝單一無 op 關聯 4140 成員橫跨三社 → 東/海/西
  各拿自己的區間：東 熱海–品川、海 米原–熱海、西 京都–神戸，靠各社 trackGeom 只含自家 way 讓
  trackOrder 取到自家最大連通元件）。
- **車站不分社過濾**：stationElements 原樣傳入，靠「吸附不到該社軌道就不輸出」的不變式自然分社；
  邊界站（熱海/米原）在兩社檔案各出現一次＝正確（同 hsr/rail 共站）。
- **KTX fallback 停用**（`raw.company` 時跳過）：分社建置車站未過濾，若不擋、四國會把他社新幹線
  旗標站 NN 串成假高鐵線（分社 variant 本就只輸出 -rail，此保護是防禦性的）。
- meta/index 帶 `company`/`company_zh`/`company_en`（JR東日本…），`operator`＝公司英文名。
- **已知簡化**：相鉄本線/博多臨港線/東海交通事業城北線是黑名單既有漏網（拆分前就在），非拆分引入。
**日本高鐵標籤＝「新幹線」不是「高鐵」**（使用者）：`buildSystem` 的 hsr class 標籤 country-aware，
日本 `class_zh='新幹線'`／`class_en='Shinkansen'`，其餘國家仍「高鐵/High-speed」。前端顯示「日本 新幹線」。
實測：新幹線檔 10 線/95 站（與拆分前逐線一致）；六社一般國鐵＝北海道 13線/318站、東日本 59線/1668站
（鹿島線/久留里線靠迭代傳播撈回）、東海 13線/487站、西日本 44線/1201站、四國 8線/262站、九州 20線/555站。

## 資料來源

| 用途 | 來源 |
|---|---|
| 軌道線形＋線名＋usage/highspeed＋車站 | **OpenStreetMap**，經 Overpass API，判準見上 |
| 國家範圍（哪國、洲/國中英名） | **`scripts/railwayCountries.mjs`** 的清單（ISO2＋中英國名） |
| 私鐵排除／HSR 站校準 | 各國鐵路**官網**與 **Wikipedia**（使用者授權查證） |

## 目前資料範圍（使用者先抓）

`railwayCountries.mjs` 清單：**台灣・日本・中國・韓國**（東亞四國先行）＋**歐洲各國**
（法德英義西瑞荷比奧瑞典挪威丹麥芬蘭波捷葡愛匈羅希…）＋**美國・加拿大**。
`npm run railway:fetch` 預設抓全清單；`railway:fetch twn` 只抓子字串命中的國家。
**已抓並組檔（一國拆兩檔：高鐵 `-hsr`＋一般國鐵 `-rail`，使用者：把高鐵和一般國鐵分開）**：
台灣（高鐵 1 線/12 站、台鐵 16 線/242 站）、日本（新幹線單一檔 10 線/95 站＋**一般國鐵拆 JR 六社**，
見下「日本拆 JR 六社」節）、中國（**只高鐵路網** 177 線/1452 站，無一般檔）、韓國（KTX 1 線/10 站、
Korail 2 線/403 站）。

## Overpass 查詢（每國**三支**；bbox＝國界 area。tracks 選擇器可逐國覆寫）

```
# tracks — 運營正線 + 線名/usage/highspeed（trackWaySelector 通用版）
[out:json][timeout:900];
area["ISO3166-1"="TW"][admin_level=2]->.a;
way["railway"="rail"]["usage"~"^(main|branch)$"][!"service"](area.a);
out geom tags;

# tracks — 中國覆寫（使用者：中國只抓「高鐵路網」）：全國普鐵網極大會逾時，且只要高鐵。
# 改抓 highspeed=yes 並**去掉 usage gate**（部分客运专线/PDL 未標 usage）。stations 不變，
# build 時未吸附到高鐵軌的站自然被丟（不變式：無線之站不輸出）。fetchRailways.mjs trackWaySelector(iso2).
way["railway"="rail"]["highspeed"="yes"][!"service"](area.a);   # 僅 CN

# stations — 幹線車站（排除地鐵/輕軌/單軌 flavour）
[out:json][timeout:600];
area["ISO3166-1"="TW"][admin_level=2]->.a;
( node["railway"~"^(station|halt)$"]["station"!~"^(subway|light_rail|monorail)$"](area.a); );
out;
way["railway"="station"]["station"!~"^(subway|light_rail|monorail)$"](area.a);
out center tags;

# relations — 全部路線關聯（route=railway，每線一個）＋停站成員（供 §3/§4 逐線建線）
[out:json][timeout:600];
area["ISO3166-1"="TW"][admin_level=2]->.a;
relation["route"="railway"](area.a)->.rel;
.rel out body;                                        # 關聯 tags＋有序 member way/node refs
node(r.rel)["railway"~"^(station|halt|stop)$"]; out;  # 停站節點：座標＋名（軌道幾何用快取的 trackElements 由 member way id 撈）
```

原始回應**一國一檔**快取 `data/railway/_cache/rw_{cc}.json`（含 `trackElements/stationElements/relElements`＋
`relScope:'all'` 標記）。**增量補抓**：快取 `relScope !== 'all'`（舊的只抓高鐵關聯版）時，`railway:fetch` 只抓
全部 relations 併回，不重抓龐大軌道
（`--force` 才全部重抓）。穩健性沿用 [[metro-osm-fetch]]：`overpass.mjs` 多端點輪替＋重試退避（常回 504）。

## 組檔規則（`buildRailwayGeojson.mjs`）

1. **軌道 way 依線名分組**：線名 = way 的 `name`（CJK 取 `name:zh`、日本取 `name:ja`），
   **正規化**讓多股道合併：`縱貫線西正線/東正線/中正線/(南段)`→`縱貫線`、`臺`→`台`、去
   `上り/下り線`；橋樑/隧道等結構名（`…橋/隧道/高架/聯絡線`）與無名 way → `null`（退回類別標籤）。
2. **車站合併**（union-find，同 metro/highway 共站）：① 同正規化名 ≤2.5km 或純距離 <150m；
   ② **共站（共構轉乘）**：一個高鐵站與相鄰的一般鐵路站雖異名仍是同一實體站，<500m
   （`HSR_MERGE_M`）就併——高鐵台中↔新烏日、高鐵新竹↔六家、高鐵台南↔沙崙、高鐵高雄↔新左營
   （使用者確認）。代表座標取質心、名取眾數，成員含高鐵營運商則標記 `hsr`（供步驟 4）。
   **同城異址的高鐵站與台鐵站（青埔/太保/田中/豐富，相距數 km）不會併**＝正確保留為不同站。
3. **每條線由自己的 OSM `route=railway` 關聯逐線建（HYBRID 之一：關聯排序，核心，使用者：同一路線一定
   串接、參考台灣畫法、對 wiki）**。全域軌道走查在密集平行走廊（東京–横浜 疊 東海道/横須賀/京浜東北）
   會**跳到並行線**→ 站序亂、抓到別線的站（東海道本線曾混入相鉄西横浜、切成 20 段）；且 OSM 關聯的
   member way/停站**都不照地理順序排**（讀不出序）。故逐線：① **同線名的多個關聯先併**（東海道本線＝JR
   東/海/西 三關聯）union member ways；② 用該線 member ways 建**自己的軌道圖**（grid 18m 併上下行），
   **`trackOrder` 逐元件排序＋串接（關鍵）**：一條線自己的 way 在 18m grid 幾乎不會是單一連通圖——橋樑/
   平交道/車站區會把它裂成很多元件（山陰本線 1784 way→22 元件，最大只 38%）。**只取最大元件的 diameter
   會丟掉 60% 的線**（那些站投影不到主線→被 §3b 丟進 `一般鐵路` connector，就是使用者看到的「斷開/抓錯」）。
   故 `trackOrder` 對**每個元件各取 diameter**，再**依最近端點把元件串接成一條完整主線**（同一實體線的斷點；
   `CHAIN_GAP=9km` 上限——>9km 的碎片是斷開的殘片/遠支線，接了會畫 50–200km 假長線，故留在 connector）。
   只用該線自己的 way→無並行線汙染、無 name 變體重覆、單一路徑無分岔。實測 山陰本線 61→158、予讃線 52→88、
   奥羽本線 41→104、琵琶湖線 補回京都端 23 站，皆單段對 wiki；取**主線**（2×Dijkstra；環線如山手線→繞圈走）
   → 有序 polyline；③ **成員**：`nodeToStation`
   對應 member 停站節點，**一般國鐵**再把**距主線 ≤140m 的合併站** snap 進來（多數 JR 一般線關聯 0 個停站
   成員，靠 snap 才有覆蓋；因主線只是本線軌道，並行線不汙染）；**高鐵不 snap**（見 4）；④ **沿主線弧長
   排序**、去同名/近距重複、無上限連相鄰 → 整線 1 段串接。實測 東海道本線/中央本線/縱貫線/京广高速线 皆 1 段、對 wiki。
3b. **連通性補強（HYBRID 之二：軌道連通）**：關聯逐線只碰它列的站 → 網會分成很多塊、沒被任何關聯收的站
   會掉（曾讓台灣 245→184 站、1→7 元件）。故**另跑一次全域軌道走查**（台鐵式：每站沿軌道走到下一站、
   遇分歧沿最直方向續走、cap `MAX_EDGE_M`），把**尚未被關聯命名的站對**當**無名 connector**（`__conventional`）
   補進 `edges`——縫合整網＋撈回孤兒站，**不動關聯的線序**。高鐵段一律跳過。實測台灣**整網 1 元件 242 站**、
   日本一般 98%、韓台 100%。
4. **高鐵（high_speed）＝關聯排序但只用停站成員、不 snap**：高鐵**高架橋會壓過下方地方站**（東海道新幹線
   ← 武蔵小杉 32m），snap 會把它們灌進來 → 高鐵只用 member 停站∪`netToStations`（network 標某高鐵線且帶
   高鐵標記的站，如 品川 network=東海道新幹線；無高鐵標記不補）。**class 依線名**：`HSR_NAME_RE`（新幹線/
   高铁/高速线/客运专线/城际/HSL/KTX/고속…）命中＝高鐵，否則一般；**不用 highspeed-way 比例**（會把共用一條
   高架 way 的一般線如 高崎線/京浜東北線 誤判成高鐵）。**無乾淨高鐵關聯的國家（韓國 KTX）退回 fallback**：
   把 `hsr` 旗標站 NN 串成一條「高速鐵路」（多線併一條、不完美但有呈現）。實測 東海道新幹線 17 站 1 段＝wiki、
   日本 10 條新幹線純淨（無一般線混入）、京沪高铁 23 站、中國 177 條高鐵線。
   **class 落檔靠 `edgeClass = rec.hs`**（關聯高鐵邊 hs=true／走查 connector hs=false）→ 帶高鐵段的一般線
   （韓國 Honam Line）整條留一般國鐵。`routeMeta` 的 rail_class/顏色一律取所在檔 class。
5. **上色依鐵路類別（class），非每線一色**（同 highway 依道路層級）：`high_speed`（highspeed=yes）
   vs `conventional`（其餘）。`RAIL_COLORS[country][class]`（台灣：高鐵橘 #e9530e／台鐵藍 #1f4e96；
   TGV/ICE 紅…），未列國家用 default（高鐵紅/一般藍）。線名仍完整保留在 `routes[]`／`lines`。
6. **一線一 feature（跟 metro 一樣，使用者：同路線要同一條、不是一段一段）**：把站對邊**依
   「主行經線名」（該邊 way 名投票多數）分組**，每組串成極大路徑→**一個** line feature（`routes:[該線]`、
   `route_count:1`）；無名軌道邊（連接段）歸到 class 標籤（如「一般鐵路」）仍會畫出。**上色依 class**
   （一般＝台鐵藍、高鐵＝橘）→ 因所有一般線同藍且整網連通，**視覺上是一條連續藍網**，縱貫線的
   線名雖被山/海線邊界切成幾段 label，但顏色連續不斷（使用者的「中斷」指的是拓撲斷開，已解決）。
   斷口門檻 per-class（`capFor`）：一般 `MAX_EDGE_M` 30km、高鐵 `MAX_EDGE_HSR_M` 70km。
   **高鐵線名去重**：高鐵軌道可能有名稱變體（台灣高速鐵路／高速鐵路），一名是另一名的子字串且同屬
   高鐵軌時 relabel 併為一條（`remap`）；相異名的多條新幹線（東海道 vs 山陽，互非子字串）不受影響。
   實測台灣：整網 1 連通元件、高鐵 12 站單一連續、最長一般邊 19km（南迴實缺口）、最長高鐵邊 60km。

## 欄位 schema（與 metro 對齊，必要欄位不可刪）

**車站 feature（Point，≙ metro 車站）**：`station_id`（`s{type}{osmId}`）, `station_name`,
`station_name_local`, `network`（`"{國} Railways"`）, `operator`, `city`（＝國名）, `country`,
`lines`（行經路線名 list，**不變式：≥1**）, `line_ids`（`rw-{cc}-{線名}`）, `line_names`,
`station_role`（interchange/terminus/normal）, `station_degree`, `is_interchange`, `is_terminus`,
`wikidata`, `wikipedia`。

**路段 feature（MultiLineString，≙ metro 路段；全域去重）**：`seg_id`（`{cc}-{n}`）,
`routes`（每項 `route_id`＝`rw-{cc}-{線名}`, `route_name`（線名，如「縱貫線」）, `route_color`
（依 class）, `rail_class`（`high_speed`／`conventional`）, `network`, `operator`, `status:null`,
`stations`（該線依序車站 `{station_id, station_name, mileage:null}`）, `pass_stations:[]`）,
`route_count`, `route_refs`, `route_colors`, `route_color`, `rail_class`, `city`, `country`。

**系統中繼（`railway_system`，≙ `metro_system`）**：`continent`, `country`, `country_zh`
（由 railwayCountries 清單給，前端顯示中英）, `city`＝國名, `city_zh`＝中文國名, `unit:'country'`,
`osm_networks`（線名 list）, `line_count`, `segment_count`, `station_count`, `interchange_count`。
`index.json` 每筆亦帶 `country_zh`；前端 `railwayCatalog.js`／Import 對話框以此顯示中文＋English。

## 不變式（抓完必須成立）

1. **不可能有車站沒有線**——每輸出車站 `lines` ≥1（不在任何邊上者不輸出）。
2. **不可能有路段沒有車站**——每段幾何 ≥2 座標、兩端為車站。
3. **一國家一檔**，0 features 則不寫檔（有些清單國家 OSM 幹線標記不全 → 允許空系統）。
4. **degree 分佈應以 2 為主**（穿越站）、少數 3–6（真交會：八堵/竹南…）；若冒出 10+ 度數
   ＝逐線排序退化成 mesh，須查線名正規化或 `LINE_SNAP`。

## 已知限制（v1；使用者可用官網/wiki 校正）

- **每線由關聯建、序＋站對 wiki**（HYBRID §3/§4）：東海道本線/中央本線/縱貫線/東海道新幹線/京沪高铁/京广
  高速线 皆 1 段串接、站序正確。連通靠 §3b 軌道走查 connector 縫合：**台灣/韓國 100% 單一元件、日本一般 98%**。
  無 `route=railway` 關聯或關聯 0 停站又 snap 不到的小線可能漏（覆蓋率取決於 OSM 關聯完整度）。
- **韓國高鐵不完美**：OSM 對 KTX 京釜/湖南高速線沒有乾淨的具名 `route=railway` 關聯 → 退回 fallback 把
  `hsr` 旗標站串成**單一條**「高速鐵路」（京釜＋湖南被併，10 站）＝有呈現但不分線；要修須等 OSM 補關聯或逐線 wiki override。
- **高鐵連通不強求**（日本高鐵 87%、中國 81%）：專用軌各線在 OSM 常不互連（無非高鐵联络线），跨線靠各自
  關聯獨立成線＝固有，非 bug。少數新幹線 feature 因與並行線共主幹（北陸↔上越共 東京-高崎）在 label 層被
  拆，站序仍完整、同色。
- **一般國鐵覆蓋 vs 連通的取捨已用 HYBRID 解**：關聯給正確線序、軌道走查 connector 給連通＋撈孤兒站。已加
  `^JR` 前綴正規化（`JR東北本線≡東北本線`）。要更準可加逐國線名正規化表或逐線 wiki override。
- **私鐵排除靠 `_overrides` 逐國表**：台灣（貨運/糖鐵/博物館）、**日本已建**（`as-jpn_exclude.json`：
  `include` JR 保護 ＋ `operators` 154 家私鐵/第三セクター黑名單，見上「私鐵」節）。其餘國家啟發式已乾淨。
- **中國只抓高鐵（HSR-only）**：只抓 `highspeed=yes`、未抓非高鐵联络线，跨線靠各自關聯獨立成線（不強求
  整網單一連通）。要收斂須放寬 CN tracks 選擇器含 `usage=main` 联络线（會擴到部分普鐵，與「只要高鐵」相衝，改前先問）。

## 檔名與目錄結構（比照 metro/highway）

```
data/railway/
├── railway_lines.geojson          # 全球所有鐵路路段
├── railway_stations.geojson       # 全球所有車站
├── index.json                     # 系統清單（每國一筆）
├── _cache/rw_{cc}.json            # 每國原始 Overpass 回應
├── _overrides/{cc}_exclude.json   # 逐國營運商/車站排除（私鐵、糖鐵…）
└── systems/{洲全名}/{國slug}/{cc}-{hsr|rail}.geojson   # 一國拆兩檔！as-twn-hsr（高鐵）＋as-twn-rail
                                                        # （一般國鐵）；中國只有 -hsr。日本例外：
                                                        # as-jpn-hsr（新幹線單一檔）＋
                                                        # as-jpn-{hokkaido|east|central|west|shikoku|kyushu}-rail
                                                        # （一般國鐵拆 JR 六社）
```
**一國兩檔（使用者：把高鐵和一般國鐵分開）**：`buildSystem` 回傳陣列，依 `rec.hs` 把邊拆成 high_speed／
conventional 兩個 FeatureCollection，各寫一檔、`index.json` 各一筆（帶 `rail_class`/`class_zh`/`class_en`）。
seg_id/route_id 前綴用 `{cc}-hsr`／`{cc}-rail` 避免全域彙整撞號；station_id 用 OSM id（跨檔共享＝同一實體站）。
洲別合併 `north-america`+`south-america`→`americas`（同 metro）。

## 管線步驟

```bash
npm run railway:fetch            # scripts/fetchRailways.mjs → data/railway/_cache/rw_*.json（全清單）
node scripts/fetchRailways.mjs twn        # 只抓子字串命中國家
node scripts/fetchRailways.mjs as-jpn,eu-fra --force   # 多國、逗號分隔、--force 重抓
npm run railway:build            # scripts/buildRailwayGeojson.mjs → data/railway/**（全部）
node scripts/buildRailwayGeojson.mjs twn  # 只組某國
npm run railway:all              # fetch + build（全清單）
```
快取存在就跳過抓取（`--force` 重抓），可安全中斷續跑。

## 前端

`data/railway/index.json` 由左側 Layers 面板新的 **Railways** layer group 載入（`mapStore.js`
`groups` 的 `railway-maps`＋`importRailwaySystem`），每系統以與 metro 相同的圖層流程開成 tab
（schema 相同，D3／MapLibre 渲染器不改；row icon＝`directions_railway`）。**匯入對話框三分頁**
（`DialogHost.vue` 的 `RAILWAY_DIALOGS`）：**快速選擇**（東亞四國＋歐美，依洲別分組）／**依車站數
排序**／**全球鐵路地圖**（洲別→國家，一國一檔無城市欄）。catalog 在 `railwayCatalog.js`。
**圖層名＝國名（countryZh），不可顯示 slug `rw-as-twn-hsr`**：`nameOf` 對 `l.railway` 回傳 `countryZh`
（不走 `metroDisplayName(id)`，否則 reload 後被覆寫成 slug，使用者指正）。**一國兩檔的顯示名帶 class**：
`railwayCatalog.js` 的 `withZh` 把 `countryZh` 組成「日本 高鐵」／「日本 一般國鐵」（`country`/`country_zh`
保持純國名供分組與 quick-pick 比對，另出 `labelEn`「Japan · High-speed」）。三分頁都逐 system 列一列：
**依車站數排序**與**全球鐵路地圖**本就 map 每個 system（自然兩列）；**快速選擇** `rwQuick` 改成把每個
QUICK 國家的所有 system（高鐵在前）各列一格。import id＝`rw-{cc}-{hsr|rail}`（唯一）。

## 授權與標註

- 幾何/屬性：© OpenStreetMap contributors，ODbL。
- 國家範圍：OSM 行政界（ISO3166-1）；中英國名見 `railwayCountries.mjs`。

## 修改此管線時

任何規則變動（判準、欄位、命名、合併、上色）**都要同步更新此 SKILL.md**；與 metro/highway
對映的部分若一起改，也要更新 [[metro-osm-fetch]]／[[highway-osm-fetch]]，維持「概念一一對應」。
