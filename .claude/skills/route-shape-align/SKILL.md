---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022）——規定表決定是否計算；成方候選若會增加交叉或造成重疊則不交付，改以 makeMover.validMove 逐步靠近方形。當使用者要求修改 Shape-Guided、問交叉/重疊、或問為何不成方時使用。
---

# Shape-Guided (route-shape-align)

**鐵律**
- **要不要算＝規定表**
- **成方＋合規**：交叉不比輸入多、無站重疊／壓線——不合規的成方結果**不交付**
- 原子候選（整網仿射／周界）合規才硬套；否則 `validMove` 逐步朝方形走（永不破硬規則）
- 規定外 → **不需計算**

## 管線

```
規定表取 W → §5 LS
→ §6 試 affine±周界 / ls+周界（輕量修後仍須合規）
→ 失敗則 walkAllToward(validMove) 朝方形目標
→ 雙重保險：若仍不合規 → 退回輸入
```

## 實作

`shapePresets.js`＋`shape.js`；`HC_LS_KEY` v25+。
