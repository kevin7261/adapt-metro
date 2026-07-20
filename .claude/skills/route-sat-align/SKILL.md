---
name: route-sat-align
description: SAT規劃（論文直線鏈 sat，Fuchs 2022）——與 MILP規劃完全同模型（每段 3 個八方向候選、一熱、同頂點同向硬子句、S1/S2 軟子句），求解器換成 DPLL 分支定界（most-constrained 優先、單元傳播 veto、目前最佳成本剪枝、節點上限 60000 超限元件退回原方向）。當使用者要求修改 SAT 鏈、調分支順序/預算、或問「SAT規劃」tab 的行為時使用。模型與座標重建與 [[route-milp-align]] 共用，見 [[route-paper-align]]。
---

# SAT規劃 (route-sat-align)

[[route-paper-align]] 的論文鏈之一（kind `sat`）。論文：Fuchs 2022
_SAT-based Optimization of Octolinear Metro Map Layouts_（`data/thesis/8_…pdf`＋
`8_sat_演算法說明.md`）。論文定位＝「Nöllenburg 同模型、換 SAT 求解技術」——
本鏈忠實對應：模型（`dirModel`）與座標重建（`coordsFromDirs`＋`snapAligned`）
與 [[route-milp-align]] **完全共用**，只換求解器。

## 演算法（整數格改編）

1. 模型同 ③：每段 3 候選方向（一熱）、同頂點兩段同向＝硬子句 veto、
   S1 彎折＋S2 相對位置＝軟子句（MaxSAT 語意）。
2. **DPLL 分支定界**：
   - 分支順序＝配對數多者優先（most-constrained heuristic）；
   - 走訪佈林指派樹，累積成本 ≥ 目前最佳即剪枝；
   - 同頂點 veto 在擴展時即時過濾（單元傳播的對應）；
   - 節點預算 60000 保證終止；超限元件**退回原方向**（論文大實例 timeout 的
     對應行為，stats 記 `fallback`）。
3. 座標重建與收尾同 MILP：`coordsFromDirs` 鬆弛 40 輪 → `snapAligned` →
   `finishPass`（夾 WINDOW＋硬規則）。

## 與 MILP 鏈的關係

同模型下兩鏈結果常相同；差異來自求解器在超限元件上的行為（MILP＝feedback 枚舉
上限、SAT＝節點預算）。這正是論文想展示的「求解技術互換性」。

## 實作契約

- `buildSatAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `comps`/`fallback`。
- kind `sat`、tab 名「SAT規劃」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

分支順序/預算變動同步本檔與 `paperAlign.js`；模型變動要同步
[[route-milp-align]]（共用 `dirModel`）。**bump VIEWS_VERSION**。
