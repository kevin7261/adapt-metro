---
name: metro-city-tokyo
description: 東京（及大阪等日本城市）地鐵資料的城市專屬規則——東京只收 Tokyo Metro＋都營、不含私鐵（京急/京成/東急…）；日本所有站名與線名一律顯示日文（name:ja）而非英文/羅馬字。抓取、重抓、修正東京或大阪或任何日本城市地鐵資料，或東京混入私鐵、日本站名顯示成英文時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 東京（及日本城市）城市專屬規則

## 東京不含私鐵（`CITY_NETWORK_ALLOW`，使用者指定）

東京檔只收 **Tokyo Metro（東京メトロ）＋都營（東京都交通局）**，與 Wikipedia 基準一致。
判定 allow＋deny 雙向：私鐵直通車是聯合營運（operator 同時含都營與京急／京成等），
**沾到私鐵即剔除**——deny 清單 京急／京成／東急／東武／西武／小田急／京王／相鉄／
りんかい／ゆりかもめ…。「直通運転」覆蓋線由通用 through-service 排除處理，見
[[metro-osm-fetch]]。

## 日本站名／線名用日文（使用者指定）

`buildGeojson.mjs` 的 `nameFor(t, country)`：country=Japan 時顯示名用當地語言優先
（`name:ja` → `name` → `name:en`），其餘國家維持英文優先（`name:en` → `name`）。
OSM 日本 `name` 本就是日文（name=新宿、name:en=Shinjuku），故 name 優先即得日文。
套用於 `station_name`、`route_name`、內部 `lineTag`。`*_local` 欄位不變（仍存原始 name）。
要擴充到其他語言/國家，改 `LOCAL_NAME_COUNTRIES` regex。

## 大阪等其他日本城市

同 country=Japan → 站名/線名日文。大阪御堂筋線與北大阪急行南北線直通（站數計法差異）
的 wiki 裁決在 `wiki_adjudications.json`（見 [[metro-audit]]）。
