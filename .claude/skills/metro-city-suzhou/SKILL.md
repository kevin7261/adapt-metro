---
name: metro-city-suzhou
description: 蘇州地鐵資料的城市專屬規則——7 號線南段漏站前置補正、11 號線 3/11 貫通運營計法、白荡南暫緩站剔除、勞動路等無名站補名。抓取、重抓、修正蘇州地鐵資料，或 7/11 號線站數比實際少、某站未開通時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 蘇州城市專屬規則

檔名 `metro-maps/asia/china/as-chn-suzhou.geojson`。

## 漏站補正（`member_appends.json` ＋ `refreshRelations.mjs`）

- **7 號線**（2024-12-01 全線通車，木里—常楼 28 站）：OSM route relation 只涵蓋北段，
  南段 7 站（木里—蠡墅）以 `prepend_stops` 前置補上，中央公园／黄天荡／登云以 `inserts`
  中途插入。
- **11 號線**：3／11 號線貫通運營（横山—花桥，51＝3 號線段 24＋11 號線段 27）；wiki 條目
  27 只計 11 號線本體 → `wiki_adjudications.json` 裁決我方 51 正確。

## 未開通剔除 ＋ 無名站補名

白荡南暫緩開通剔除（`station_excludes.json`）；勞動路、獨墅湖鄰里中心（2 號線）無名站
由 `station_names.json` 補名。
