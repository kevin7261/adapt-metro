---
name: metro-city-shanghai
description: 上海地鐵資料的城市專屬規則——14 號線龙居路預留站未開通需剔除、虹桥火车站等無名站補名。抓取、重抓、修正上海地鐵資料，或某線站數比 wiki 多一站/某站 wiki 證實未開通時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 上海城市專屬規則

檔名 `metro-maps/asia/china/as-chn-shanghai.geojson`。

## 未開通站剔除（`station_excludes.json`）

14 號線**龙居路**因徵地問題至今未開通（zh/en wiki 明載，14 號線營運僅 30 站），但 OSM
標營運 → 以「名稱＋座標半徑」剔除（見 [[metro-audit]]）。剔除機制對同名兄弟節點（雙向
stop_position）也一併排除，避免遞補。

## 無名站補名（`station_names.json`）

虹桥火车站（10 號線西端終點）、龙漕路（12 號線）等上游無名站，由 agent 查 wiki 站序命名
（豁免墓碑）。
