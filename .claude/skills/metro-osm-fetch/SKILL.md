---
name: metro-osm-fetch
description: 抓取/重抓全球地鐵（subway）與輕軌（light_rail/LRT）的路線、車站與官方路網圖（metro map），產出 data/metro 下的 GeoJSON 與圖檔。當使用者要求抓取、更新、重抓地鐵/輕軌/metro/subway/LRT 資料或路線圖，或修改 data/metro 的資料管線時使用。這是「取得」管線（OSM＋反向地理編碼＋組檔＋下載路網圖）；正確性驗證與逐城市收斂由 [[metro-audit]] 負責，兩者互為 fetch⇄audit 迴圈。
---

# 全球地鐵資料取得規則 (metro-osm-fetch)

此 skill 是 `data/metro/` 資料（含 GeoJSON 與官方路網圖）的**唯一權威依據**。任何重抓、更新、修改都必須遵循此處規則，使不同時間抓的資料結構一致、可比較。管線腳本在 `scripts/*.mjs`（純 Node.js，無外部套件）。

> **抓／改特定城市前，先查該城的城市專屬 skill**（通用規則有城市層例外）：台北→
> [[metro-city-taipei]]、東京/大阪/日本→[[metro-city-tokyo]]、德國五城→[[metro-city-germany]]、
> 紐約→[[metro-city-newyork]]；其餘城市的個案裁決索引在 [[metro-cities]]。城市規則實際
> 由本檔 script 的 `CITY_MERGE`／`CITY_NETWORK_ALLOW`／`NETWORK_CITY`／`isSbahnDe`／
> `NATIONAL_INFRA`／`isAirportApm` 等執行；城市 skill 記錄「為什麼、怎麼改」。

> **fetch⇄verify 迴圈**：本 skill 負責「取得」；[[metro-audit]] 負責用 Wikipedia 與 urbanrail.net
> 交叉驗證正確性並產出 `verify_report`。驗證發現的缺漏/異常（缺系統、站數線數落差、0 站…）會回饋到這裡，
> 據以調整查詢或重抓對應系統，再驗證，直到落差收斂。修改判準/分組時務必兩份 skill 一起更新。

## 資料來源（authoritative sources）

