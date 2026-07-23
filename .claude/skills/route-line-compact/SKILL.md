---
name: route-line-compact
description: 直線縮減（movewise 三步鏈第 2 步）——跨相交點串接的直線整條八方向平移 ±1 格（含 45°），優先 H/V 變多、否則邊界段變最短；validShift 硬規則＋跨距上限。當使用者要求修改直線縮減、調線的串接/採納條件、或問「直線縮減」tab 的行為時使用。movewise/循環機構見 [[route-movewise-loop]]、跨距上限見 [[route-span-cap]]、總覽見 [[route-hillclimb]]。
---

# 直線縮減 (route-line-compact)

movewise 三步鏈的**第 2 步**，輸入 = [[route-endpoint-move]] 後的佈局。
實作：`src/stores/movewise.js` 的 `lineCompactPass(skeleton, cells, cols,
rows, {limit, skip})`（單掃描 pass）。

## 規則

- **直線**＝同軸共線段經 union-find 串成的連通元件（`lineComponents`），
  **跨相交點串接**——轉乘/分歧/黃色交叉點若被直線直穿就整條一起動。
- **八方向各 ±1 格**（上下左右＋ 45° 對角，一次一格）。
- 採納優先序（二擇一，且 H/V 不可變少）：
  1. **邊界段 H/V 淨增 > 0**——優先挑淨增最大者。
  2. 若皆無，但**邊界段總長變短**——挑縮最短者。
  另需：[[route-span-cap]]（boundarySpanOk）＋ validShift 硬規則（不壓點/
  不新增交叉/拓撲不變）。
- tie-break：H/V 淨增 → 縮短量。

## 收斂

每步讓 (−H/V 數, 邊界總長) 字典則嚴格下降 → 有界終止。

## 歷史裁決（2026-07）

- 原本可「跳到最近的已佔用欄/列」（距離不限）＋±2；使用者改為一次一格。
- 曾限「水平線只能上下、垂直線只能左右」→ 四方向 → 八方向（含 45°）。
- 採納改為「直線變多優先，否則路線變最短」（不再以縮網格為主採納條件）。
- 「全網直線不可變少」為使用者明定規則。
