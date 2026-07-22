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
| `layout-shape-delaunay` | **Delaunay→貼形**：站點三角化 → 釘 W 成方 → 三角網 Laplacian 變形（**三角形連通性不變**） |
| `layout-shape-llm` | LLM 成方（可餵 ②HC） |

## 格網→貼形

1. **§4 選路**：`shapePresets` 規定 W  
2. **§5 變形**：平滑／混合 LS；`cross > cross0` → 退回上一輪  
3. **§6**：`runRadialSquareGrid`（徑向／RBF→釘四邊→修交叉）  
4. **必交**：`ensurePaperDelivery`

## Delaunay→貼形（`shapeDelaunay.js`）

**本模式鐵律＝三角網拓撲不可變**（可擴充）：
- 既有三角：連通＋定向／相對位置不變（拒翻）
- **可加綠控點**：在 W 邊插入 → **分割三角（新加三角形）**，新三角以插入時定向鎖定
- 綠點目標＝正方四角；站點在邊上；成方允許經綠點 H/V 折角
- **不可為成方而翻既有／新三角**

1. `d3-delaunay` 三角化並鎖定  
2. 插最多 4 個角綠控（邊切／面切）  
3. **整網所有三角頂點**同步徑向拉方（非只動 W）；Laplacian 不錨回原位  
4. 整數吸附：全部點都吸；拒翻；灰線／綠點  

**手動執行**：按「執行」才跑。

`HC_LS_KEY` v54+。
