---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022）——初步直線化⑨（layout-shape，格網僅比較）＋循環後各鏈貼形。規定表決定是否計算；成方候選若會增加交叉或造成重疊則不交付。當使用者要求修改 Shape-Guided、問交叉/重疊、或問為何不成方時使用。
---

# Shape-Guided (route-shape-align)

**兩處入口**
- **初步直線化 ⑨**：`layout-shape`——格網化後直接跑（僅比較，不進下游）
- **循環之後**：`hc-<kind>-shape`——對①〜⑧各鏈循環結果貼形

**鐵律**
- **要不要算＝規定表**
- **成方＋合規**：交叉不比輸入多、無站重疊／壓線——不合規的成方結果**不交付**
- 規定外 → **不需計算**

## 實作

`shapePresets.js`＋`shape.js`；D3Tab `layout-shape`／`hc-*-shape`；`HC_LS_KEY` v25+。
