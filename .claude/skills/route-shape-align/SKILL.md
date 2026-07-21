---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022 精神）——初步直線化⑨＋循環後貼形。規定路段成「四條直線邊」正方；§4/§5 LS 暖身＋§6 徑向成方。當使用者要求修改 Shape-Guided、問為何交叉／不成方時使用。
---

# Shape-Guided (route-shape-align)

論文：`data/thesis/9_Shape-Guided Mixed Metro Map Layout.pdf`；實作說明：`data/thesis/9_shape-guided_演算法說明.md`。

**入口**：僅 ⑨ `layout-shape`。

## 管線（密網實用版）

1. **§4 選路**：`shapePresets` 規定 W
2. **§5 變形**：平滑／混合 LS；`cross > cross0` → 退回上一輪（暖身）
3. **§6 格網（主路徑）**：`runRadialSquareGrid`  
   徑向整網變形（失敗→RBF）→ 互不撞吸附 → **釘四邊方** → 疏散非 W → 積極修交叉  
4. **必交**：`ensurePaperDelivery`——不合規也釘方交付，**永不退回輸入**

**可選加強**：`opts.tryOcti === true` 時，徑向未合規再跑 `shapeOcti.js`（預設關，密網慢）。

## 交付目標

1. **成方**：W＝四條 H/V 直線邊正方  
2. **平面 D1**：不當交叉 ≤ 輸入、無撞格（不含環繞序）  
3. **綠僅 W**（徑向主路徑通常無綠；Octi 加強時才可能有）

**不做**：預設跑 Octi、用退回輸入假裝沒跑、非 W 灑綠。

**手動執行**：按「執行」才跑。

`HC_LS_KEY` v45+。
