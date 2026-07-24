---
name: metro-city-beijing
description: 北京地鐵資料的城市專屬規則——1 號線/4 號線貫通運營的站數計法、紅廟/福壽嶺/八角遊樂園等預留或封站剔除、富豐橋等無名站補名。抓取、重抓、修正北京地鐵資料，或某線站數比 wiki 多很多（貫通計法）、某站 wiki 證實未開通/封站時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 北京城市專屬規則

檔名 `metro-maps/asia/china/as-chn-beijing.geojson`。

## 逐線 wiki 站數裁決（`wiki_adjudications.json`，綁 city+wiki+ours）

- **1 號線**：與八通線 2021-08-29 貫通運營（蘋果園—環球度假區）共 35 站；infobox 23 只計
  1 號線本線。
- **4 號線**：與大興線貫通運營，4 號線 24 站＋大興線 11 站（新宫—天宫院）＝35；infobox
  只計 4 號線本線。

## 未開通／封站剔除（`station_excludes.json`）

紅廟（14 號線預留站未開通）、福壽嶺（1 號線從未開通的預留站）、八角遊樂園（2025-06 起
封站改造至 2027）——OSM 標營運但 wiki 證實非營運，以名稱＋座標半徑剔除。

## 無名站補名（`station_names.json`）

富豐橋、紅蓮南路（16 號線）、首經貿（10 號線，丰台站—紀家廟之間）等，agent 查 wiki 站序命名。
