---
name: landmark-osm-fetch
description: 抓取/重抓城市地標面域（河流面域、皇居、中央公園等 polygon）產出 data/metro/landmarks 下的獨立 GeoJSON——與 metro map 的路線/車站 geojson 完全分離的另一個圖層。當使用者要求下載、更新、重抓某城市的地標/河流面域/皇居/中央公園、新增地標城市、或修改 data/metro/landmarks 的資料時使用。此 skill 獨立於 [[metro-osm-fetch]]（不動 metro 管線與其產出檔）。
---

# 城市地標面域取得規則 (landmark-osm-fetch)

此 skill 是 `data/metro/landmarks/` 的**唯一權威依據**。地標是給路網圖當背景參照的
**面域（polygon）圖層**，與 `data/metro/systems/` 的 metro geojson **完全分離**：
新增/重抓地標**不得**修改 metro 管線（`fetchMetro.mjs`／`buildGeojson.mjs`…）與其產出檔。
管線腳本：`scripts/fetchLandmarks.mjs`（純 Node.js，共用 `scripts/overpass.mjs` 的
multi-endpoint/retry/cache 客戶端）。

## 執行

```bash
npm run metro:landmarks                    # 全部已設定城市
node scripts/fetchLandmarks.mjs as-twn-taipei eu-fra-paris   # 指定城市
node scripts/fetchLandmarks.mjs as-jpn-tokyo --refresh       # 忽略快取重抓
```

## 目前城市與地標（2026-07）

| 城市 | 地標 | kind | 內容 |
|---|---|---|---|
| as-twn-taipei | 河流面域 | river | **只留**淡水河/基隆河/新店溪/大漢溪（`rivers` 名單，使用者 2026-07-16） |
| eu-gbr-london | 河流面域 | river | **只留**泰晤士河（`rivers` 名單，使用者 2026-07-16） |
| eu-fra-paris | 河流面域 | river | **只留**塞納河 La Seine（`rivers` 名單） |
| as-kor-seoul | 河流面域 | river | **只留**한강（含流經的팔당호水庫段，骨架穿過故保留） |
| as-chn-shanghai | 河流面域 | river | **只留**黄浦江（`rivers` 名單） |
| as-jpn-tokyo | 皇居 | palace | 「皇居」＋「皇居東御苑」兩面域（見陷阱③） |
| am-usa-new-york-city | 中央公園 | park | Central Park（leisure=park，取最大面積者） |

## 判準（authoritative scope）

兩種抓法，設定都在 `fetchLandmarks.mjs` 的 `CITIES`：

1. **`kinds: ['river']` 河流面域**：抓**該城 metro 路網 bbox（全座標範圍＋每邊 5% margin）**
   內全部 `natural=water` + `water=river` 與 `waterway=riverbank` 的 way/relation 面域。
   是「這座城市的河流面域」而非單一命名河——主河道在 OSM 常是**無名的 multipolygon
   分段**（泰晤士河/淡水河的最大片都沒有 name），**絕不能只用名稱過濾**。
   面積 < `MIN_RIVER_KM2`（0.01 km²）的細碎片剔除。不含 `water=canal`（運河非河流）。
   - **`rivers: [names]` 名單過濾**（台北只留四主河、倫敦只留泰晤士河）：因主河道
     面域無名，過濾靠兩層——面域 `name` 在名單內直接留；否則抓名單河流的**中心線**
     （`waterway=river` 同名 way）、面域**包含任一中心線節點**（點在面內，含 bbox
     預篩與內環排除）者視為主河道保留。支流小溪（磺溪/景美溪…）兩層都不中而剔除。
   - **河流骨架（`rivers` 城市自動輸出）**：中心線同批資料另以
     `kind: "river-centerline"` 的 LineString 與面域同檔輸出（每河的骨架主線，屬性含
     `length_km`）。同名 way 直接縫端點會被**辮狀水道**（河中島側汊同名，泰晤士河實測
     碎成 42 段）切碎，所以建**無向圖取每個連通分量的最長路徑**（雙次 Dijkstra 求
     diameter）當主線、側汊不進骨架；中心線查詢 bbox 每邊多放 0.03°，河道彎出網絡
     bbox 再彎回來時主線才不斷（泰晤士河南界實測）；長度 < `MIN_CENTERLINE_KM`
     （1 km）的孤立碎段剔除（塞納河實測有 0.1–0.4 km 殘段）。台北＝4 條（每河一條）、
     倫敦/巴黎/首爾/上海＝各 1 條主線。**顯示規則**：骨架是「線」——網頁端
     LineString 走專用線圖層（`lm-centerline`），面域 fill/outline 圖層都要加
     `geometry-type = Polygon` filter，不得把骨架混進 fill。
