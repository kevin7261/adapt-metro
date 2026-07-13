---
name: metro-city-hongkong
description: 香港地鐵（港鐵 MTR）資料的城市專屬規則——觀塘綫/屯馬綫/東鐵綫的 route relation 曾含殭屍節點與漏列 stop 成員，需定向刷新。抓取、重抓、修正香港地鐵資料，或港鐵某線站數比實際多/少、出現無名或重複站時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 香港（港鐵 MTR）城市專屬規則

檔名 `systems/asia/china/as-chn-hong-kong.geojson`。

## 定向刷新（route 漏 stop 成員／殭屍節點）

觀塘綫（曾 20→修正 17 站）、屯馬綫（28→27）、東鐵綫的 route relation 曾含**殭屍節點**
（上游已刪／被拆掉名稱的 stop_position）並漏列部分成員。用 `refreshRelations.mjs` 定向
重抓該批 relation → `gap_*_refresh_hongkong` 快取（後載者勝，見 [[metro-audit]] Z3 與
`refetchFailedCities`）。殭屍節點由墓碑 `_cache/deleted_nodes.json` 拒收
（`pruneDeletedStations.mjs` 驗證：存在且**還有名字**才算活）。

## 同 ref 變體合併（快車/分支＝同一條線，使用者：「香港的快車也是同一路線」）

港鐵 network=`MTR` 已納入 `mergeVariants` 名單（與紐約、雪梨 Sydney Trains 共用機制，見
[[metro-city-newyork]]）：同 ref 的分支變體**共享車站者併成 1 條線**——東鐵綫 EAL 的
馬場／落馬洲支線（曾 3 個 route_id）、將軍澳綫 TKL 的康城支線（曾 2 個）各收斂成 1 條，
香港 route_id 13→10（＝實際港鐵重鐵線數）。代表 tags 取最長變體（站最多者），其餘變體
車站聯集。共享判定用站座標 ±2 格容差（同站不同月台）。

## 範圍

香港 MTR 全部重鐵線，含**機場快線 AEL**（是真地鐵、機場快線不排除，與航廈接駁電車不同，
見 [[metro-cities]] 機場通則）。輕鐵（新界西北 Light Rail）不在 Wikipedia metro 基準，
不併入。