| 用途 | 來源 |
|---|---|
| 路線幾何 + 車站 + 屬性 | **OpenStreetMap**，經 Overpass API，判準 `route=subway\|light_rail` |
| 系統覆蓋率基準（哪些城市有地鐵） | **Wikipedia**: [List of metro systems](https://en.wikipedia.org/wiki/List_of_metro_systems) |
| 洲/國/城 命名 | **Nominatim** 反向地理編碼（以車站中心點座標為準） |
| 官方路網圖 (metro map) | **Wikidata `P15`（route map）→ Wikimedia Commons**；後備：Wikipedia 條目 infobox 的 `map` 參數 |
| 交叉驗證參考 | **Wikipedia** 站數/線數 + [urbanrail.net](https://www.urbanrail.net/)（見 [[metro-audit]]） |

**判準（authoritative scope）**：全球底料抓 **`route=subway`（地鐵）與 `route=light_rail`
（輕軌/LRT）**，**不抓 `route=train`、一般 railway、`route=tram`**。理由：Wikipedia 定義的
metro 在 OSM 上分佈於 subway 與 light_rail 兩種標法；train/railway 是城際/通勤鐵路、
tram 是路面電車，皆不屬本資料範圍。**排除直通運轉覆蓋線**（`直通運転`／"through service"／
"bypass line"——地鐵直通郊區鐵路的班次 relation，非路線本身）。
與 Wikipedia 清單的差異列於 `index.json` 的 `wikipedia_cities_without_match`，
由 [[metro-audit]] 逐城市收斂（含基準城市的 monorail 例外，僅逐城定向補抓）。
要再改判準必須先更新本文件。

**LRT 範圍規則（build 端，使用者指定）**——LRT 線進入城市檔的條件：
1. **附加 LRT 的城市**（`LRT_ADDON_CITIES`）：城市檔「附加」LRT 線（哪些城市見
   [[metro-cities]]，如台北／高雄／**新加坡**）。新加坡 Sengkang（SKLRT）是 `route=light_rail`
   （基準查詢抓得到，靠此規則保留）；但 **Bukit Panjang（BPLRT）／Punggol（PGLRT）標
   `route=monorail`**，不在基準查詢——由 `scripts/fetchSingaporeLrt.mjs`（`npm run metro:fetchsglrt`）
   補抓（route=monorail＋名稱含 LRT，**排除 Changi 機場 Skytrain**）。monorail 非 `light_rail`
   → 不被 lrtOnly 標記 → 自動保留、不受 LRT 範圍規則剔除。
2. **其他 Wikipedia 基準城市**：僅當該城**完全沒有 subway 線**、其 metro 系統本身就是
   LRT tagging（Vancouver SkyTrain、澳門輕軌、德國 Stadtbahn…）→ 整系統保留。
3. **其他情況的純 LRT 線**（有 subway 的城市之附掛輕軌、非基準的純 LRT 系統）→ 原則剔除，
   但有**覆蓋率例外**：若該城為 Wikipedia 基準城市、剔除 LRT 後保留站數 / wiki 站數 `< 0.6`
   （且 wiki 站數 ≥3），則保留其 LRT 線——這些系統的 metro 本體本就含 LRT（仁川 2 號線、
   吉隆坡／馬尼拉 LRT 等），全剔會使覆蓋率不足。判定在 rebucket 後、以最終正名城市為準。
判定單位是線路群組：群組內所有 relation 皆為 `route=light_rail` 才算 LRT 線（混合視為 subway）。

**城市合併規則（`CITY_MERGE`）**：把都會圈的鄰接行政市併成一城一檔（哪些城市見
[[metro-cities]]，如桃園→台北）。合併發生在城市解析的唯一出口（`mkInfo`），所有路徑
（geocode／座標解析／override／rebucket）一體適用；被併城市由 [[metro-audit]] 以
`covered_by` 標註通過。新增合併規則改 `buildGeojson.mjs` 的 `CITY_MERGE` 並同步 [[metro-cities]]。

**同一城市＝同一系統（不可抓錯城市，使用者指定）**——三層防護：
1. **token 黑名單**：泛用交通詞（`bahn`/`ubahn`/`sbahn`/`stadtbahn`/`lrt`/`light`/`tram`/
   `verkehrsverbund`…）不得參與城市名稱比對——曾發生「S-Bahn Frankfurt」的 `bahn`
   token 撞上「Berlin U-Bahn」把整個法蘭克福 U-Bahn 搬進柏林。
2. **rebucket 距離護欄**：以 member network 名稱解析出的目標城市，必須離群組重心
   ≤250 km 才准搬家（全國性營運商如 DB 的重心無意義）。
3. **線級距離護欄**：解析出的 wiki 城市離該線重心 >250 km ⇒ 該線絕不屬於該城，
   改用線自身座標（≤30 km 內的 wiki 城市）或原始反查城市。
   門檻 250 km 是因為中國直轄市（重慶等）的 wiki 座標是行政區幾何中心，可離市中心 ~150 km。
   如法蘭克福這類非基準城市的系統會成為**獨立的額外系統檔**（eu-ger-frankfurt），不會消失。

**快/慢車合併（使用者指定）**：同一路線的快車/慢車/區間車（同 `network`＋`ref`，或無 ref 時
同「去掉快慢字樣的基底名稱」）先合併成**同一個線路群組**。network 無法辨識（Unknown）時
**絕不跨組合併**——否則各城市無 network 的「1 號線」會被揉成跨國怪物群組。
**以慢車車站為主、快車一律不抓**（使用者裁決 2026-07，全球）：`dedupeSeqs` 依站數由多到少
處理，最長變體（＝各停/慢車，站最多）當主線／代表 tags；**fresh=0 的子集變體一律捨棄**——
含純反向/短交路**與「只跳站的快車」**（機捷直達車、東京急行/快速、Seoul 급행等：各停已涵蓋
全部車站，不另成 route、無 pass 標記）。**例外＝像紐約那種「不同車交錯停站」**（J/Z skip-stop
彼此有對方沒有的站 → fresh>0）**或獨立編號的快線**（香港 AEL 自有 ref、廣州 14/21 快車、
成都 18 號線快車）——本來就 fresh>0／獨立分組而自然保留，**不需例外機制**；其跳過的站仍由
pass-through 偵測就地標進 stations（pass:true）畫共線。

**端點延伸併入主線（使用者 2026-07：千代田線不可拆兩段）**：分支變體只與主線共用
**一個站**、且該站是主線**端點**（＝純線性延伸，官方碼連續——綾瀬 C19→北綾瀬 C20 是同一條
千代田線；OSM 常把尾段拆成 shuttle relation）→ 新站直接接進主線序列、**不另成 route**。
**中途分岔**（小碧潭在七張、東鐵羅湖/落馬洲在上水〔共用多站〕、NYC A 線分支）共用點非端點
或共用多站 → 維持獨立 route。

**同 ref 分支變體＝獨立 route、渲染層同色收斂（現行；`mergeVariants` 已於 2026-07-13 移除）**：
同 ref 內**帶來新站的分支/快車變體**一律各自獨立成 route（台北小碧潭支線 hover 不得連
主線一起 highlight；港鐵東鐵綫的羅湖/落馬洲/馬場變體、將軍澳綫的康城/寶琳、紐約 A 線
變體皆各自成 route）。**曾有的資料層強合併（mergeVariants：按共享車站聚連通分量併 1 條）
已移除**——強合併會串接站序、幾何來回鋸齒（曾把東鐵綫併成 42 站 Admiralty↔Lo Wu↔
Racecourse 來回跳）。視覺上「一條線」由**渲染層**處理：同色多 route 的共線段以「相異
色數」`_nc=1` 畫成 1 條實線（LayerTab／skeleton coline），故資料層多 route 不影響畫面。
副作用：`line_count`＝route 數會大於官方線數（東鐵綫佔 3）；同 ref 變體的**官方名必須
一致**（route_tag_patches 補齊，如三條東鐵綫同名），hover/資訊面板才不會像多條線。
**顯示身分（ref＋name）去重（使用者 2026-07 蘆洲截圖）**：同官方名分支在共用站/共用段
會出現兩筆一模一樣的列——車站 `routes[]`／`lines` 在 build 端依 ref＋name 去重（異名
分支如小碧潭支線不受影響）；線 hover 與物件 tab 的路段列同樣去重。**端點紅點規則用
顯示線數**：「端點站且停靠 ≥2 條線＝紅點」以去重後的官方線身分計——蘆洲（迴龍/蘆洲
兩 branch route 但同一條中和新蘆線）是單線端點＝藍點，不誤判紅。

**NYC 服務時段變體收斂（`network=NYC Subway`）**：OSM 把每條線拆成 daytime／`(late nights)`／
`(am rush)`／`(pm rush)`／`(am/pm rush)`／`(evenings, weekends)`… 多個 route relation。
`(late nights)` 常是**各停全停版**（4 號 daytime express 28 站 vs late-night 54 站）——
若不剔除，最長變體勝的去重規則會讓**快車吃下所有 local 站、畫成各停**。build 端
（`routesTags` 組好後）對**有 daytime 基本變體的 ref**丟掉服務時段限定變體，只留 daytime
站型——跳過的 local 站由 **pass-through auto 偵測**畫成共線。
**AM/PM rush 一律不抓（使用者裁決 2026-07）**：`(am/pm rush)` 寫法一併命中（舊 regex 曾漏），
**`<6>`/`<7>`/`<F>` 菱形尖峰車 ref 整個剔除**（6/7/F 本體仍在）；`Z` 是官方常設服務
（J/Z skip-stop，官方幹線表列名）→ 保留。
**NYC 官方幹線色（使用者裁決 2026-07）**：路線色一律覆寫為官方幹線表色（mta.info／
zh.wikipedia「紐約地鐵路線列表」：ACE #0039a6、BDFM #ff6319、G #6cbe45、L #a7a9ac、
JZ #996633、NQRW #fccc0a、123 #ee352e、456 #00933c、7 #b933ad、T #00add0、S #808183）——
OSM 自帶色全是近似色；route 與 master 兩層都覆寫（`NYC_TRUNK_COLOR`）。
細節見 [[metro-city-newyork]]。

**城市網路白名單（`CITY_NETWORK_ALLOW`）**：對特定城市正面表列/黑名單其收錄的 network
（判定 allow＋deny 雙向，聯合營運沾到黑名單即剔除）。具體城市規則見 [[metro-cities]]
（東京不含私鐵、台北只收三系統等）。

**scope 的城市／地區例外**：某些城市／地區偏離「只收 subway/light_rail」的通用判準——
如德國五城要含 S-Bahn（`route=train` 亦收，`isSbahnDe`＋`fetchSbahnDe`＋`NETWORK_CITY`
operator pin）、雪梨要含 Sydney Trains／CityRail 市郊 T 線（`route=train`，
`fetchSydneyTrains.mjs`＋`NETWORK_CITY` operator pin；站源用乾淨的 `railway=station train=yes`
節點與 way 中心，非逐月台 stop_position）、**大洋洲與非洲的「市郊鐵路／電車城市」**
（`fetchOceania.mjs`／`fetchAfrica.mjs`＋`TRAM_RAIL_CITIES` 白名單，見下）、台北要納入
特定未通車線。這類例外與其實作全部集中在 [[metro-cities]]。

**大洋洲／非洲的市郊鐵路＋電車城市（使用者裁決 2026-07-23，依 urbanrail.net 的
`au/oceania.htm`／`af/africa.htm`）**：這兩洲多數城市的都市軌道是 `route=train`（市郊鐵路）
或 `route=tram`（電車），且**不在** wiki List of metro systems，原本兩道關卡都會擋掉——
基準查詢不收 train/tram、`buildGeojson` 的「非基準純 LRT 一律剔除」把整城丟掉。三件事一起做：
1. `scripts/fetchOceania.mjs`（`npm run metro:fetchoceania`）：墨爾本（Metro Trains 16 線＋
   Yarra Trams 24 路線）、布里斯本、伯斯、阿德萊德（含電車）、奧克蘭、威靈頓。
2. `scripts/fetchAfrica.mjs`（`npm run metro:fetchafrica`）：南非三大都會 Metrorail＋Gautrain、
   達卡 TER、卡薩布蘭卡／拉巴特／亞歷山卓／阿爾及利亞七城電車。
3. `buildGeojson`：`NETWORK_CITY` pin 城市（gap 的 network **不會**進 `geocodeSystems`，
   不 pin 就落在行政區名如 North Canberra／Kirkos）＋`TRAM_RAIL_CITIES` 白名單豁免剔除；
   `SETRAM`（阿爾及利亞七城共用 operator）、模里西斯（完全無標籤）、黃金海岸 G:link
   （network 與溫哥華 TransLink 撞名）等綁不了 network 者走 `_overrides/`。
坎培拉／紐卡索／黃金海岸／阿迪斯阿貝巴／阿布加／突尼斯／模里西斯是 `route=light_rail`，
**本來就在基準查詢內**，只需 pin＋白名單，不必補抓。

**gap 的 route_master（`scripts/fetchGapMasters.mjs`）**：分組第一順位是 route_master，但
基準查詢只抓 subway|light_rail 的 master → 定向補抓的 train/tram 沒有 master 可用。此腳本以
Overpass 的 `rel(br.r)` 反查母 relation、寫 `gap_masters_*.json`，build 端在載入
`route_masters.json` 後一併載入（後載者勝）。沒有 master 又沒有 ref 的 route 由
`assignRefsFromMasters()` 依「master 名 → 顏色對照 → 名稱基底」補 `ref`，否則上下行與區間車
會各自成線（南非 Metrorail 的 route 完全沒有 ref：約堡 54 條 route 只有 17 個 master）。

**way-only route 的停靠序合成（`scripts/gapStopsFromWays.mjs`）**：少數城市的 route relation
只掛軌道 way、一個 stop 節點都沒有（阿德萊德 21 條全部、亞歷山卓 21 條合計只有 7 個節點成員），
路線幾何＝有序 node 成員的管線會把它們當「沒有站的線」丟掉。抓取端改以 way 幾何接成折線、
把乾淨站源投影回線上（垂距 ≤150 m）依里程排序，合成等價的 stop 成員寫進 `gap_geom_*`；
下游完全不必特例。fetch 腳本會自動偵測「0 個 node 成員」的 relation 套用。

**人工站序補正（`_overrides/member_appends.json`）**：wiki 已裁決通車、但 OSM 的
route relation **上游根本還沒把新站加進成員**（新站節點只掛在 stop_area）時——定向
刷新救不了——宣告式補正：`appends[]` 指定 relation 尾端依序補 `append_stops` 節點、
`prepend_stops` 補前段（上游成員只涵蓋路線一段，如蘇州7號線南段）、
`inserts: [{after: <成員節點id>, add: [...]}]` 中途插站（成都L10高升桥、NYC 2 車
59 St–Columbus Circle）、`close_loop: true` 補回第一個 stop（環狀不變式）。
節點座標/站名先以小腳本抓進 `gap_geom_*`/`gap_stations_*` 快取。例：新加坡環狀線
CCL6 閉合段。每筆必填 `note` 寫明 wiki 依據；上游補齊後應刪除該筆。

**快車跨站共線（使用者：像雪梨官方 CityRail 圖，很多路線共線、跳過的站是 pass）**：快車與
慢車共用物理軌道、但快車跳站時，站對站幾何走不同站段 → 抓不到共線（香港機場快線 AEL vs
東涌線 TCL、雪梨 T1 快車跳內西區＝T2 慢車走廊）。做法讓快車 route 的某段幾何**沿慢車的中間
站畫**（pass-through 頂點），使共用走廊被路段化判為共線畫雙色——但中間站**不算快車停靠**
（不進 `station_count`／`route.stations`，車站 `lines` 也不加快車）。兩層：
- **自動偵測（`buildGeojson.mjs`，snap 後、__vertexOwners 前）**：逐城逐線，路線的**長跳站邊
  A→C（>2 km）**若另一條線走 `A→…→C` 的近直線路徑（總長 ≤1.35× 直線、非繞路），就把中間站
  插入此線幾何、記入 `feat.__passCoords`。全球通用，雪梨 T1／T5 走廊、多數快慢車共線自動處理。
  **紐約特例（`grp.info.city`＝New York City）**：曼哈頓 express 跳 1 個 local 站的邊常
  <2 km（A 跳 Spring St ~0.7 km、B 跳 Cortelyou），通用 2 km 門檻會漏掉→畫成跳邊而非沿
  local 走廊。NYC 把門檻降到 **0.35 km**，仍靠 ≤1.35× 繞路守衛擋偽陽性（跳邊必須另有一線
  走 A→…→C 的近直線共軌路徑）。
  **排除名單（`express_passthrough.json` 的 `no_auto[]`，以 `route_osm` 認）**：獨立路線的跳站
  長邊剛好與另一條線「大致平行」但**實際不共軌**時會誤判成共線——列出該線 osm id 使其不參與
  自動偵測（仍可被手動 `passthrough[]` 指定）。案例：巴黎地鐵 **14 號線**（全獨立深層自動化隧道，
  Châtelet→Gare de Lyon 直達跳過 1 號線的 Hôtel de Ville／Bastille，與 1 號線並無共軌）。
- **手動 override（`_overrides/express_passthrough.json`）**：自動抓不到的特例（快車與慢車
  共軌後**兩邊都分岔**、沒有單一 route 走完 A→C，如香港 AEL Tsing Yi→**Sunny Bay 欣澳**→Airport，
  TCL 在欣澳轉東涌）。`passthrough[]` 以 `route_osm` 認 route、`from`/`to`/`via` 明列座標，注入
  在 phase A（stopNodes 之後），`passCoords` 隨 resolved 傳 phase B 存 `feat.__passCoords`。

兩者共用 `__passCoords`＋座標鄰近排除；手動已注入者變短邊、自動自然跳過。城市案例見
[[metro-city-hongkong]]（AEL/TCL 共線到欣澳）。

**共站合併的每城政策**：預設「同名 ≤800 m 合併」（東京大手町/首爾等真轉乘靠它，
**不得全域加嚴**）。**同名判準（`normName`）不分大小寫、去變音符（Gómez＝Gomez）、
去消歧義括號註記（`Anand Vihar (Blue Line)`＝`(Pink Line)`，Delhi/Mumbai/Kolkata…同站分屬
多線各掛一節點）、去結尾羅馬數字（Serdika II＝Serdika）——但**保留純阿拉伯數字**（Terminal
1/2、Line 1/2 是不同站不可誤併）。剩下語言不同（中/英、羅馬字）或異名的真轉乘，以全域近距
掃描（<200 m 跨線、非共線）產候選後，經 `interchanges.json` 逐對裁決（NYC 走 strict 另處理、
Paris 等純鄰近非轉乘為偽陽性須排除）。少數城市因同名站多半不相通需改用嚴格模式（`STRICT_SAMENAME`：
共線或 <150 m 才併，官方轉乘用 `interchanges.json` 回補）——哪些城市見 [[metro-cities]]
（如紐約 23rd St 分屬 6 條線各自獨立）。另：line 頂點吸附對「合併前成員點」找最近再
映射回代表點（質心位移不甩站——NYC 125th St 案例）。

**跨城轉乘站**：同站點 ~2 km 內有多個城市的線經過（姑娘桥＝紹興1號線↔杭州5號線）
→ 站點**複製**進每個城市檔（否則另一城的線頂點失主被剪）；誤複製的由 orphan-drop
自清。

**墓碑（`_cache/deleted_nodes.json`）**：站源殭屍（上游已刪/被拆名的節點）會被
頂點吸附撿走變成多出來的站——`scripts/pruneDeletedStations.mjs` 批次驗證
（活著＝存在**且還有名字**），死者拒收；被 `station_names.json` 人工補名的節點
豁免（本來就是「存在但無名」）。全量掃一次約 18k 節點/37 批。

**站名裁決出口（`_overrides/station_names.json`）**：key＝node id（`n` 前綴或純數字）、
value＝站名（在地語為主）。用途：①上游無名站補名；②**覆寫**既有名（不只補無名）——
上游把同站拆成多個異名節點時統一改成同名以同名近距合併（雪梨 Central 的 Platform 26/27）、
或修掉過時/舊稱名（東京 `n281417661` 的 `name:ja=新線新宿` 舊稱 → 改 `新宿`，否則
merged_names 冒出不存在的「新線新宿」）。**覆寫同時蓋在地語顯示鍵**（`name`＋`name:ja`／
`name:zh`／`name:zh-Hant`）——因 `nameFor` 對日/台/中優先取在地語鍵，只改 `name` 壓不過；
**保留 `name:en` 不動**（英文＝標題/hover 第二行）。查無名稱不得編造。

**定向刷新（上游更新後快取不會自己變新）**：幾何快取 content-addressed 只認
relation id 集合——**relation 成員在 OSM 更新（新通車段併入既有線）不會觸發重抓**
（例：新加坡環狀線 2026 閉合，Keppel/Cantonment/Prince Edward Road 併入 CCL 四個
relation，快取還是舊成員）。以 `node scripts/refreshRelations.mjs <slug> <rid...>` 定向
重抓該批 relation（tags＋成員＋具名節點），寫 `gap_*_refresh_{slug}` 快取；build 端
gap 檔一律**後載且覆蓋主快取**（後載者勝）。發現「某線 wiki 說已通車/延伸但我們
沒有」先懷疑這個，不用整包重抓。

**只收營運中（operational only）**：**已通車的路線必須全部收錄；未通車、建設中、
規劃中、停用的路線與車站一律排除**——這是不變式，不是偏好。
- **特定城市的未通車例外**（使用者指定要畫某些未通車線，如台北）走兩條機制——
  `_overrides/uc_exceptions.json`（OSM 有具名 stop：`fetchUcExceptions.mjs`／
  `metro:fetchuc`，抓取端正規化 lifecycle 標籤＋補 network，build 標
  `status: "under_construction"`）或 `_overrides/manual_lines.json`（OSM 車站無名／
  無節點：`manual_curated.json` 官方站名連續段＋`buildManualLines.mjs`／`metro:manuallines`
  沿 OSM way 線形插值補座標）。**鐵律：只畫官方已命名的站**（站名 100%、不編造）；
  under_construction 線的 wikilines 走 planned warn 不擋 audit。哪些城市／哪些線／
  用哪條機制／哪些暫不畫，全部見 [[metro-cities]]。
- lifecycle 前綴標法（`construction:route=subway`、`proposed:railway=station`…）本來就不會命中
  基準查詢；混標的（`route=subway` 加 `state=construction|proposed`、`construction=*`、`proposed=*`、
  `disused=*`、`abandoned=*`，或車站 `railway=construction|proposed|disused|abandoned`）由
  查詢條件排除，`buildGeojson.mjs` 的 `isOperational()` 再過濾一次（防舊快取漏網；
  除上述值外也擋 `planned`、`razed`）。
- 另過濾**站名括號註記**「(建設中/在建/未开通/未開通/規劃/规划/under construction/u/c)」的車站——
  中國 OSM 常只在名字標建設狀態、無 lifecycle 標籤。
- **整條線剔除（`_overrides/route_excludes.json`）**：OSM 把實際**未通車/建設中**的線誤標成
  營運中 `route=subway`（無 lifecycle 標籤，通過 `isOperational`），違反本不變式。列出其
  `exclude: [<osm_route_id>...]`，build 端在 `routesTags` 組好後最前面 `delete` 這些 relation
  （車站失去線路歸屬由 orphan-drop 清掉）。例：Kocaeli/Gebze **M1（2026 才通車）＋Körfezray
  M2（2028）** 皆建設中，剔除後整個 Derince/Kocaeli 系統消失（Kocaeli 非 wiki 營運中 metro 城市）。
  每筆附 wiki 依據，上游改標或實際通車後刪除該筆。

**機廠/車輛段不是客運設施（`isDepot`）**：名稱含 機廠/机厂/車輛段/车辆段/depot 的
route relation（出入段線，如「新北捷運淡海機廠」在 OSM 是一條 `route=light_rail`）與
車站/停靠節點（安坑機廠是**具名 stop_position**，會被「具名 stop 也是站源」規則撈進來
→ 安坑輕軌多出第 10 站）一律排除。

**機場航廈接駁電車不是都會地鐵（`isAirportApm`，使用者指定「台北不抓機場內輕軌」）**：
名稱/network/operator 含 旅客自動電車／自動電車運輸／航廈電車／people mover／APM／
Skytrain／Aerotrain／terminal shuttle 的 route 與車站一律排除（桃園機場「旅客自動電車
運輸系統」等）。**注意：機場「快線」是真地鐵不排除**——機場捷運 A 線、Airport Express、
香港機場快線 AEL 等（regex 只擋接駁電車詞，不擋 metro/line/express）。

**浮空站（站點不在任何線幾何上）是 OSM 上游資料問題，不得強行修**：不少 station 節點
的所在實體站，其 route relation **漏列該站為 stop 成員**（深圳7號線 route 的 29 個成員
不含文體公園），該 station 節點靠 `nearbyLineRefs`(900 m) 拿到 `lines` 卻不在線頂點上，
視覺上浮在線外。**曾嘗試「把浮空站插入投影最近的相鄰站段」自動補線——這會把站硬連到
錯誤路段、線形大亂連到周邊車站，比原問題更糟，已否決**。浮空站不是 audit 檢查項
（`stations_have_lines` 只查 `lines` 非空），不該為視覺修復而竄改幾何。正解只有：定向
重抓該城 route 補正確 stop 成員（`refetchFailedCities`／`refreshRelations`，能修上游已
補的），或接受 OSM 資料限制。**audit 是驗證正確性的工具，不得為了通過 audit／視覺整齊
而破壞真實線形**。

**成員 role 混標防護**：route relation 的停靠成員通常靠 role=stop 分桶取序；上游
role 標註不一致時（淡海藍海線 12 個成員只有臺北海洋大學標 `stop`、其餘空 role），
單靠入選 bucket 會漏站——入選 bucket 之外仍有 role=stop 成員時，依成員**原始順序**
合併兩桶重建序列。

**線路幾何＝「共站合併後的車站點」依站序連線 → 重疊路段只畫一條，不抓真實軌道線形**：
route relation 只提供兩件事——**哪些站屬於這條線、停靠順序**（＋名稱/顏色/代號）。
不取 relation 的 way（軌道）幾何。組檔流程：
1. 取 route relation 的 stop 成員依順序排列（無 stop 依序退回 platform、一般節點成員）；
2. 每個 stop 吸附（≤ ~600 m）到**共站合併後的車站點**（見「共站」節），頂點座標＝車站座標；
   連續吸到同一站的重複頂點合併為一；
3. **吸不到任何車站的折點一律不保留**；剩 <2 站的段捨棄；沒有任何段的線整條捨棄；
4. **路段化（重疊只畫一條）**：相鄰車站對（邊）被多條 route 共用時只輸出一次幾何；
   連續且「行經 route 集合」相同的邊串成一個**路段 feature**。station-order 檢查在
   路段化**之前**逐 route 計算，結果記在該 route 的 meta（`order_suspect`）。
結果：**線永遠壓在站點上**、**任何路段只有一條幾何**；一條 route 的完整路徑＝
所有 `routes` 含它的路段之聯集。

**路段 feature schema（MultiLineString，取代舊的單一 route feature）**：
- `routes`: **list**——行經此路段的所有 route，每項
  `{ route_id, route_name, route_name_local, route_ref, route_color, network,
     network_local, operator, wikidata, wikipedia, osm_route_ids, order_suspect }`；
- 頂層便利欄位：`route_count`（=routes.length）、`route_refs[]`、`route_colors[]`、
  `route_color`（=第一條的色，單色渲染退路）、`city`、`country`。
- **渲染規則（依「相異色數」，全球一致；`LayerTab`／`GalleryTile`）**：共線段看
  `route_colors` 的**相異色數**——**只有 1 種色（含同色多線共線，如同 ref 快慢車變體、
  紐約同 trunk 的 B+D 都橘）→ 1 條實線**（用 `route_color`／`_c0`）；**≥2 種色（不同色的線
  共軌，如紐約 F+G 橘+綠、1+C+2+A 紅+藍）→ n 色交錯虛線**（前端以 dasharray 偏移
  `[0, i×D, D, (n−1−i)×D]` 疊 n 層、依 `route_count` 取 slot）。前端用 `_nc`＝`new Set(route_colors).size`
  判定。**早期紐約特例「共線一律 1 條」已移除**（會蓋掉不同色線；使用者改為此通則，見
  [[metro-city-newyork]]）。

**不變式（invariants，抓完必須成立；抓完/重抓後一定要跑 [[metro-audit]] 稽核，
驗證一律對照 Wikipedia 與 urbanrail.net）**：
1. Wikipedia 清單上有的城市，**不可能沒資料**（severity `missing`）。
2. **不可能有車站沒有路線**——每站的 `lines` 至少一條（severity `no_line`）。
   車站先以 stop 節點 id 對應線路；對不上者以最近 stop（~900 m 內）補配；
   仍配不上的站視為非營運（所屬線在建/範圍外）剔除。
3. **不可能有路線沒有車站、折點/端點必為車站**——線幾何依上述規則由車站點構成，
   每線每段 ≥2 站（severity `vertex`）。
4. **站序必須正確**——線的折線順序＝實際停靠順序。OSM relation 的成員順序可能有錯，
   verify 會自動標可疑者（severity `order`），一律再以該線 **Wikipedia 條目**的車站列表與
   **urbanrail.net** 的線路站序人工確認後修正。
5. **路線必須連續（使用者規則）**——路段只含該路段的車站，每條 route 的「所有含它的
   路段」聯集必須是**單一連通分量**、中間不斷（hover 整條線不得出現缺口）。verify 逐
   route 以 union-find 檢查（severity `broken`，`systems_with_broken_routes`）；
   實測全 223 城 1151 條 route 為 0。

## 管線步驟（固定順序，每步有快取、可續跑）

```bash
npm run metro:all        # 完整資料重跑（= wiki → fetch → geocode → build → audit）

npm run metro:wiki       # scripts/fetchWikiList.mjs  → _cache/wiki_metro_systems.json
npm run metro:fetch      # scripts/fetchMetro.mjs     → _cache/{routes_tags,route_masters,stations,geom_*}.json
npm run metro:geocode    # scripts/geocodeSystems.mjs → _cache/geocode.json + wiki_city_coords.json
npm run metro:build      # scripts/buildGeojson.mjs   → data/metro/*.geojson + systems/**
npm run metro:fetchtracks # scripts/fetchMetroTracks.mjs → _cache/tracks_v*.json（實際軌道 way）
npm run metro:buildtracks # scripts/buildMetroTrackGeojson.mjs → data/metro/metro-tracks/**
npm run metro:audit      # scripts/auditLoop.mjs      → 逐城市 audit⇄修補到收斂（見 [[metro-audit]]）
npm run metro:maps       # scripts/downloadMaps.mjs   → data/metro/maps/** + maps_index.json（官方路網圖）
```

**重抓資料（要新的 OSM 快照）**：刪除 `data/metro/_cache/` 內對應快取檔後重跑該步。
只重組（改 schema/命名但不重抓）：只跑 `metro:build`。快取存在就跳過抓取，因此可安全中斷續跑。
`metro:maps` 需先有 `index.json`，故不含在 `metro:all` 內，單獨執行。

**快取正確性規則**：
- **失敗不得快取成成功**：任何一步被迫用部分/空資料頂替（route_master 抓失敗、車站面查詢失敗、
  幾何批次內有 relation 放棄），必須同時寫 `<快取檔>.partial` 標記（內含失敗原因/失敗 id）。
  下次執行看到 `.partial` 就視同無快取重抓，成功後刪標記——重跑即自癒。
- **查詢版本**：`fetchMetro.mjs` 內的 `QUERY_VERSION` 在判準/查詢條件變動時遞增；
  `_cache/fetch_meta.json` 記錄版本，不符時自動作廢 tags/stations/masters/stop_areas 快取（幾何不作廢，見下）。
- **幾何增量抓取**：幾何批次檔以內容定址（`geom_v{版本}_{hash}.json`），每次只抓
  「所有 geom 檔中還沒有的 relation id」——判準擴充（如加 light_rail）只補抓新增的部分，
  舊快取照用。

## Overpass 查詢（固定）

營運中過濾條件（下稱 `LIFE`）：
`["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]`

- 路線標籤：`relation["route"~"^(subway|light_rail)$"]LIFE;out tags;`
- 線路分組主檔：`relation["route_master"~"^(subway|light_rail)$"];out body;`（失敗記 `.partial` 後降級，非致命）
- 車站（拆成兩個較輕的查詢，避免超載鏡像逾時；`ST` = `["railway"!~"^(proposed|construction|disused|abandoned|razed)$"]`；
  **只收 subway/light_rail 口味的車站，不收裸的 `railway=station`**——那會混入城際鐵路）：
  - 節點：`(node["station"~"^(subway|light_rail)$"]ST LIFE;node["railway"="station"]["subway"="yes"]LIFE;node["railway"="station"]["light_rail"="yes"]LIFE;node["railway"="stop"]["subway"="yes"]["name"]LIFE;node["railway"="stop"]["light_rail"="yes"]["name"]LIFE;);out;`
    （**具名 stop_position 也是站源**——新通車線常先畫 stop 才補 station 節點，
    如三鶯線 2026-06 通車時 12 個具名 stop 只有 10 個 station 節點；
    與 station 節點的重複由共站合併吸收）
  - 面（車站範圍）：station/railway=station 系列以 `way` 查，`out center tags;`（失敗記 `.partial`）
- 路線成員＋站點座標（**不抓 way 軌道幾何**）：
  `relation(id:...)->.r;.r out body;node(r.r);out skel qt;`，每批 **120** 個 relation。
  （舊 `out geom` 快取仍可讀：build 端相容成員節點內嵌座標與獨立 skel 節點兩種格式。）
- 共站分組（stop_area，失敗記 `.partial` 後降級為同名判準）：
  `(node["station"~"^(subway|light_rail)$"];node["railway"="station"]["subway"="yes"];node["railway"="station"]["light_rail"="yes"];)->.s;relation["public_transport"="stop_area"](bn.s);out body;`

## 線路分組規則（把來回方向合併成單一線路）

依序：
1. 有 `route_master` → 用 master 群組（`route_id = rm{masterId}`）。
2. 否則同 `network`(:en) + `ref` 視為同線（`route_id = r{minRelId}`）。
3. 都沒有 → 每個 relation 自成一線。
4. 分組後再做**快/慢車合併**（見前文「快/慢車合併」規則）：同 network＋ref（或同基底
   名稱）的多個 master/群組併成一條線，`route_id` 取存續群組者。

幾何為每個 relation 的**站序折線**（見上），同組去重規則：以 ~100 m 座標格為鍵
（來回方向常用不同的 stop_position 節點，不能用節點 id 去重），保留最長的變體，
其餘變體只要帶來 **≥1 個未見過的站**就保留（短支線如小碧潭/新北投只多 1–2 站；
純反向/短交路/**只跳站的快車** fresh=0 **一律捨棄**——快車不抓〔使用者裁決 2026-07，全球，
見「快/慢車合併」〕；重疊路段化會吸收共用段，保留支線零成本），
合併成 `MultiLineString`。**這些保留的分支/快車變體預設各自獨立成 route_id**（小碧潭
支線 hover 不連主線）；**但紐約/雪梨/香港例外**——同 ref 變體共享車站者併成一條線
（`mergeVariants`，見前文「同 ref 變體＝同一條線」與 [[metro-city-newyork]]）。
代表性 tags：優先取「有 colour 且有 name」的變體，master 的 name/ref/colour 覆蓋之。

## 欄位 schema（必要欄位不可刪）

> **路線名＝官方線名（使用者規則 2026-07，全球適用、包括台北）**：`route_name` 必須是
> 該線**官方名稱**（營運單位路網圖／官網為準），不是 OSM 上游的任意命名——OSM 常見雜訊：
> 冠系統名前綴（「台北捷運中和新蘆線」→ 中和新蘆線）、工程名（「南港-板橋-土城線」→
> 板南線）、變體/分支/方向註記（「(蘆洲)」「（大坪林」截斷）、甚至端點站名當線名
> （松山新店線曾叫「台電大樓」）。修正一律走 `_overrides/route_tag_patches.json`
> 設 `name`/`name:zh`/`name:zh-Hant`（master 錯就 patch master id），每筆附官方依據；
> 全球逐城由 [[metro-audit]] 迴圈對照 wiki 收斂。台北全套裁決見 [[metro-city-taipei]]。
>
> **顯示名語言（`nameFor`，站名＋線名，使用者指定各地用當地語言）**：預設英文優先
> （name:en→name）；**例外**：日本→日文（name:ja）、台灣→繁中（name:zh-Hant→name:zh→name）、
> **中國含香港→`name:zh`**（香港 name:zh＝繁中「炮台山」〔避開 name 的雙語「炮台山 Fortress Hill」〕，
> 中國大陸 name:zh＝简体，同鍵各地自動給正確繁/簡）。改此規則同步更新 [[metro-city-tokyo]]
> （日文）與此處。副作用：同名合併改以中文名判定，較英文羅馬字精確（撞名站正確分開）。
>
> **路線名去方向尾綴（`cleanRouteName`，全球通用）**：路線是**雙向**（去回程已併成一條），
> OSM name 常帶方向/終點站尾綴，會誤導成「兩個方向兩條線」（機捷 name:zh「(西向)/(東向)」
> 其實是普通車 vs 直達車）。故 `route_name`／`route_name_local` 一律去掉：「: A → B」「→ B」
> 「to B」「(西向)/(東向)/(上行)/(下行)/(順向)/(逆向)/(上)/(下)/(内/外)/(往X)/(inbound)…」；
> 括號內「分支名＋方向詞」（如「(蘆洲逆向)」）只去方向詞留分支名 →「(蘆洲)」。實測全 223 城
> **0 方向殘留**。**環線的內/外環兩向亦併**。

**路段 feature（MultiLineString；重疊只畫一條）**：
`routes`（list，每項 `route_id`, `route_name`（依上「顯示名語言」＋去方向）, `route_name_local`,
`route_name_en`（英文線名，標題/hover 第二行）,
`route_ref`, `route_color`（正規化 `#rrggbb`）, `network`, `network_local`, `operator`,
`wikidata`, `wikipedia`, `osm_route_ids`, `order_suspect`,
`stations`（**該 route 的完整行經序**（使用者規則：pass 站就地照真實順序插入）——stop＋pass
依**幾何真實順序**交錯、各分段原序串接、不去重；列表相鄰＝圖上直連；支線的接續站在支線段
開頭重複出現、**環狀線最後回到第一個車站**。每項 `{ station_id, station_name, code?, pass? }`：
**`pass:true`＝行經但不停靠**（快車跳站；與車站 `routes` 的 pass 項互為對照），stop 項無 pass 鍵；
`code`＝**該線官方站碼**（機捷 A1、東京 T22…，pass 站也帶——三重 A2），**站序依碼正規化方向
（官方碼升序、A1 在前）**，只反轉整條序列不破壞相鄰性；ref 缺或碼不齊維持成員順序。
**站數統計/圖論一律取非 pass 的唯一站**——消費端（skeleton 建圖、wikiLineCheck 站數）自行
`filter(!pass)`；唯 audit 的 `route_stations_match_geometry`（列表 vs 幾何頂點）用完整行經序
（幾何本就含 pass 頂點）。舊獨立欄位 `pass_stations` 已移除（pass 內嵌 stations））；
頂層 `seg_id`, `route_count`, `route_refs`, `route_colors`, `city`, `country`。（**無頂層單數
`route_color`**——路段可多線、沒有「一個顏色」；單線渲染取 `route_colors[0]`，每線自己的色在
`routes[].route_color`。使用者裁決 2026-07 移除冗餘欄位。）

> **全城一致鍵集（使用者：物件顯示不可因城市而異、不要客製）**：每站輸出**完全相同的欄位集**
> （21 鍵；缺值一律 null/false，不因欄位有無讓表格列數不同），全 223 城實測鍵集變體＝1。
> **hover＝物件顯示（使用者規則）**：地圖 hover popup（站/線）與物件 tab 完全同構——標題
> （中文/在地＋英文）、共站站名、停靠/行經路線、線的**段站序**（官方碼＋pass 灰字）、
> 以及**相同的屬性表**（同鍵過濾/排序/wikipedia 連結；routes/lines 等結構性鍵不進表）。
> hover HTML 一律來自**共用模組 `src/stores/popupHtml.js`**（stationPopupHtml/linePopupHtml/H）
> ——LayerTab（地圖）與 D3Tab（骨架/格網視圖，含黃色路線交叉點）同一份。**hover 只含結構
> 區塊**（標題中/英、共站站名、停靠/行經路線、線的段站序＋官方碼＋pass）；**屬性表只在
> 物件 tab、不進 hover**（使用者 2026-07）。

**車站 feature（Point）**：
`station_id`（`n{osmId}`）, `station_name`（依「顯示名語言」＝中文/日文/英文）, `station_name_local`,
`station_name_en`（英文名 name:en——**標題/hover 第二行**（使用者規則：第一行中文/在地、第二行英文，
相同則不顯示）；無則 null）,
`network`, `network_local`, `operator`, `city`, `country`,
`routes`（**此站的路線清單，單一陣列**（使用者規則：與路段 feature 同形式、不拆平行 array、
不輸出 OSM 內部 id）——每項 `{ ref, name, pass? }`：`ref`＝官方線路代碼（可重複，機捷普通/
直達都「A」；無 ref 用線名）、`name`＝線名（區分同 ref 服務）、**`pass:true`＝行經但不停靠**
（快車跳站——機捷直達車、NYC 快車/Z、Seoul 급행、Tokyo 快速、香港 AEL…；無 pass 鍵＝停靠）。
順序＝停靠在前、pass 在後。pass 來源＝pass-through 偵測（交錯停站/獨立 ref 快線沿慢車
走廊畫、跳過的站標 pass；「只跳站的快車」已在 dedupe 一律丟棄、不產生 pass——見「快/慢車合併」）。站↔線**歸屬**在 build
內部以 route_id（唯一鍵）建立——由各線 `__stations` 反推（∪ 既有 tag 指派以保浮空站），ref 撞名
（機捷雙 A）才不會漏掛/錯掛——route_id 不寫進車站欄位。前端車站物件直接讀 `routes` 顯示，
色以線名（其次 ref）對線列表查表，不再幾何猜測）,
`lines`（**停靠**此站的官方 ref 陣列（＝routes 無 pass 項的 ref）——留給 **no_line 不變式**
（至少一條，空值 verify 標 `no_line`）與地圖 hover 顯示），
`station_role`（`interchange`／`terminus`／`normal`，交會優先於端點。**interchange ⇔
網絡圖 degree>2（分歧/交會，相鄰站不同）或 ≥2 條不同線在此終止（terminus-interchange，
如 Monterrey Zaragoza：L2/L3 都在此止、degree=2 卻是真轉乘）或**端點站且停靠 ≥2 條線**
（全域鐵律：藍色端點站不可能有超過 1 條路線；若有＝可轉乘＝紅點——涵蓋「A 線在此為終點、
B 線經過並停靠、共用進站方向使 degree=2」的漏判；停靠線數以 pass 排除後的 `lines` 計）**
**或 端點站被 pass 路線穿過（degree≥2）**（使用者裁決 2026-07-16 **東涌案**：TCL 終點、
AEL pass 續往機場——幾何上線穿過此站再分岔，degree=2 但「不是端點」，絕不可能藍點＝
分歧紅點；全球 223 城此 pattern 僅東涌一例）——四者都是「≥2 路段相交」的紅點；
**共軌重疊段中間站**兩線給相同前後鄰、無線在此終止 → degree=2＋termCount=0，
不算 interchange。**快車 pass 頂點計入 degree**（使用者裁決 2026-07：顯徑要紅點）：
pass 鏈沿共軌走廊時給的前後鄰與慢車相同 → degree 不變、共軌中間 pass 站仍是黑點
（紐約 express 沿 local 走廊的站不變紅——早期「pass 不計 degree」裁決的本意保留）；
但 pass 線在**分岔點**離開走廊時貢獻新鄰居（HK 東鐵綫在顯徑轉往九龍塘、AEL 在欣澳
轉往機場）→ degree>2 ＝ 真實分歧紅點；**分岔恰在終點站**（degree 只有 2）由上述
東涌條款補洞。pass 站照舊不進停靠（stations／lines／terminus）。
`terminus`＝某線端點（環線無端點）；`station_degree` 存網絡圖度數）,
`is_interchange`, `is_terminus`, `merged_from`（若由共站合併而來，
＝被併成員數）, `merged_names`（**異名轉乘站合併後保留所有成員站名的 list**——
每項 `{ station_id, station_name, station_name_local, lines }`，`lines` 是**該站名所屬的路線
list**（同名多成員的 lines 取聯集），代表點排第一、依 `normName` 去重；只有 1 個相異名時為
`null`。合併只留代表點一個 `station_name`＋全線聯集 `lines`，此欄留住被丟掉的別名及其對應路線
——如 Novosibirsk Krasnyi Prospekt(1) 併掉的 Sibirskaya(2)、Pyongyang Chonu(1) 併掉的
Chonsung(2)，讓地圖能標「哪個名字屬哪條線」）,
`wikidata`, `wikipedia`（OSM 車站有 `wikipedia` 標籤時帶入，如 `en:...`；無則 `null`）,
`codes`（——補充機制：**`_overrides/station_codes.json`**（by 節點 id）補上游 OSM 節點缺 ref、
官方確有碼者（東京 N13 本駒込/N19 赤羽岩淵/S11 森下/E27 新宿），攝入時併入 `__codes`；
**跨城複製的 clone 必須帶 `__codes`**（赤羽岩淵主 bucket 在埼玉側、東京拿 clone——曾因此失碼）；
路線挑碼「字首完全相同優先、startsWith 後備」（丸ノ内線方南町支線 Mb03-05 ↔ ref M）。）
（**官方站碼清單**，如台北車站 `[A1, BL12, R10]`——各線各自的碼；來源＝各線 station
節點的 `ref`〔路線引用的 stop_position 節點無碼，碼在 station 節點上〕，共站合併時聚成此清單。
路線的 `route.stations` 每站再依該線 ref 字首挑出**該線的 code**〔A1↔ref A、T22↔ref T〕並據以
排序方向。`ref` 為 GTFS/非官方純數字碼〔NYC 302N、HK 430〕者不挑、不影響站序。全球 99/223 城
有碼。無則不設此欄）。

**系統中繼資料（`metro-maps/*.geojson` 的 `metro_system` 外部成員）**：
`continent`, `country`, `city`, `osm_networks`（合併進此城市的 network 字串清單）, `operator`,
`official_website`, `official_map`（系統 Wikipedia 連結）, `wikidata`,
`line_count`（**route 數**）, `segment_count`（路段 feature 數）, `station_count`,
`audit`（[[metro-audit]] 的逐城市驗證結果：`passed`/`checks`/`reasons`/`warnings`/`audited_at`，
未跑 audit 時為 `null`；前端 Info 面板直接顯示）。

> `route_color` 正規化：具名色（red/blue…）查表轉 hex；`#rgb` 展開為 `#rrggbb`；未知則原樣保留。

## 檔名與目錄結構（務必遵守）

```
data/metro/
├── metro_lines.geojson            # 全球所有路段（重疊已去重）
├── metro_stations.geojson         # 全球所有車站
├── index.json                     # 系統清單（含 file 路徑）+ 覆蓋率報告
├── systems/
│   └── {洲全名}/{國全名}/{洲2碼}-{IOC3碼}-{城}.geojson
│       例：systems/asia/taiwan/as-twn-taipei.geojson
│           systems/americas/united-states/am-usa-new-york-city.geojson
├── tracks/
│   └── {洲全名}/{國全名}/{洲2碼}-{IOC3碼}-{城}.geojson  # 實際 OSM 軌道 way（可選地圖底層）
└── maps/
    ├── {洲全名}/{國全名}/{洲2碼}-{IOC3碼}-{城}.{png|svg}  # 官方路網圖（與 systems/ 同名）
    └── maps_index.json                                    # 每張圖的出處與授權
```

- **資料夾用全名**：洲 `africa`/`asia`/`europe`/`americas`/`oceania`（**北美＋南美合併為
  `americas`**，使用者指定）；國家用 slug 全名（`taiwan`、`united-states`…）。
- **不會有 unknown**（使用者指定）：定位不到城市的線/站（機場擺渡、遊樂園軌道等雜訊）
  在 build 末端一律剔除——不寫檔、不進 index、不進全球層。
- **檔名用代碼**：{洲2碼} = `af`/`as`/`eu`/`am`（美洲合併）/`oc`；
  {IOC3碼} = 國家的**奧運（IOC）三字母代碼**小寫：台灣 `twn`（使用者指定用 ISO 3166 的
  TWN，不用 IOC 的 TPE）、德國 `ger`、荷蘭 `ned`、南韓 `kor`、英國 `gbr`…
  對照表在 `scripts/countryCodes.mjs`（未列入的國家退回 slug 並應補表）。
  洲別判定仍由國碼 → `scripts/continents.mjs` 對照。
- 洲、國：以系統中心點座標反向地理編碼為準（**只來自座標，不用名稱猜**，名稱比對不得跨國搬移系統）。
- 城市名決定規則（`geoFor`）——反查用 **zoom=12＋zoom=10 兩層**、存下**所有行政層級的候選**
  （city/town/municipality/district/county/state…，`geocode.json` 的 `city_candidates`），
  因為單一 city 欄位常落在轄區或鄰市（Yinzhou District、Burnaby）。geocode 鍵優先用路線
  **自己的 operator/network**（master 補值前），避免仁川的線被 master 的
  「Seoul Metropolitan Subway」拉進首爾。依序：
  1. 任一候選**就是**該國 Wikipedia 清單中的城市 → 直接採用（如 Taipei、Beijing）。
  2. 任一候選與該國 wiki 城市以**詞邊界**互相包含 → 採用該 wiki 城市名，多個命中取名字最長者
     （Stockholm Municipality → Stockholm；詞邊界使 Xiancun 不會誤配 Xi'an、
     最長優先使 New Taipei 不會被吃成 Taipei）。
  3. 都沒有 → 在**同一國**的 Wikipedia 系統中用 network 名稱做 token 比對，取最佳者的城市名
     （→ Shanghai、London）。同國限制可避免「Taipei Metro」被誤配到「New Taipei」。
- **座標最終裁決**（`wiki_city_coords.json`：Wikipedia 各城市正向 geocode 一次、快取）：
  1. 逐線檢查：解析出的城市離線路重心 >20 km、且同國另有 wiki 城市近 2 倍以上 → 改判給後者
     （Pune 的線被 Nagpur 共用的 MahaMetro 拉走、仁川 vs 首爾，都以線的座標為準）。
  2. 桶級補救（rebucket）：城市仍非 wiki 正名的系統，先試桶內任一成員 network 能否解析
     （車站標籤常有路線缺的英文名，如 Ningbo Rail Transit）；再以桶重心找 30 km 內同國
     （或 15 km 內不限國，如 Macau）最近的 wiki 城市改名/併桶——語言無關，
     济南（Lixia District）→ Jinan 靠這步。
- **一城一檔**：所有解析到同一 `{洲}-{國}-{城}` 的 network 會合併進同一個檔，
  `metro_system.osm_networks` 列出被合併的來源 network 字串。
- **additive／split 變體系統（`*-jr`／`*-lm`／`*-lrt`）**：由**獨立的後處理腳本**在 base
  build 之後產出，**buildGeojson 不產生它們、也絕不刪**——stale-cleanup 與 index 保留正則
  `-(jr|lm|lrt)` 一律豁免、metro:build 每次重跑對應 builder 刷新。
  - `*-jr`（`buildJrCombined.mjs`）：東京／大阪 base ＋ 附加一條 JR 環線。
  - `*-lm`（`buildLandmarkCombined.mjs`）：城市 base ＋ 地標（河流／公園）。
  - `*-lrt`（`buildSingaporeVariants.mjs`／`npm run metro:sgvariants`）：新加坡專屬——把
    buildGeojson 產出的「MRT＋LRT」完整 `as-sgp-singapore` 拆成**純 MRT（覆寫 base）**與
    **MRT＋LRT＋Sentosa Express（`as-sgp-singapore-lrt`）**兩系統；Sentosa 的 VivoCity 站
    併入 HarbourFront（怡豐城↔港灣）成共站轉乘。逐城裁決見 [[metro-cities]]。

## 車站的城市指派（空間，非依標籤）

OSM 車站常無 `network` 標籤或與路線不同，故車站**不依標籤分城市**，而是指派給**幾何上最近的路線**
所屬的城市（`buildGeojson.mjs` 用 0.02° 網格索引路線頂點，車站往外找最近格）。這樣沒有 network 的站
也能歸到正確城市，避免全部倒進單一 unknown 檔。路線本身仍依其 network 的 `geoFor` 分城市。

## 共站（可轉乘＝同一車站；**不是「同名就共站」**）

OSM 換乘站常是「一線一個站點」；本資料把**可轉乘（同一車站實體）**的站點合併為
**單一點**（座標取平均、`lines` 取聯集、記 `merged_from: n`；異名成員的站名以
`merged_names` list 全數保留，見車站 schema）。合併判準依序：

1. **OSM `public_transport=stop_area`（權威）**：同一 stop_area relation 內的車站節點
   ＝同一站體 → 合併（涵蓋異名/多線共構的情況）。stop_area 由 fetch 第 5 步抓取
   （只抓包含本資料車站節點者）。
2. **同名 ≤800 m（輔助）**：同城市、`station_name` 正規化後相同且相近 → 合併
   （同名近距在實務上即為同站/轉乘）。距離護欄避免誤併真正的兩個同名站；
   無真實名稱（合成名 `n123`）不參與此判準。
3. **`_overrides/interchanges.json`（人工/agent 裁決）**：模糊案例——鄰近異名轉乘站
   （無 stop_area 資料）、同名遠距疑似同站——由 [[metro-audit]] 流程比對該線
   **Wikipedia 條目**與 **urbanrail.net**（仍不確定再查其他網路來源）後裁決，寫入
   `{ "merge": [["n123","n456"], …] }`；build 無條件採用。

合併以 union-find 實作（三判準取聯集）；發生在 rebucket 之後、路段化之前；
全球層 `metro_stations.geojson` 也用合併後的點。

## 個別 relation 缺標籤補丁（`_overrides/route_tag_patches.json`）

少數 route relation 本身缺 `colour`／`ref` 標籤（不是抓錯，是 OSM 上游真的沒標）——
既非 route_master 成員也無 ref 可分組 → 自成一條沒有顏色的獨立線，退回預設色，
視覺上像是「顏色抓錯」。格式：`{ "patches": [{ "relation": <osm_id>,
"set": { "colour": "#rrggbb", "ref": "..." }, "note": "..." }] }`，套用在 tags 讀入
後、分組判斷前——**通常只需補 `ref`**，讓既有「同 network+ref 分組」機制自然把它
併成該線的分支、顏色隨代表變體繼承（`colour` 一併直填是保險，不靠分組也對）。
案例：巴拿馬城「Ramal línea 2 : Corredor Sur → Aeropuerto」（relation `15624911`，
機場支線，與 Line 2 共站 Corredor Sur）OSM 完全沒標 colour/ref，退回預設紅色、
與 Line 1 撞色；查證 Wikipedia／mapa-metro.com 確認官方為 Line 2 的綠色支線後，
補 `ref: "L2"` 使其併入 Line 2 分組。上游補齊標籤後應移除對應條目。
**relation id 可以是 route 或 route_master**：`route_master` 的 `colour`／`ref`／`name`
**覆蓋**變體 tags（代表 tags 取自 master），故若錯的是 master 上的標籤，補丁必須指向
**master id**、不是 route 變體 id——route 端補了也會被 master 蓋回。build 端在 route 快取
讀入後套一次（route id）、在 masters 讀入後再套一次（master id）。案例：Bursaray B2 的
route_master `7869622` 標 `colour=black`（佔位，實際單色系統兩支線都紅），補丁指向 master
設 `colour: "red"`（→ `#e6194b`）。

## 缺口補抓與城市綁定覆寫（gap supplements + `_overrides/`）

[[metro-audit]] 的逐城市修補會產生兩類輸入，build 端自動吸收：
- **補充快取**：`_cache/gap_routes_*.json`、`gap_geom_*.json`、`gap_stations_*.json`——
  與主快取同格式，依元素 id 去重合併。
- **城市綁定覆寫**：`data/metro/_overrides/*.json`，格式
  `{ city, country, continent, osm_route_ids: [..], source?, note? }`。列出的 relation **無條件**
  分到指定城市（略過名稱解析與座標裁決），且該桶不參與 rebucket。機器（auditLoop）與人工
  補寫用同一格式；人工裁決過的疑難城市就固定在這裡，重跑不會漂走。

## 官方路網圖下載（metro map，`scripts/downloadMaps.mjs`）

下載各系統的**官方路網示意圖**（schematic diagram，圖片檔，非地理線形），存到 `data/metro/maps/`。
GeoJSON 無法內嵌圖片，故獨立成圖檔並用 `maps_index.json` 記錄授權。

- **系統 QID 解析**：主要用 `_cache/routes_tags.json` 的 OSM `network:wikidata`（系統級 QID），
  以 `netKey = network:en||network||operator` 對應 `index.json` 的 `osm_networks`；後備用名稱做
  Wikidata `wbsearchentities`。
- **取圖**：查 QID 的 Wikidata `P15`（route map）→ Commons 檔名；無 P15 則抓 **enwiki 條目 infobox** 的
  `map`/`system_map`/`route_map` 參數；再無則沿 `P361`（part of）往上層系統找（≤2 層）。
- **下載**：Commons `imageinfo` 取直接 URL 與授權，存到 `maps/{洲}/{國}/{洲}-{國}-{城}.{png|svg}`
  （與 `metro-maps/` 同名不同副檔名）。續跑跳過已抓者；限速、必帶 User-Agent。
- **無圖**：Wikidata/Wikipedia 沒有路網圖者記 `map_file: null`，**不硬湊**。部分系統（London Tube、
  NYC Subway）官方圖有版權、未自由授權，本來就抓不到。

`maps_index.json` 每筆（key=`洲/國/城`）：`city, country, wikidata, map_file, commons_file,
source_url, license, license_url, artist`。

## 穩健性規則（重抓必守）

- Overpass 用**多端點輪替**（overpass-api.de / kumi.systems / maps.mail.ru / private.coffee）
  + 重試退避 + 逾時；見 `scripts/overpass.mjs`。
- 幾何批次若整批失敗 → **二分遞迴**縮小，隔離出問題 relation。
- 車站的面查詢失敗可略過（節點已涵蓋絕大多數站）。
- **Nominatim 限速 1 req/s**、必帶 User-Agent、`accept-language=en`、結果快取於 `_cache/geocode.json`。
- 所有網路回應快取於 `_cache/`；不要把 `_cache/` 當成交付物（可刪，重抓會重建）。

## 授權與標註

- 幾何/屬性：© OpenStreetMap contributors，ODbL。
- 系統清單/城市：Wikipedia，CC BY-SA。
- 反向地理編碼：Nominatim / OpenStreetMap。
- 官方路網圖：各 Commons 圖檔自帶授權（多為 CC BY-SA / Public domain），見 `maps_index.json` 的
  `license`/`artist`；**再散布/放進論文時須依該授權署名**。
交付或發佈時需保留上述標註。

## 修改此管線時

任何規則變動（判準、欄位、命名、分組）**都要同步更新此 SKILL.md、[[metro-audit]] 與
`data/metro/README.md`**，確保「取得的依據」「驗證的依據」與實作三者一致。
