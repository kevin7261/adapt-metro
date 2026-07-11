---
name: metro-city-chengdu
description: 成都地鐵資料的城市專屬規則——18/10/17/2 號線 wiki 站數裁決、天府機場預留站與 2 號線東段停運剔除、10 號線高升桥漏站中途插補。抓取、重抓、修正成都地鐵資料，或某線站數/站序與實際不符、某站未開通/停運時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 成都城市專屬規則

檔名 `systems/asia/china/as-chn-chengdu.geojson`。

## 逐線 wiki 站數裁決（`wiki_adjudications.json`）

17 號線（二期 2025-09 開通後營運 21 站，infobox 19 過期）、2 號線（東段停運後營運 27）、
10／18 號線——infobox 過期或計法不同、我方資料正確者。

## 未開通／停運剔除（`station_excludes.json`）

天府機場 3/4 航站樓（18 號線預留未開通）、2 號線東段停運 6 站（大面铺／连山坡／界牌／
书房／龙平路／龙泉驿，2025-12-20 起改線加站施工）——名稱＋座標半徑剔除。

## 漏站中途插補（`member_appends.json`）

10 號線**高升桥**（三期首通段太平园—武侯祠 2025-09-17 開通，OSM route relation 漏此
stop 成員）→ `inserts: [{after: 武侯祠, add: [高升桥]}]` 中途插入（正反兩向各一）。
