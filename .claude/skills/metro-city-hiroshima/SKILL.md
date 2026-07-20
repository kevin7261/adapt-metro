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

### 實作（2026-07-21 完成）

三個著力點，全部沿用德國 S-Bahn 的既有機制，**沒有動全球判準**：

1. **`scripts/fetchHiroden.mjs`（新檔，`npm run metro:fetchhiroden`）**——`route=tram`
   的定向補抓。廣島市 bbox `(34.25,132.25,34.47,132.53)`（含宮島線西端），再以
   `operator|network|name` 比對 `広島電鉄|廣島電鉄|Hiroden|Hiroshima Electric Railway`
   過濾，寫 `gap_routes_hiroden.json` / `gap_geom_hiroden.json` /
   `gap_stations_hiroden.json`（後載者勝）。`fetchMetro.mjs` 的 `MODES` 一字未改。
2. **站源**：路面停留場多標 `railway=tram_stop`，基準站源查詢撈不到——改由 relation
   成員中的**有名節點**直接當站源寫進 `gap_stations_*`（與 fetchSbahnDe 同法）。
3. **`buildGeojson.mjs` 兩處**：
   - `lrtOnly` 判準從 `route === 'light_rail'` 放寬為 `^(light_rail|tram)$`——tram 必須
     歸在 LRT 這側，否則路面電車會被當成 subway 汙染 `hasSubway` 與 LRT 仲裁。
     全球基準查詢不收 tram，故此條對其他城市天然無作用。
   - `NETWORK_CITY` 加 `広島電鉄` pin → Hiroshima（不靠 geocode 重心：廣電含宮島線
     一路西南，重心會把 Astram 拖出廣島桶）。
   - `LRT_ADDON_CITIES` 加 `hiroshima`。**這步必要**：Astram Line 在 OSM 是
     `route=subway`（不是 light_rail），已獨力達成 wiki 覆蓋率，LRT 仲裁不會放行
     廣電——與波士頓綠線／LA 輕軌／瓜達拉哈拉同待遇。

### 現況（實作後）

- `as-jpn-hiroshima.geojson`：**10 線 98 站 20 段**，
  `osm_networks: ["Unknown", "広島電鉄", "広島電鉄株式会社", "広島高速交通株式会社"]`。
  ＝ Astram Line 1 線 22 站 ＋ 廣電 1/2/3/5/6/7/8/9 號線＋循環線（內回り）共 9 條。
- 抓取結果：18 個 tram relation（每線雙向變體）、164 個有名節點。
- **`metro:verify` 會把廣島列為 `high`（98 vs wiki 22，ratio 4.45）——這是預期的**：
  wiki 的 Hiroshima 條目只算 Astram Line，收廣電是使用者裁決造成的刻意分歧。
  同類已存在：波士頓 2.31、LA 5.79、瓜達拉哈拉 1.93、柏林 1.77。**不要為了讓
  ratio 回到 1 而把廣電剔掉**。全域不變式（`stations_without_line`／`broken_routes`
  等）維持 0，未受影響。
- 只有廣島一個系統檔變動，其餘 234 城 byte-for-byte 不變（已確認）。

### 尚未處理（下次碰廣島時再看）

- **宮島線**（広電宮島口方向）是鐵路規格郊外線，與市內路面段直通營運；目前跟市內
  停留場一視同仁，站點合併與 `station_role` 尚未個別確認。
- 廣電的**營運線號**（1/2/3/5/6/7/8/9）與**實體線路**（本線/宇品線/江波線/皆実線/
  白島線/横川線/宮島線）非一對一。目前資料以營運線號為線單位；`line_wiki_stations`
  逐線對照要以哪一層為準**尚未裁決**，故未做逐線站數比對。

## 修改此例外時

放寬名單一旦擴及其他城市，等同推翻使用者 2026-07-21 的「只有廣島」裁決——
必須重新確認，並同步更新 [[metro-cities]] 索引與 [[metro-osm-fetch]] 的判準段落。
