---
name: highway-cities
description: 高速公路資料的國家/都會區專屬規則總索引與跨國通則——各國封閉式道路的判準例外、路標配色、命名慣例。當抓取或修正某國高速公路資料、不確定某國有無專屬規則、或要調整某國道路分層配色時，先查此索引。通用機制以 [[highway-osm-fetch]]（取得）與 [[highway-audit]]（驗證）為準。
---

# 高速公路國家/都會區專屬規則索引 (highway-cities)

此 skill 是 [[metro-cities]] 的高速公路對應版：收**各國封閉式道路的專屬裁決**與**跨國通則**。
通用機制（判準、單位、schema、上色）以 [[highway-osm-fetch]] 為準，正確性驗證以 [[highway-audit]]
為準；本檔只記「某國為什麼、怎麼特別處理」。大城市/大國若累積夠多特例，再獨立成 `highway-city-*`
（比照 metro 的 `metro-city-taipei` 等）。

## 跨國通則

- **封閉式判準**：`highway=motorway` ＋ `highway=trunk`＋(`expressway=yes`|`motorroad=yes`)。
  各國把「封閉式快速公路」標法不一——多數用 `expressway=yes`（台灣快速公路、日本、韓國），
  少數只有 `motorroad=yes`。兩者皆收。發現某國封閉式道路沒進來，先查它的 trunk 是否缺這兩個標。
- **道路分層配色**（`SIGN_COLORS`，`buildHighwayGeojson.mjs`）：`route_color` 依 `road_class`
  （motorway/expressway）＋國家路標配色，**同層同色**。未列國家用 default（motorway 藍 #12489b、
  expressway 綠 #1f8a4c）。新增國家配色改 `SIGN_COLORS` 並記此處。
- **交流道命名語言**（`nameFor`）：台/中/港/澳→中文、日→日文、其餘→英文（同 metro）。

## 逐國個案

- **台灣**：國道 `highway=motorway`（國道1–10號、3甲…）；快速公路 `highway=trunk`+`expressway=yes`
  （台61 西濱／62／64／65／66／68／72／74／76／78／82／84／86／88…）。交流道編號＝里程公里數
  → `mileage`。配色：國道藍 #12489b、快速公路綠 #1f8a4c。
  - **剔除「高速公路局」**（`_overrides/junction_excludes.json`）：OSM 把林口附近機關專用匝道
    （高公局／國道公路警察局）標成 `motorway_junction`，但**不是公開交流道**——wiki 中山高
    交流道列表無此站、無 exit ref。使用者 2026-07-16：台灣 highways 不會有「高速公路局」。
- **美國**：Interstate＝motorway（ref 如「I 95」）；部分 parkway/expressway 為 trunk+expressway。
  exit 編號＝milepost → `mileage`。都會區分檔（`am-usa-new-york-city`…）。Interstate 藍盾配色。
- **德國**：Autobahn＝motorway（藍）；Bundesstraße（B-roads）多為一般 trunk **不收**，除非標
  `expressway`/`motorroad`。
- **（其餘國家待補）**：抓到後若有判準/命名/配色特例，補列於此。

## 修改時

任何國家專屬規則變動要同步更新此檔；若牽動通用判準/上色，一併更新 [[highway-osm-fetch]]／
[[highway-audit]]。
