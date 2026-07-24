---
name: metro-city-germany
description: 德國五個 metro 城市（柏林/漢堡/慕尼黑/法蘭克福/紐倫堡）地鐵資料的城市專屬規則——U-Bahn＋S-Bahn 都要、Karlsruhe/Stuttgart 的 Stadtbahn（tram-train）不算 metro 要排除、rebucket 跳過 DB 全國公司名以免整桶被搬進紐倫堡。抓取、重抓、修正德國地鐵資料，或德國城市混入 Karlsruhe/Heilbronn/Wiesbaden 的線、紐倫堡跨度異常時，先查此檔。通用機制以 [[metro-osm-fetch]]/[[metro-audit]] 為準。
---

# 德國（Berlin／Hamburg／Munich／Frankfurt／Nuremberg）城市專屬規則

## U-Bahn＋S-Bahn 都要（使用者指定，只限五城）

OSM 標法混雜：
- **柏林／漢堡 S-Bahn 標 `route=light_rail`**（基準查詢抓得到，但會被 LRT 範圍規則剔除）→
  build 以 `isSbahnDe` 豁免（國家=Germany 且屬五城 `SBAHN_DE_CITIES` 且名稱含 S-Bahn、
  不含 Stadtbahn）。
- **慕尼黑／法蘭克福（Rhein-Main）／紐倫堡 S-Bahn 標 `route=train`**（不在基準查詢）→
  `scripts/fetchSbahnDe.mjs`（`npm run metro:fetchsbahn`）以五城 bbox 補抓
  （`ref~"^S[0-9]+$"` ＋ operator/name 含 S-Bahn），寫 `gap_*_sbahn_de` 快取。
- **城市綁定**：S-Bahn 的 `network` 是運輸聯盟名（VBB／MVV／RMV…）token 對不到城市，靠
  `NETWORK_CITY` 以 operator（S-Bahn Berlin／Hamburg／München／Rhein-Main／Nürnberg）
  直綁 pin。

## Stadtbahn 不是 metro（Karlsruhe／Stuttgart tram-train）

名稱含「Stadtbahn」、network 是 KVV／HNV／VRN、operator AVG 的線，是輕軌路面電車延伸，
**非本資料範圍**。`isSbahnDe` 不豁免它們（要求名稱含 S-Bahn 且不含 Stadtbahn），交
LRT 範圍規則剔除。Ratingen／Bielefeld／Essen／Bochum 等非 wiki metro 城市的野檔是德國
Stadtbahn／S-Bahn 的副產物；若出現，檢查是否該由 LRT 範圍規則剔除或併入鄰近 metro 城市。

## rebucket 跳過全國性鐵路公司名（`NATIONAL_INFRA`）

這些西南德國 Stadtbahn／S-Bahn 的 networks 常混入「DB Station&Service AG」「DB InfraGO」
等**全國性**公司名，geocode 會指到紐倫堡（Yorckstraße@8.38°E 的卡爾斯魯厄線曾整桶被搬進
紐倫堡 190 km 外，把紐倫堡撐成 31 線/248 km）。rebucket 時比照 `Unknown` 跳過這些
network 名（`NATIONAL_INFRA` regex：DB Station／DB InfraGO／InfraGO／DB Netz／
DB Fernverkehr／Deutsche Bahn／Indian Rail…）。修正後紐倫堡 11 線/107 km（U1–U3＋S1–S6，
107 km 是 S-Bahn 區域覆蓋的正常範圍，非錯誤）。這是通用 rebucket 護欄的一環，因德國最常
觸發而記於此。

## 柏林：Rathaus Spandau ↔ Spandau 共站（使用者裁決 2026-07-16）

U7 終點 **Rathaus Spandau**（n38902451）與 S-Bahn/區域車站 **Spandau**（n610780825，
S3/S9）是同一轉乘複合站（VBB 官方路網圖以連通轉乘顯示），但 OSM 異名且相距 ~180 m，
同名近距合併救不到 → 已加入 `_overrides/interchanges.json` 的 `merge`。合併後代表名
「Spandau」（線多者勝），Rathaus Spandau 保留在 `merged_names`。
旁邊的 **Altstadt Spandau**（U7 倒數第二站）是不同站，不得誤併。
