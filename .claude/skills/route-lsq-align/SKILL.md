---
name: route-lsq-align
description: 最小平方（論文直線鏈 lsq，Wang & Chi 2011 Focus+Context）——每段目標向量＝目前邊向量旋到最近八方向長度不變，解 min Σ|(ṽi−ṽj)−f_ij|²＋w_g·Σ|ṽi−vi|²（Gauss–Seidel 60 輪），snapAligned 量化後單批套用。當使用者要求修改最小平方鏈、調 w_g/w_o 權重/輪數、或問「最小平方」tab 的行為時使用。共用機構見 [[route-paper-align]]。
---

# 最小平方 (route-lsq-align)

[[route-paper-align]] 的論文鏈之一（kind `lsq`）。論文：Wang & Chi 2011
_Focus+Context Metro Maps_（`data/thesis/5_…pdf`＋`5_wang-chi_演算法說明.md`）。

## 演算法（整數格改編）

論文的**階段二（八方向化）**：

1. 每段目標向量 `f_ij = f(v_i − v_j)`＝目前邊向量旋到**最近八方向**、長度不變
   （一次吸附，不逐輪重算——重算會震盪）。
2. 能量 `Ω = w_o·Σ|(ṽ_i−ṽ_j) − f_ij|² + w_g·Σ|ṽ_i − v_i|²`（式 6 的
   Ω_o 八方向項＋Ω_g 原位錨定項；w_o=10、w_g=0.05＝論文權重）。
3. 求解用 **Gauss–Seidel** 60 輪（共軛梯度的輕量替代；系統小、對角佔優，收斂
   等價）：每頂點的座標更新＝鄰居暗示位置（o + f 的方向暗示）的加權平均＋原位
   錨定。
4. 收尾：`snapAligned` 對齊感知量化 → `finishPass`（夾 WINDOW＋硬規則）。

## 與論文的差異

- **階段一（平滑變形／focus 放大）不需要**：輸入已是格網化＋爬山後的規律佈局，
  這條鏈只取八方向化核心。
- 邊界/邊距/交叉抑制（式 7–8、位移減半）由 `applyTargets` 硬規則統一把關。

## 實作契約

- `buildLsqAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `rounds`。
- kind `lsq`、tab 名「最小平方」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

權重/輪數變動同步本檔與 `paperAlign.js`。**bump VIEWS_VERSION**。
