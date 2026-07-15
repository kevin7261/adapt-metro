---
name: highway-audit
description: 驗證 data/highway 資料的正確性與完整性——逐都會區 audit（交流道有道路、道路壓交流道、無假長線、只收封閉式道路、交流道命名率、里程單調）並把結果寫進 geojson 的 highway_system.audit。當使用者要求驗證高速公路資料、檢查正確性、跑 highway:verify、或問某都會區高速公路資料對不對時使用。與 [[highway-osm-fetch]] 互為 fetch⇄audit 迴圈（同 [[metro-audit]] 對 [[metro-osm-fetch]] 的關係）。
---

# 高速公路資料驗證規則 (highway-audit)

此 skill 是 `data/highway/` 資料**正確性驗證**的權威依據，是 [[metro-audit]] 的高速公路對應版。
與 [[highway-osm-fetch]]（取得）互為 **fetch⇄audit 迴圈**：本 skill 驗證發現的缺漏/異常回饋到
fetch，據以調整查詢或重抓，再驗證，直到收斂。改判準/欄位時**兩份 skill 一起更新**。

實作：`scripts/verifyHighways.mjs`（`npm run highway:verify [slug/國名]`）。逐系統跑檢查、把結果
寫進該 geojson 的 `highway_system.audit`（`passed`/`checks`/`audited_at`；前端 Info 面板可讀），
並印逐系統報告。

## 驗證項目（error 擋、warn 提示）

| id | level | 檢查 |
|---|---|---|
| `has_lines` / `has_interchanges` | error | 有道路、有交流道 |
| `interchanges_have_lines` | error | **每個交流道 ≥1 條所屬道路**（對應 metro `no_line` 不變式） |
| `lines_have_interchanges` | error | 每條道路 ≥2 交流道 |
| `vertices_on_interchanges` | error | **每個折點都是交流道點**（線壓交流道；斷口不算折點） |
| `no_fake_long_segment` | error | **無 >30km 的線段**——畫直線只連「路上真正相鄰」的交流道，跨越假長線＝排序錯（[[highway-osm-fetch]] 相鄰邊規則）。真實鄉間交流道間距 <30km |
| `single_line_per_ref` | error | **每條路是一條線**——同一 ref 內每個交流道 degree ≤2（單一路徑或環）。build 的「一個 ref＝一條有序序列」使分叉/辮子（主線 vs 高架平行鏈）結構上不可能，殘留＝bug（取代舊 `no_triangles`；跨 ref 的真實三角形——三條路兩兩相接——是合法拓撲不擋） |
| `closed_access_only` | error | 每條道路 `road_class` ∈ {motorway, expressway}——只收封閉式道路 |
| `interchanges_named` | warn | 交流道命名率 ≥60%（**不像 metro 要求 100%**，各國習慣不同） |
| `mileage_order` | warn | 各道路 `mileage`（里程）序大致單調——反向過多代表排序待查（沿國道1號里程 373→0 單調＝順序正確的佐證） |

## 與 metro-audit 的差異

- **不對照 Wikipedia 站數**：metro 逐線比對 wiki 營運中站數；highway 目前以**結構不變式**為主
  （交流道↔道路、無假長線、封閉式判準）。未來要加「對照各國官方交流道表/里程」再擴充本表與腳本。
- **允許空系統**：某都會區框內可能沒有封閉式道路 → 0 features 不寫檔（非 error）。
- **交流道命名非 100%**：warn 而非 error。

## 管線位置

```bash
npm run highway:fetch [國家]   # 取得（見 [[highway-osm-fetch]]）
npm run highway:build          # 組檔
npm run highway:verify [國家]  # 本 skill：驗證＋寫回 audit
npm run highway:all            # fetch + build + verify
```

## 城市/國家專屬裁決

逐都會區/國家的特例（某些國家 trunk 標法不一、某國道命名慣例…）記在 [[highway-cities]]，
比照 metro 的 [[metro-cities]]。修補動作一律走 [[highway-osm-fetch]] 的規則。

## 修改此驗證時

任何檢查項/門檻變動**都要同步更新此 SKILL.md 與 [[highway-osm-fetch]]**，維持「取得的依據」
與「驗證的依據」一致。
