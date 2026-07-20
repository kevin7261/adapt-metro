---
name: metro-city-guadalajara
description: 瓜達拉哈拉（墨西哥）與科恰班巴（玻利維亞）的城市專屬規則——兩地系統都叫「Mi Tren」（network 同名），曾害科恰班巴 3 線 32 站被併進瓜達拉哈拉，以 _overrides/bolivia-cochabamba.json 釘死分桶。修正瓜達拉哈拉或科恰班巴資料、某城站數暴增、或懷疑跨城誤併時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 瓜達拉哈拉／科恰班巴城市專屬規則

- 瓜達拉哈拉 `systems/americas/mexico/am-mex-guadalajara.geojson`（SITEUR，4 線 54 站）
- 科恰班巴 `systems/americas/bolivia/am-bol-cochabamba.geojson`（3 線 32 站）

兩者是**同一個 bug 的兩面**，故合成一個 skill（比照 [[metro-city-germany]] 一檔收多城）。

## 同名 network 跨城碰撞（使用者裁決 2026-07-21）

### 症狀

`am-mex-guadalajara.geojson` 混入玻利維亞科恰班巴的 3 條線（Línea Verde/Roja/Amarilla），
共 7 線 86 站、其中 **32 個站點緯度為負**（實際位於南半球）。汙染並擴散到
`metro_lines.geojson`、`metro_stations.geojson` 與 `index.json`——該城 `official_map`
與 `wikidata` 甚至指向科恰班巴的 *Línea Verde* 條目（`repTags` 取代表性路線的 tags）。

### 病因（兩段接力，缺一不會出錯）

1. **geocode 端汙染**：兩地系統在 OSM 上**都標 `network=Mi Tren`**（玻利維亞
   `operator=Operadora del Tren Metropolitano de Cochabamba - Mi Tren`、墨西哥
   `operator=SITEUR`）。`scripts/geocodeSystems.mjs` 的 `netKey()` 為
   `pick(t,'network:en','network','operator')`——**`network` 排在 `operator` 之前**，
   於是兩城 192 個車站（墨 144＋玻 48）被平均成**單一重心**，墨西哥的多數決把重心
   拉到哈利斯科州，Nominatim 解析成 Guadalajara。科恰班巴的 operator 字串因
   `network` 存在而**從未被獨立 geocode**。
2. **250 km 護欄救不回來**：`buildGeojson.mjs` 的護欄**有正確觸發**（實距約 4600 km），
   但救援路徑兩條都是死路——① `nearestWiki` 找不到科恰班巴（**不在 Wikipedia
   *List of metro systems***，最近者是 1309 km 外的利馬，`near.km < 30` 不成立）；
   ② 退而求其次的 `raw = geocode[own] || geocode[network] || …` **正是產生錯誤答案的
   同一條查找鏈**，於是「偵測到錯誤後又改回錯誤答案」。
   第二道 rebucket 護欄則因 `isCanon(grp.info)` 為真（瓜達拉哈拉是已知 wiki 城市）
   被 `continue` 跳過。

### 裁決與落地

科恰班巴**獨立成系統**（非剔除）——它是實際營運中的 `route_master=light_rail`，
符合本專案收 LRT 的範圍。`_overrides/bolivia-cochabamba.json` 釘 6 個**成員 route id**
（9074378, 9083839, 11678428, 14576926, 14576927, 19604339；對應 3 個 route_master
14576928/14576929/19604340），`continent: south-america` → 產出
`americas/bolivia/am-bol-cochabamba`。override 走 `pinnedKeys`，**不經距離護欄**。

> 玻利維亞在此之前於資料集中完全沒有任何系統。該系統不在 wiki metro 清單，
> audit 會歸為 `extras`——屬預期，非錯誤。

## 通用風險警告（不限這兩城）

**同名 `network` 跨城碰撞是全域性風險**，且 [[metro-audit]] **沒有「同檔地理一致性」
不變式**——逐線 `line_wiki_stations` 檢查是拿每條線對照*它自己的* wiki 條目，而科恰班巴
那 3 條線各自都有合法的 wikidata/wiki 條目，所以**全部通過檢查**，汙染不會被自動抓出。

重跑資料時若某城站數/線數暴增，**先查是否有他城共用同一個 `network` 名稱**。

根因修正（`netKey()` 改 `operator` 優先或 `network|operator` 複合鍵）會觸發**全球重新
地理編碼與可能的大規模重新分桶**，風險高；較安全的替代是在 audit 增一條「同檔站點
不得相距 > N km」的不變式。**截至 2026-07-21 兩者皆未實作，使用者尚未裁決。**
