---
name: landmark-osm-fetch
description: 抓取/重抓城市地標（河流骨架線、皇居/中央公園面域）產出 data/metro/landmarks 下的獨立 GeoJSON——與 metro map 的路線/車站 geojson 完全分離的另一個圖層。當使用者要求下載、更新、重抓某城市的地標/河流/骨架/皇居/中央公園、新增地標城市、或修改 data/metro/landmarks 的資料時使用。此 skill 獨立於 [[metro-osm-fetch]]（不動 metro 管線與其產出檔）。
---

# 城市地標取得規則 (landmark-osm-fetch)

此 skill 是 `data/metro/metro-landmarks/` 的**唯一權威依據**。地標是給路網圖當背景參照的
圖層——**河流＝骨架線（LineString）、皇居/公園＝面域（Polygon）**。新增/重抓地標
**不得**修改 metro 管線（`fetchMetro.mjs`／`buildGeojson.mjs`…）與其產出檔。管線腳本：
`scripts/fetchLandmarks.mjs`（純 Node.js，共用 `scripts/overpass.mjs` 的
multi-endpoint/retry/cache 客戶端）。

> **消費形態＝「城市＋地標」合併檔（使用者 2026-07）**：前端**不再單獨載入**地標 overlay
> geojson。`scripts/buildLandmarkCombined.mjs`（`npm run metro:landmarkscombined`）把每個有地標
> 的城市 base metro features ＋ 地標合成**新的系統檔** `metro-maps/**/{slug}-lm.geojson`
> （city＝「城市 + Landmark」／中文「城市＋地標」，加進 `index.json`＋`cityNamesZh.json`），
> 概念同 [[metro-city-tokyo]] 的 東京＋山手（`buildJrCombined`）。**不動 base 城市 geojson**。
> **改完地標務必重跑 `metro:landmarkscombined`** 讓合併檔同步。
>
> **河流＝網路路線（使用者最終裁決 2026-07）**：合併檔裡的河流**不是地標 overlay，是真的
> route**——builder 把河流中心線**全點保留**（使用者 2026-07-17：「點不可以減少、要跟原來
> 一樣」；早期的絕對 DP 0.2km 站級簡化已移除——點的刪減只允許使用者裁決的裁切：clip／
> 市區裁切），每個折點都是車站 Point（`river: true`）＋路段 feature（schema 同地鐵、
> `route_id=river:…`、色 `#00E5FF`）；骨架/格網化/爬山把它當一般線、地圖畫成一條實線
> （站圈以 river flag 隱藏）。示意視圖的河形由**骨架的河流粉紅轉折**保持——全點後中間點
> 角度平緩，相對 DP 抓不到轉折（整段彎弧變一條長弦、與地鐵段假交叉，巴黎案 2026-07-17），
> skeleton.js 河流邊改用**絕對 0.2 km 容差**（dpKeepAbsKm）標粉紅。詳見
> [[route-skeleton-connect]]。**面域（皇居/公園）仍是 landmark overlay**（`landmark_id`
> 辨識、fill＋hover＋highlight）。`data/metro/metro-landmarks/**` 仍是**地標資料的產地**（本 skill
> 的 fetch 產出、buildLandmarkCombined 的輸入），只是不再被前端直接載入。

> **河流不抓面域**（使用者裁決 2026-07-16）：河流骨架直接來自 OSM 的
> `waterway=river` 中心線 data，不需要水面 polygon。曾實作過「bbox 內全量水面
> polygon＋中心線點在面內過濾」的面域模式，已整個移除（要考古看 git history）。
>
> **waterway 收 river＋canal**（使用者 2026-07）：查詢放寬到 `waterway~^(river|canal)$`，
> 以支援運河/引水渠（柏林 **Spreekanal**＝`waterway=canal`）。**靠 rivers 設定的 name 精確
> 比對限縮**，故放寬 waterway 不會誤收其他城市無關的運河——維也納 Donaukanal 因不在
> Vienna 的 match 名單，仍不會被抓（使用者只要多瑙河主流）。要收某運河就把它的名字加進
> 該城 `rivers` 的 `match`。

## 執行

```bash
npm run metro:landmarks                    # 全部已設定城市
node scripts/fetchLandmarks.mjs as-twn-taipei eu-fra-paris   # 指定城市
node scripts/fetchLandmarks.mjs as-jpn-tokyo --refresh       # 忽略快取重抓
```

## 目前城市與地標（2026-07）

