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

## 機場快線／東涌線共線（快車跨站 pass-through，使用者：「機場快線和東涌是共線到欣澳才分出去」）

機場快線 AEL（快車）與東涌線 TCL（慢車）共用 Hong Kong→Kowloon→Olympic→Nam Cheong→
Lai King→Tsing Yi→**Sunny Bay 欣澳**的物理軌道，**到欣澳才分岔**（AEL→機場、TCL→東涌）。
AEL 跳過中間站（Olympic/Nam Cheong/Lai King/Sunny Bay）。因線幾何是「站對站」，AEL 的直達邊
與 TCL 逐站路徑不同站段 → 抓不到共線。用 `_overrides/express_passthrough.json` 讓 AEL 的
**幾何沿 TCL 的中間站畫**（pass-through 頂點），使 Hong Kong↔Sunny Bay 整段判為共線、畫
青+橘雙色；但這些站**不算 AEL 停靠**（AEL 維持 5 站、中間站 `lines` 不含 AEL）。
- Kowloon→Tsing Yi 段自動偵測即可（TCL 走完該段）；**欣澳段需手動 override**——因 TCL 在
  欣澳轉往東涌、沒有單一 route 走完 Tsing Yi→Sunny Bay→Airport，自動偵測抓不到。
詳見 [[metro-osm-fetch]]「快車跨站共線」（自動偵測＋手動 override 兩層）。

## 中環↔香港 官方共站（異名轉乘，使用者裁決 2026-07）

**中環 Central**（港島綫/荃灣綫，n248794172）與**香港 Hong Kong**（東涌綫/機場快綫，
n2557051035）是官方轉乘複合站——付費區行人通道相連（~350 m），MTR 官方圖標示同站轉乘。
兩站異名且無共同 stop_area → 同名 ≤800 m 判準抓不到，由 `_overrides/interchanges.json`
`merge` 裁決合併為單一車站點（`merged_names` 保留兩名與各自路線）。

## 東鐵綫經過顯徑但不停靠（pass-through，使用者裁決 2026-07）

**東鐵綫 EAL 九龍塘→大圍**段出筆架山隧道後沿**屯馬綫 TML 走廊**經過**顯徑 Hin Keng**，
但不停靠（顯徑僅屯馬綫停靠）。沒有任何 route 走完「九龍塘→顯徑→大圍」→ 自動偵測抓不到，
由 `_overrides/express_passthrough.json` 手動 override（route_osm 涵蓋 EAL 全部三個
route 群組：4248589/4248590/4250432），幾何沿顯徑畫、顯徑對 EAL 標 `pass_lines`——
顯徑不進 EAL 站數；但**顯徑是紅點**（使用者裁決 2026-07）：EAL 在此分岔離開 TML 走廊
（往九龍塘），pass 頂點計入 degree → degree=3 分歧紅點（通則見 [[metro-osm-fetch]]
station_role 節；欣澳同理變紅）。

## 尖沙咀↔尖東 官方共站（異名轉乘，使用者裁決 2026-07）

**尖沙咀 Tsim Sha Tsui**（荃灣綫，n262119931）與**尖東 East Tsim Sha Tsui**（屯馬綫，
n2546436295）是官方轉乘複合站——站內行人隧道相連，MTR 官方圖標示同站轉乘。異名無共同
stop_area → 由 `_overrides/interchanges.json` `merge` 裁決合併。

## 範圍

香港 MTR 全部重鐵線，含**機場快線 AEL**（是真地鐵、機場快線不排除，與航廈接駁電車不同，
見 [[metro-cities]] 機場通則）。輕鐵（新界西北 Light Rail）不在 Wikipedia metro 基準，
不併入。
