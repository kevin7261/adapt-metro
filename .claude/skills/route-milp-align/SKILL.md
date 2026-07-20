---
name: route-milp-align
description: MILP規劃（論文直線鏈 milp，Nöllenburg & Wolff 2011）——每段 3 個八方向候選（最近扇區 ±1）、成本＝λ1·同路線相鄰段彎折＋λ2·偏離原方向、同頂點同向硬 veto；配對圖分元件用生成樹 DP＋feedback 段枚舉精確求解方向指派，再鬆弛重建座標＋snapAligned 量化。當使用者要求修改 MILP 鏈、調候選數/權重/枚舉上限、或問「③MILP規劃」tab 的行為時使用。共用機構見 [[route-paper-align]]（dirModel 與 SAT規劃共用）。
---

# MILP規劃 (route-milp-align)

[[route-paper-align]] 的論文鏈之一（kind `milp`）。論文：Nöllenburg & Wolff 2011
_Drawing and Labeling High-Quality Metro Maps by Mixed-Integer Programming_
（`data/thesis/3_…pdf`＋`3_milp_演算法說明.md`）。

## 演算法（整數格改編）

1. **方向指派模型 `dirModel`**（與 [[route-sat-align]] 完全同模型，只換求解器）：
   - 每段 3 候選方向＝目前幾何最近八方向扇區 ±1（論文的 sector constraint）。
   - 成本＝`λ1(=3)`·Σ 同路線相鄰段彎折 bd（S1 線彎，bd = 4 − 環狀差）＋
     `λ2(=2)`·Σ 非原方向候選（S2 相對位置）；S3（總長最小化）交給下游「縮減網格」——它就是全域壓縮這張圖的步驟。
   - 硬限制：同頂點兩段出向不得相同（H2 環繞序的可線性化部份）。
2. **精確求解**：段為節點、共享頂點的段對為邊 → 分連通元件 → 生成樹＋回邊 →
   feedback 段集合枚舉（3^|fb|，上限 2187 trials 或 2e6 節點·trials，超限元件
   fallback 保持原方向）＋樹 DP（同 hillClimb.js 中 buildAxisIlp 的求解機構——該鏈已下架、函式保留，變數換成段
   的八方向）。
3. **座標重建 `coordsFromDirs`**：逐段把兩端往「沿選定方向、長度＝目前投影長
   （下限＝H3 最短邊長 `hops`，即吞掉的白點數 + 1）」的理想相對位置拉，鬆弛 40 輪；`snapAligned` 對齊感知量化 →
   `finishPass` 夾 WINDOW＋硬規則。

## 與論文的差異

- H4 邊距/平面性不進模型——由 `applyTargets` 硬規則把關（等價於論文的 lazy
  constraint：違規的移動直接不套用）。
- deg-2 頂點已在骨架階段收縮（黑點），不需要論文的鏈收縮預處理。
- 全域 MILP 換成分元件精確 DP——變數域同樣完整枚舉，只是分解求解。

## 實作契約

- `buildMilpAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `comps`（元件數）/`fallback`（超限退回數）。
- kind `milp`、tab 名「③MILP規劃」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

候選數/權重/枚舉上限變動同步本檔與 `paperAlign.js`；`dirModel`/`coordsFromDirs`
是與 SAT規劃共用的（記在 [[route-paper-align]]）。**bump VIEWS_VERSION**。