| 城市 | 地標 | kind | 內容 |
|---|---|---|---|
| as-twn-taipei | 河流骨架 | river-centerline | 淡水河/**基隆河（→汐止）**/**新店溪（→新店）**/**大漢溪（→鶯歌）**，4 條主線 |
| eu-gbr-london | 河流骨架 | river-centerline | 泰晤士河 1 條 **43.0 km（市區裁切）** |
| eu-ger-berlin | 河流骨架 | river-centerline | 施普雷河 Spree（含區段別名，見下）＋ **Spreekanal**（Kupfergraben，`waterway=canal`，使用者 2026-07） |
| eu-aut-vienna | 河流骨架 | river-centerline | **只留**多瑙河主流 Donau 1 條 **12.1 km（市區裁切）**（不含 Neue Donau/Donaukanal，使用者 2026-07-16） |
| eu-fra-paris | 河流骨架 | river-centerline | 塞納河 La Seine **40.2 km（市區裁切）**＋西堤島南汊 **La Seine - Bras de la Monnaie 1.4 km**（兩汊包圍 Île de la Cité，使用者 2026-07-17；側汊必須是**獨立名單項**——併進主流 match 會被 diameter 丟掉，獨立項各成一條、合併檔匯流共站接回主流） |
| as-kor-seoul | 河流骨架 | river-centerline | 한강 1 條 **54.1 km（市區裁切）** |
| as-chn-shanghai | 河流骨架 | river-centerline | 黄浦江 1 條 **44.4 km（市區裁切）** |
| as-jpn-tokyo | 皇居 | palace | 「皇居」＋「皇居東御苑」兩面域（見陷阱③） |
| am-usa-new-york-city | 中央公園 | park | Central Park（leisure=park，取最大面積者） |

> **河流裁切（`clip`＋`keep`，使用者 2026-07）**：`rivers` 名單項可寫
> `{ name, match, clip:[lon,lat], keep:[lon,lat] }`——在離 `clip` 最近的折點截斷、**保留離
> `keep` 點（市中心）較近那一段**；未給 `keep` 退回「含最低經度端」（大漢溪河口在高經度側、
> 上游往鶯歌是低經度，必須用 keep 判側）。台北三條（keep＝台北車站）：基隆河→汐止、
> 新店溪→新店、大漢溪→鶯歌。裁切在 `centerlineFeatures` build 端做（讀快取、改設定重跑即生效）。
>
> **市區裁切（`URBAN_TRIM_KM`=3，使用者 2026-07：「河流都是在市區範圍、不是整條」）**：
> 通用規則——每條河只保留「離任一地鐵站 ≤3 km」的**最長連續段**（`trimToUrban`，車站取自
> 該城 systems geojson 的 Point features）。**有顯式 `clip` 的河不套用**（範圍已由使用者裁定，
> 如台北三條；鶯歌/汐止離地鐵站 >3km，套了會裁掉使用者要的段）。實測：泰晤士 120.6→43.0、
> 한강 98.2→54.1、黄浦江 84.6→44.4、Spree 76→47.1、Seine 67.4→40.2、Donau 27.9→12.1 km。

## 判準（authoritative scope）

兩種抓法，設定都在 `fetchLandmarks.mjs` 的 `CITIES`：

1. **`rivers: [names]` 河流骨架**：抓 OSM 人工維護的河道中心線——
   `waterway=river` 且 `name` 精確在名單內的 way，輸出
   `kind: "river-centerline"` 的 LineString（屬性含 `length_km`）。
   - **骨架演算法**：同名 way 直接縫端點會被**辮狀水道**（河中島側汊同名，
     泰晤士河實測碎成 42 段）切碎，所以把所有 way 建成**無向圖**（節點＝座標點、
     邊權重＝距離），每個連通分量取**最長路徑**（雙次 Dijkstra 求 graph diameter）
     當主線，側汊不進骨架。
   - **查詢 bbox**＝該城 metro 路網 bbox（＋5% margin）再每邊多放 0.03°（~3 km）：
     河道彎出網絡 bbox 再彎回來時主線才不斷（泰晤士河南界實測斷成 3 截）。
   - 長度 < `MIN_CENTERLINE_KM`（1 km）的孤立碎段剔除（塞納河實測有 0.1–0.4 km 殘段）。
   - **區段別名**：名單項可寫 `{ name, match: [...] }`——同一條河在 OSM 的市內
     區段名聚成同一骨架圖（柏林 Spree 的市段叫 Treptower Spree／Müggelspree）。
   - **縫隙橋接**（`GAP_BRIDGE_KM` = 4）：穿湖段在 OSM 是 `waterway=flowline` 或
     無名 way（柏林 Müggelsee 實測），名稱比對抓不到、主線會斷——碎段剔除**之後**
     把端點距離 ≤ 4 km 的同河段落以直線跨接串成一條（先剔再接，小側汊才不會被接進主線）。
   - 支流不進名單就不會出現（River Lea/馬恩河/蘇州河/磺溪…天然排除）；同城要多條
     水道就開多個名單項、各成一條骨架（維也納曾三條，後裁決只留 Donau 主流——
     Neue Donau/Donaukanal 不畫）。
2. **`named: [...]` 命名面域**（皇居/公園）：在路網 bbox 內以**精確 `name`** 查
   way/relation 面域，可加 tag 過濾（如 Central Park 加 `leisure=park`）；
   `pickLargest: true` 表示同名多個時只留面積最大者。

## 輸出

`data/metro/metro-landmarks/<洲>/<國>/<city-id>.geojson`——**鏡射 `metro-maps/` 的相對路徑**
（如 `landmarks/asia/taiwan/as-twn-taipei.geojson` 對 `metro-maps/asia/taiwan/…`），
方便以相同相對路徑對照載入。Schema：

```jsonc
{
  "type": "FeatureCollection",
  "landmark_system": {           // 對應 metro geojson 的 metro_system
    "continent": "asia", "country": "Taiwan", "city": "Taipei",
    "city_id": "as-twn-taipei",
    "kinds": ["river-centerline"], // 本檔含的地標種類
    "bbox": [S, W, N, E],        // 路網 bbox＋margin（骨架查詢再各加 0.03°）
    "source": "OpenStreetMap via Overpass API (…)",
    "generated_at": "YYYY-MM-DD",
    "landmark_count": 4
  },
  "features": [{
    "type": "Feature",           // 河流骨架（線）
    "properties": {
      "landmark_id": "cl-淡水河-0", "kind": "river-centerline",
      "name": "淡水河", "name_en": null,
      "osm_type": "way", "osm_ids": [],   // 該河全部中心線 way id
      "length_km": 21.91
    },
    "geometry": { "type": "LineString", "coordinates": [] }  // 座標 5 位小數
  }, {
    "type": "Feature",           // 命名面域（皇居/公園）
    "properties": {
      "landmark_id": "w534754971", "kind": "palace",  // palace | park
      "name": "皇居", "name_en": "Imperial Palace",
      "osm_type": "way", "osm_id": 534754971,
      "area_km2": 0.7769
    },
    "geometry": { "type": "Polygon|MultiPolygon", "coordinates": [] }
  }]
}
```

面域 multipolygon 的組裝：relation 成員 way 依端點縫成閉環（`stitchRings`）、
inner 環以點在多邊形內測試指派給包含它的 outer；面積為球面近似（緯度校正 shoelace）。
relation 成員 way 不再重複輸出為獨立 feature。

**顯示規則**（LayerTab 的地標 overlay）：骨架是「線」——LineString 走專用線圖層
（`lm-centerline`，實線），面域 fill/outline 圖層都要加 `geometry-type = Polygon`
filter，**不得把骨架混進 fill**。圖層 id 用 `lm-` 前綴避免撞向量底圖自帶圖層名。

## 快取

Overpass 回應快取在 `data/metro/_cache/landmarks_<city-id>_*.json`。
`--refresh` 會先刪對應快取再抓；**改了查詢或 CITIES 設定後必須 `--refresh`**，
否則吃到舊快取（同 [[metro-osm-fetch]] 的快取陷阱）。

## 陷阱（都踩過）

1. **Overpass `out` 模式**：一定要 `out geom;`。曾寫成 `out geom tags;`——`tags` 是
   「只輸出 tags」的 verbosity，會讓 **relation 完全沒有 members**，所有 multipolygon
   都組不出來（way 反而正常，更難察覺）。
2. **快取檔名的 CJK**：名稱消毒要用 `/[^\p{L}\p{N}]+/gu`（保留中日文字）。曾用 `\W+`
   把「皇居」「皇居東御苑」都洗成 `_`，兩個查詢共用同一份快取、第二個地標抓到第一個的結果。
3. **皇居要兩片**：OSM 的「皇居」（way 534754971，0.78 km²）只含護城河內西半部；
   同在護城河內的「皇居東御苑」（relation 5415394，0.33 km²）要一併抓，合計 1.11 km²
   才符合維基的皇居面積（約 1.15 km²）。
4. **骨架不能只縫端點**：辮狀水道與 bbox 邊界都會把主線切碎——一律走「無向圖＋
   分量 diameter＋外擴 0.03° bbox」，驗證看「每河一條、長度量級對得上」。

## 新增城市或地標

改 `fetchLandmarks.mjs` 的 `CITIES`（加 `rivers` 或 `named` 項），跑該城市，然後：
骨架確認「每河一條主線、長度對得上常識」；面域確認幾何有效（環閉合）、面積對照維基。
城市 id 必須已存在於 `data/metro/metro-maps/`（bbox 取自該檔）。
改判準（tag 組合、margin、門檻）必須先更新本文件。
