# 全球地鐵資料 (Metro data)

從 **OpenStreetMap**（透過 Overpass API，`route=subway`）抓取的全球地下鐵路線與車站，
以 **Wikipedia [List of metro systems](https://en.wikipedia.org/wiki/List_of_metro_systems)**
為覆蓋率基準，並可對照 [urbanrail.net](https://www.urbanrail.net/)。

> **抓取規則的權威依據**：`.claude/skills/metro-osm-fetch/SKILL.md`。
> 任何重抓/更新都遵循該 skill；改動判準、欄位、命名時需同步更新該 skill 與本檔。

## 產生方式

```bash
npm run metro:all      # 完整流程：Wikipedia 清單 + OSM 抓取 + 反向地理編碼 + 組成 GeoJSON

# 或分步（每步都有快取，可續跑）：
npm run metro:wiki     # 抓 Wikipedia 地鐵系統清單 -> _cache/wiki_metro_systems.json
npm run metro:fetch    # 抓 OSM 全球 subway 路線/車站原始資料 -> _cache/*.json
npm run metro:geocode  # 反向地理編碼每個系統中心點 -> _cache/geocode.json（洲/國/城）
npm run metro:build    # 組成最終 GeoJSON
```

腳本在 `scripts/`（純 Node.js，無外部套件）：`overpass.mjs`（多端點重試+快取的 Overpass client）、
`fetchWikiList.mjs`、`fetchMetro.mjs`、`geocodeSystems.mjs`（Nominatim 反向地理編碼，限速 1 req/s）、
`continents.mjs`（ISO 國碼→洲對照）、`buildGeojson.mjs`。

## 輸出檔案

| 檔案 | 內容 |
|---|---|
| `metro_lines.geojson` | 全球所有地鐵**線路**（MultiLineString） |
| `metro_stations.geojson` | 全球所有地鐵**車站**（Point） |
| `systems/{洲}/{國}/{洲}-{國}-{城}.geojson` | 每個城市/系統一個檔，依 `continent/country/` 分層存放，例如 `systems/asia/taiwan/asia-taiwan-taipei.geojson`；含該系統的線路+車站，並附系統中繼資料 |
| `index.json` | 所有系統清單、統計、以及 Wikipedia 有但 OSM 未比對到的系統（覆蓋率報告） |
| `_cache/` | Overpass/Wikipedia 原始回應（可刪，重跑會重抓） |

## 欄位 (properties)

**線路 (line feature):**
`route_id`, `route_name`, `route_name_local`（原文名）, `route_ref`（線路代號如 BL/R）,
`route_color`（正規化為 `#rrggbb`）, `network`, `network_local`, `operator`,
`city`, `country`, `wikidata`, `wikipedia`, `osm_route_ids`（來源 OSM relation ids）。

> 來回方向的路線變體會依 OSM `route_master`（或 `network`+`ref`）合併為單一線路，
> 幾何以 way id 去重，避免同一條線畫兩次。

**車站 (station feature):**
`station_id`, `station_name`, `station_name_local`, `network`, `network_local`,
`operator`, `city`, `country`, `lines`（此站所屬線路代號，best-effort）, `wikidata`。

**系統中繼資料（每個 `systems/*.geojson` 的 `metro_system` 欄位）:**
`continent`, `country`, `city`, `osm_networks`（合併進此城市的 OSM network 清單）, `operator`,
`official_website`, `official_map`, `wikidata`, `line_count`, `station_count`。

> `continent` / `country` / `city` 由各系統車站中心點經 Nominatim 反向地理編碼取得（座標為準），
> 檔名即由此三者組成。**一城一檔**：反查到同一城市的多個 OSM network 會合併進同一個檔。

## 關於「官方 metro map」

GeoJSON 是地理向量格式，**無法內嵌官方路線示意圖（schematic diagram，通常是圖片/PDF 且多為版權素材）**。
因此本資料的做法是：

1. **地理版的地圖**＝就是這些 `route=subway` 的真實線形與車站座標（可直接畫在地圖上）。
2. 每個系統的 `metro_system.official_map` 存**該系統 Wikipedia 條目連結**（該頁通常有官方示意圖與完整資訊），
   `official_website` 存營運單位官網（若 OSM 有 `website` 標籤），`wikidata` 供進一步查詢。

若日後需要「官方示意圖圖片本身」，需另外針對各系統下載（多數有版權，需個別確認授權）。

## 資料來源與授權

- 幾何與屬性：© OpenStreetMap contributors，[ODbL](https://opendatacommons.org/licenses/odbl/)。
- 系統清單/城市對照：Wikipedia（CC BY-SA）。
- 使用 `route=subway` 作為「地鐵」的判準，與 Wikipedia 的 metro 定義高度重疊但非 100% 一致；
  `index.json` 內 `wikipedia_cities_without_match` 會列出未自動比對到的系統供人工檢視。
