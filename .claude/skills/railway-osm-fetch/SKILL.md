---
name: railway-osm-fetch
description: 抓取/重抓全世界國家鐵路（railway=rail 幹線＋高鐵，不含地鐵/輕軌/路面電車；私鐵預設收、可用 _overrides 排除）的路線與車站，產出 data/railway 下的 GeoJSON。當使用者要求抓取、更新、重抓國家鐵路/national railway/幹線鐵路/高鐵/HSR/新幹線/TGV/台鐵/JR 資料，或修改 data/railway 的資料管線時使用。這是 metro（[[metro-osm-fetch]]）與 highway（[[highway-osm-fetch]]）的「國家鐵路對應版」，schema 相同、下游共用；一國家一檔。
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
**已抓並組檔**：台灣（台鐵＋高鐵，16 線/245 站）、日本（JR＋新幹線，only JR，215 線/4450 站）、
中國（**只高鐵路網**，147 線/1387 站）、韓國（Korail＋KTX/SRT，43 線/484 站）。

## Overpass 查詢（每國兩支；bbox＝國界 area。tracks 選擇器可逐國覆寫）

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
```

原始回應**一國一檔**快取於 `data/railway/_cache/rw_{cc}.json`（`rw_as-twn.json`），`--force` 才重抓。
穩健性沿用 [[metro-osm-fetch]]：`scripts/overpass.mjs` 多端點輪替＋重試退避（Overpass 常回 504）。

## 組檔規則（`buildRailwayGeojson.mjs`）

1. **軌道 way 依線名分組**：線名 = way 的 `name`（CJK 取 `name:zh`、日本取 `name:ja`），
   **正規化**讓多股道合併：`縱貫線西正線/東正線/中正線/(南段)`→`縱貫線`、`臺`→`台`、去
   `上り/下り線`；橋樑/隧道等結構名（`…橋/隧道/高架/聯絡線`）與無名 way → `null`（退回類別標籤）。
2. **車站合併**（union-find，同 metro/highway 共站）：① 同正規化名 ≤2.5km 或純距離 <150m；
   ② **共站（共構轉乘）**：一個高鐵站與相鄰的一般鐵路站雖異名仍是同一實體站，<500m
   （`HSR_MERGE_M`）就併——高鐵台中↔新烏日、高鐵新竹↔六家、高鐵台南↔沙崙、高鐵高雄↔新左營
   （使用者確認）。代表座標取質心、名取眾數，成員含高鐵營運商則標記 `hsr`（供步驟 4）。
   **同城異址的高鐵站與台鐵站（青埔/太保/田中/豐富，相距數 km）不會併**＝正確保留為不同站。
3. **連通性來自真實軌道圖，不是線名（核心，使用者：花蓮-台東/台中-彰化/屏東-台東 都不可中斷）**：
   OSM 線名在交會處會換名（台中線→「山線、海線共用路段」→彰化；臺東線→南迴線 near 臺東），
   **只按線名分組會在每個邊界斷開**。故：① 建**全域軌道圖**（所有 way 的頂點/邊）；② 每個
   車站的**vicinity 內所有頂點**都對應到該站（`STATION_TOL` 250m，容忍站點吸到月台/側線而非
   正線——否則走查會「路過」八堵/支線分歧而漏連）；③ 從每站沿每條軌道**走到下一站**，遇無站
   的合流/分歧點**沿最直方向續走**（轉角 >~60° 才停），故山/海線在彰化併回縱貫線、台東線走到
   臺東；④ 平行上下行走到同一下一站 → 站對 `ekey` 去重。實測台灣**整網 1 個連通元件**（245 站）。
   **高鐵走查由 `walkHsr = (hsLineNames.length !== 1)` 決定（核心，關係到中國/日本高鐵能否成線）**：
   - **恰一條高鐵線（台灣高鐵）**：專用軌幾何稀疏（隧道）走查會走散 → `walkHsr=false`，軌道走查
     **跳過**高鐵段（`if (e0.hs && !walkHsr) continue`），改由「取所有高鐵營運商站、NN 排序、相鄰連邊
     （cap `MAX_EDGE_HSR_M`）」建**單一連續高鐵線**（12 站）。
   - **多條高鐵線（中國 高鐵路網、日本 新幹線：東海道/山陽/東北/上越/北陸/九州…）**：專用軌密集有名，
     `walkHsr=true`，軌道走查**必須走高鐵段**（否則像中國全網皆高鐵 → 每條 corridor 都被跳過 → **0 features**，
     曾是 bug），依線名投票各自成線。實測日本 11 條新幹線 feature、中國 147 條高速/城际/客专線。
   ⚠️ 這是「只有一條高鐵時 skip、多條時 walk」的分岔；改 `walkHsr` 判準前先想清楚台灣 NN 路徑不能壞。
4. **高鐵線成員（membership）**：一般線用絕對距離（≤`LINE_SNAP`）；**high_speed 線**額外要求
   「該站是真高鐵站（`hsr` 營運商旗標）**或** 高鐵是其最近線（d ≤ 最近×1.15）」——**擋掉共構隧道裡
   被高鐵軌道掃過、其實沒有高鐵月台的台鐵站**（松山/萬華…），保留真正的轉乘站（板橋/南港…）。
   高鐵站若離稀疏隧道幾何較遠（台北/桃園/台中），對 `hsr` 站放寬 gate 到 3km 再吸附。
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

- **高鐵成員用營運商旗標（非軌道距離）**：high_speed 線的車站＝帶高鐵營運商的站（`hsr`），
  不受稀疏隧道幾何影響 → 台灣高鐵 12/12 站、單一連續線。非高鐵國家（法 TGV，營運商同 SNCF）
  則退回「高鐵是最近線」的距離判準（LGV 專用線多不與傳統線共廊，可行）。
- **線名以 OSM way `name` 為準**：偶有結構名（橋/隧道）汙染或 `縱貫線` vs `縱貫鐵路` 未併的細碎，
  屬標籤層雜訊，不影響網路拓撲；要更嚴謹可加逐國線名正規化表。
- **私鐵排除靠 `_overrides` 逐國表**：台灣（貨運/糖鐵/博物館）、**日本已建**（`as-jpn_exclude.json`：
  `include` JR 保護 ＋ `operators` 154 家私鐵/第三セクター黑名單，見上「私鐵」節）。其餘國家啟發式已乾淨。
- **中國只抓高鐵（HSR-only），拓撲會分段**：因只抓 `highspeed=yes`、未抓連接兩條高鐵線的非高鐵
  **联络线**，實測 1387 站分成 34 元件（最大 1000 站的核心網＋若干區域高鐵群）＝HSR-only 抽取的固有
  現象，非 bug。若日後要收斂成單一連通網，須把 CN 的 tracks 選擇器放寬到含 `usage=main` 的联络线
  （會擴大到部分普鐵，與使用者「只要高鐵」相衝，改前先問）。日/韓/台則近乎單一連通（99%）。

## 檔名與目錄結構（比照 metro/highway）

```
data/railway/
├── railway_lines.geojson          # 全球所有鐵路路段
├── railway_stations.geojson       # 全球所有車站
├── index.json                     # 系統清單（每國一筆）
├── _cache/rw_{cc}.json            # 每國原始 Overpass 回應
├── _overrides/{cc}_exclude.json   # 逐國營運商/車站排除（私鐵、糖鐵…）
└── systems/{洲全名}/{國slug}/{cc}.geojson   # cc＝{洲碼}-{IOC碼}，如 as-twn.geojson
```
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
**圖層名＝國名（countryZh，如 台灣），不可顯示 slug `rw-as-twn`**：railway/highway 圖層雖 `type:'metro'`，
但 `mapStore.migrateLayerNames` 的 `nameOf` 對 `l.railway` 回傳 `countryZh`、對 `l.highway` 回傳
`cityZh`（不走 `metroDisplayName(id)`，否則 reload 後名字會被覆寫成 rw-/hw- slug，使用者指正）。

## 授權與標註

- 幾何/屬性：© OpenStreetMap contributors，ODbL。
- 國家範圍：OSM 行政界（ISO3166-1）；中英國名見 `railwayCountries.mjs`。

## 修改此管線時

任何規則變動（判準、欄位、命名、合併、上色）**都要同步更新此 SKILL.md**；與 metro/highway
對映的部分若一起改，也要更新 [[metro-osm-fetch]]／[[highway-osm-fetch]]，維持「概念一一對應」。
