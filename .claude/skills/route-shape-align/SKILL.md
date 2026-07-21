---
name: route-shape-align
description: Shape-Guided（論文直線鏈 shape，Batik et al. 2022）——自動選最適合嵌形的路線＋內建形狀（只方形），描形站往形狀吸、其餘近八方向，短距離硬規則嚴格接受；不適合則略過（佈局不變）。當使用者要求修改 Shape-Guided 鏈、調選路/形狀庫/略過門檻、或問「⑨Shape-Guided」tab 的行為時使用。共用機構見 [[route-paper-align]]。
---

# Shape-Guided (route-shape-align)

[[route-paper-align]] 的論文鏈之一（kind `shape`）。論文：Batik, Terziadis,
Wang, Nöllenburg & Wu 2022 _Shape-Guided Mixed Metro Map Layout_
（`data/thesis/9_…pdf`＋`9_shape-guided_演算法說明.md`）。

## 演算法（整數格改編）

論文三步（路線比對 → LS 變形 → Octi 織入）收成短距離後處理：

1. **選路＋選形**：對每條非河流路線取格網切點序列（≥6），與內建形狀
   （**只方形**）做 bbox 等比對齊（不旋轉，D5）＋方向相似度；
   環線／緊湊 bbox 加權。最高分 < `SCORE_MIN`（0.42）→ **略過**。
2. **描形站**：選中路線切點，鏡射線段不穿其他邊者進 `S_shape`（論文圖 6）。
3. **變形**：連續座標跑 40 輪——描形站往形狀最近點吸（Ωc）＋非描形邊近八方向
   （Ωo，同 ⑤）＋原位錨定（Ωp）。
4. **收尾**：`snapAligned` → 描形站先、其餘後的**逐頂點批＋strict**。

## 與論文的差異

- 不做完整 Fréchet Dijkstra／匈牙利／Octi 格網織入（成本分鐘級，與短距離契約不合）。
- 形狀庫固定**只方形**（使用者裁決）；不支援任意使用者折線輸入。
- 略過＝回傳原佈局（`moved: 0`），下游循環仍跑、畫廊有格，tab 標「略過」。

## 實作契約

- `buildShapeAlign(skeleton, cells, cols, rows)`（`src/stores/paper/shape.js`）
  → `{ cellAfter, stats }`；stats 含 `skipped`／`shape`／`shapeZh`／`route`／`routeId`／`note`
  （`note`＝`路線→方` 或 `略過`，D3Tab msBadge 與 buildViews 日誌用）。
- 需要 `skeleton.routes`（`buildConnectSkeleton` 已匯出）。
- kind `shape`、tab 名「⑨Shape-Guided」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

形狀庫／門檻／權重變動同步本檔與 `paper/shape.js`。**bump VIEWS_VERSION**。
