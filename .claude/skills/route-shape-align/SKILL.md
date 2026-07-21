---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022）——⑨格網→貼形。規定路段成「四條直線邊」正方；用 RBF／徑向整網變形避免只釘 W 撕網。當使用者要求修改 Shape-Guided、問為何交叉／不成方時使用。
---

# Shape-Guided (route-shape-align)

論文：`data/thesis/9_Shape-Guided Mixed Metro Map Layout.pdf`；實作說明：`data/thesis/9_shape-guided_演算法說明.md`。

**入口**：僅 ⑨ `layout-shape`。

**硬目標（缺一不交付）**：
1. **成方**：規定路段＝四條 H/V 邊正方。
2. **拓撲鐵律**（論文 D1）：交叉 ≤ 輸入；360° 邊環繞序不變；無撞格。**破鐵律＝錯誤，禁止交付假方。**
3. **綠點**：論文「必要時插轉折」——只在規定路段 W、≤4、網格交叉點；鐵律靠移非 W。

**§6F**：成方∧鐵律才 return；**絕不提前停止／退回**——輪替邊長、方框平移、慢移、W 綠轉折、鐵律內晃動，直到成功（山手可能很久，log 會一直跳）。

**手動執行**：按「執行」才跑。

`HC_LS_KEY` v37+。
