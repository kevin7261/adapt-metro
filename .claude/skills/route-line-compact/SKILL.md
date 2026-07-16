---
name: route-line-compact
description: 直線縮減（movewise 三步鏈第 2 步）——跨相交點串接的直線整條垂直平移 ±1 格，嚴格縮小網格、全網 H/V 不減、validShift 硬規則＋跨距上限。當使用者要求修改直線縮減、調線的串接/採納條件、或問「直線縮減」tab 的行為時使用。movewise/循環機構見 [[route-movewise-loop]]、跨距上限見 [[route-span-cap]]、總覽見 [[route-hillclimb]]。
---

# 直線縮減 (route-line-compact)

movewise 三步鏈的**第 2 步**，輸入 = [[route-endpoint-move]] 後的佈局。
實作：`src/stores/hillClimb.js` 的 `lineCompactPass(skeleton, cells, cols,
rows, {limit, skip})`（單掃描 pass）。

## 規則

- **直線**＝同軸共線段經 union-find 串成的連通元件（`lineComponents`），
  **跨相交點串接**——轉乘/分歧/黃色交叉點若被直線直穿就整條一起動。
- **只准垂直於線移動**（水平線只能上下移、垂直線只能左右移），且**一次只能
  移一格**（±1）——movewise 下網格隨時緻密、相鄰欄列必有佔用，逐格合併即可。
- 採納條件（全要）：
  1. **嚴格減少佔用欄數＋列數**（gainOf > 0——某欄/列被清空併進鄰欄/列）。
  2. **全網 H/V 段數不減**（剛體平移只有邊界段會變，boundaryHvDelta ≥ 0）。
  3. [[route-span-cap]]：邊界段兩顏色點不得拉超過上限（boundarySpanOk）。
  4. validShift **同一套硬規則**（不壓點、不新增交叉/遮蔽、象限與邊環繞序
     不變＝拓撲不變）。
- tie-break：縮越多 → 邊界段 H/V 淨增大者。

## 收斂

每步嚴格縮小網格（欄＋列數，有下界）→ 保證終止。

## 歷史裁決（2026-07）

- 原本可「跳到最近的已佔用欄/列」（距離不限）＋±2；使用者改為一次一格。
- 「水平線只能上下移、垂直線只能左右移」與「全網直線不可變少」為使用者
  明定規則。
