---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022）——⑨格網→貼形。規定路段成「四條直線邊」正方；用 RBF／徑向整網變形避免只釘 W 撕網。當使用者要求修改 Shape-Guided、問為何交叉／不成方時使用。
---

# Shape-Guided (route-shape-align)

論文：`data/thesis/9_Shape-Guided Mixed Metro Map Layout.pdf`；實作說明：`data/thesis/9_shape-guided_演算法說明.md`。

**入口**：僅 ⑨ `layout-shape`（初步直線化之上）。**無**循環後貼形。

**硬目標**：
1. **照指定形狀**：規定路段＝四條 H/V 邊正方（禁斜切角）。**一定要算出來**——不成方不允許靜默退回輸入。
2. **拓撲優先**（與爬山硬規則一致）：
   - 不當交叉數 ≤ 輸入
   - 點周圍連線的 360° **邊環繞序**不可變（度≥3；遠端鄰居，略過綠控）
   - 無同格撞站  
   先求鐵律版（`topoSafeTowardTargets`／RBF→validMove…）。失敗則 **§6F 強制成方**：`forceFourSideSquare` 釘 W；非 W 只 `topoSafeNonW`（禁止 RBF 硬吸整網）；剩餘交叉用 **綠色控制點**（方外轉折，`shape-g*`）消掉後交付。
3. 綠控寫進骨架 path（`applyShapeGreens`），`placeBlacks` 當切點轉折；統計含 `greenCount`／`greens`。

**§6**：A0–E 鐵律路徑 → F 強制成方（validMove＋方外綠控）。禁整網 RBF 硬吸附。

`HC_LS_KEY` v32+。

**手動執行**：tab 不自動算；按「執行」才跑。

**規定表**：東京 JR 山手、新加坡 Circle、東京大江戶環段。
