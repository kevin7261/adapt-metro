---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022 精神）——初步直線化⑨＋循環後貼形。規定路段成「四條直線邊」正方；含格網→貼形、Delaunay→貼形。當使用者要求修改 Shape-Guided、Delaunay 三角化貼形、問為何交叉／不成方時使用。
---

# Shape-Guided (route-shape-align)

論文：`data/thesis/9_Shape-Guided Mixed Metro Map Layout.pdf`；實作說明：`data/thesis/9_shape-guided_演算法說明.md`。

**入口**（⑨ 區，僅比較、手動執行）：

| mode | 說明 |
|---|---|
| `layout-shape` | 格網→貼形：§4/§5 LS 暖身＋§6 徑向成方 |
| `layout-shape-delaunay` | **Delaunay→貼形**：三角化 → 四邊 →（缺角才綠）→ **整網一次徑向變形** |
| `layout-shape-llm` | LLM 成方（可餵 ②HC） |

## 格網→貼形

1. **§4 選路**：`shapePresets` 規定 W  
2. **§5 變形**：平滑／混合 LS；`cross > cross0` → 退回上一輪  
3. **§6**：`runRadialSquareGrid`（徑向／RBF→釘四邊→修交叉）  
4. **必交**：`ensurePaperDelivery`

## Delaunay→貼形（`shapeDelaunay.js`）

**就這麼簡單——整網同一個變形一次套上：**

1. 三角化  
2. 先定正方四邊；**缺角才補綠**  
3. 算徑向目標（所有點同一套）→ `lerp(geo, dst, t)`  
4. 二分最大合法 `t`（翻三角＝0 ∧ 網邊交叉＝0）  
5. 整數吸附；破網則退回連續域／輸入  

不做逐點鬆弛、面積梯度、多輪爬山。

**手動執行**：按「執行」才跑。

`HC_LS_KEY` v57+。