2. **`named: [...]` 命名地標**：在路網 bbox 內以**精確 `name`** 查 way/relation 面域，
   可加 tag 過濾（如 Central Park 加 `leisure=park`）；`pickLargest: true` 表示同名多個
   時只留面積最大者。

## 輸出

`data/metro/landmarks/<洲>/<國>/<city-id>.geojson`——**鏡射 `systems/` 的相對路徑**
（如 `landmarks/asia/taiwan/as-twn-taipei.geojson` 對 `systems/asia/taiwan/…`），
方便以相同相對路徑對照載入。Schema：

```jsonc
{
  "type": "FeatureCollection",
  "landmark_system": {           // 對應 metro geojson 的 metro_system
    "continent": "asia", "country": "Taiwan", "city": "Taipei",
    "city_id": "as-twn-taipei",
    "kinds": ["river"],          // 本檔含的地標種類
    "bbox": [S, W, N, E],        // 查詢用 bbox（路網範圍＋margin）
    "source": "OpenStreetMap via Overpass API (…)",
    "generated_at": "YYYY-MM-DD",
    "landmark_count": 58
  },
  "features": [{
    "type": "Feature",
    "properties": {
      "landmark_id": "r4010571",   // w/r + OSM id
      "kind": "river",             // river | palace | park
      "name": "基隆河", "name_en": null,   // 主河道常為 null，正常
      "osm_type": "relation", "osm_id": 4010571,
      "area_km2": 18.5175
    },
    "geometry": { "type": "Polygon|MultiPolygon", "coordinates": [] }  // 座標 5 位小數
  }, {
    "type": "Feature",             // rivers 城市附帶的河流骨架（面域之後）
    "properties": {
      "landmark_id": "cl-淡水河-0", "kind": "river-centerline",
      "name": "淡水河", "osm_type": "way", "osm_ids": [], "length_km": 21.91
    },
    "geometry": { "type": "LineString", "coordinates": [] }
  }]                               // 面域依 area_km2 由大到小排序，骨架附於其後
}
```

Multipolygon 的組裝：relation 成員 way 依端點縫成閉環（`stitchRings`）、inner 環以
點在多邊形內測試指派給包含它的 outer；面積為球面近似（緯度校正 shoelace）。
relation 成員 way 不再重複輸出為獨立 feature。

## 快取

Overpass 回應快取在 `data/metro/_cache/landmarks_<city-id>_<kind>[_<name>].json`。
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
4. **主河道無名**：河流面域靠 tag＋bbox 抓全量，不靠名稱——名稱只是輸出屬性。
   驗證時看「最大 piece 的 bbox 是否沿主河道」而非「有沒有叫某名字的 feature」。

## 新增城市或地標

改 `fetchLandmarks.mjs` 的 `CITIES`（加 `kinds` 或 `named` 項），跑該城市，然後：
確認幾何有效（環閉合、無 bad ring）、面積量級對得上常識（維基查該地標面積）、
主河道 piece 位置正確。城市 id 必須已存在於 `data/metro/systems/`（bbox 取自該檔）。
改判準（tag 組合、margin、最小面積）必須先更新本文件。
