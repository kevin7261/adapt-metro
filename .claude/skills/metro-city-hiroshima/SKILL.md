---
name: metro-city-hiroshima
description: 廣島地鐵資料的城市專屬規則——廣島是全球唯一收路面電車（広島電鉄／廣電 route=tram）的城市，是對「只收 subway|light_rail、永不放寬到 tram」上位規則的城市層例外，機制比照德國五城 S-Bahn 的 train 例外。抓取、重抓、修正廣島資料，或問廣島為何有電車/其他城市能不能比照時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 廣島城市專屬規則

檔名 `systems/asia/japan/as-jpn-hiroshima.geojson`。日文站名/線名規則見 [[metro-city-tokyo]]
（日本全國一律顯示 `name:ja`）。

## 路面電車例外（使用者裁決 2026-07-21）

**廣島要收路面電車**——広島電鉄（廣電，約 8 條營運路線）併入廣島系統，與既有的
Astram Line（広島高速交通、1 線 22 站）並存。

這是對 [[metro-osm-fetch]] 上位規則「只允許 `route=subway|light_rail`，永不放寬到
plain railway/tram」的**城市層例外**，機制比照德國五城的 S-Bahn `train` 例外
（見 [[metro-city-germany]] 的 `SBAHN_DE_CITIES`／`isSbahnDe`）——即以城市白名單放寬
路線類型，而非改動全域判準。

### 範圍：只有廣島

- **其他日本路面電車城市一律不收**：長崎、熊本、鹿兒島、富山、札幌、函館、松山、
  高知、岡山、豐橋、福井、高岡、東京都電荒川線、大阪阪堺…全部維持不收 tram。
- **全球 tram 政策不變**。與既有「Karlsruhe/Stuttgart 的 Stadtbahn（tram-train）不算
  metro 要排除」（[[metro-city-germany]]）、羅馬 Roma-Lido／Delhi–Meerut RRTS 剔除等
  裁決**不衝突**——那些是「把非 metro 的東西排掉」，本例外是「使用者指定額外納入廣電」。
- 使用者當時是在「只有廣島特例／所有日本電車城市／全球都收電車」三選一中明確選
  **只有廣島特例**。

### 現況與待辦（截至 2026-07-21 尚未實作）

- 現有資料只有 Astram Line：`osm_networks: ["Unknown", "広島高速交通株式会社"]`，
  1 線 22 站，audit 全綠通過。
- **廣電資料從未進過快取**——`fetchMetro.mjs` 的 `MODES` 寫死
  `["route"~"^(subway|light_rail)$"]`，tram 從一開始就不在全球批抓範圍內
  （查過 `_cache`，`広島電鉄`／`Hiroden` 零筆）。故需**新開 `route=tram` 的定向抓取**，
  不能只改 build 端過濾。
- 實作時要注意的已知議題（實作後補齊本節）：
  - **宮島線**（広電宮島口方向）是鐵路規格的郊外線，與市內路面段營運上直通，
    站/停留場的性質不同，站點合併與 `station_role` 判定需個別確認。
  - 路面停留場多為 `railway=tram_stop`，非 `station=subway|light_rail`，
    站源判準需另開分支（見 [[metro-osm-fetch]] 的站源查詢）。
  - 廣電線號與營運系統（1/2/3/5/6/7/8/9 號線）與實體線路（本線/宇品線/江波線/
    皆実線/白島線/横川線/宮島線）非一對一，逐線 wiki 站數對照（`line_wiki_stations`）
    要以哪一層為準需裁決。

## 修改此例外時

放寬名單一旦擴及其他城市，等同推翻使用者 2026-07-21 的「只有廣島」裁決——
必須重新確認，並同步更新 [[metro-cities]] 索引與 [[metro-osm-fetch]] 的判準段落。
