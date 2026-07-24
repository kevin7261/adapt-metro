---
name: route-endpoint-move
description: 端點移動（movewise 三步鏈第 1 步，原「端點拉直」）——每個非白點一次移 1 格（八方向含 45°），優先 H/V 直線變多、否則路線變最短；bendsPaid 護欄＋makeMover 硬規則＋跨距上限。當使用者要求修改端點移動、調採納條件/1 格上限/bendsPaid、或問「端點移動」tab 的行為時使用。movewise/循環機構見 [[route-movewise-loop]]、跨距上限見 [[route-span-cap]]、總覽見 [[route-hillclimb]]。
---

# 端點移動 (route-endpoint-move)

movewise 三步鏈（端點移動 → [[route-line-compact]] → [[route-grid-merge]]）的
**第 1 步**。輸入 = 該鏈（論文①〜⑧＋LLM 對齊，見 [[route-paper-align]]）的結果佈局。
實作：`src/stores/movewise.js` 的 `buildEndpointStraighten(skeleton, cells,
cols, rows, {limit, skip})`（單掃描 pass；函式名保留歷史名）。

## 規則

- **每個非白點都可移動**（所有彩色頂點——端點/轉乘/分歧/黃色交叉；白/黑
  直通站不是頂點）。
- **候選＝八個 1 格單位移動**（上下左右＋ 45° 對角四向；一次不可超過 1 格——
  遠處對齊靠 movewise 逐移動壓縮把距離拉近後慢慢完成）。
- **採納優先序**（二擇一，H/V 不可變少）：
  1. 自身入射段的 **H/V 淨增 > 0**——優先挑淨增最大者。
  2. 若皆無，但入射段**總長變短**——挑縮最短者。
- **bendsPaid**：既有 H/V 段只有在「同一步有同路線的段被拉直」時才准折彎
  ——犧牲 X 線的直段去拉直 Y 線即使淨增也不行（sharesRoute 判定）。
- [[route-span-cap]]：入射段兩顏色點移動後不得橫跨超過上限。
- 每步走 makeMover **同一套硬規則**（不新增交叉、不壓到別的線/點、象限與
  邊環繞序不變＝拓撲不變）。
- tie-break：H/V 淨增 → 縮短量 → 順著同 route 在鄰居另一側已是 H/V 的段接直
  （contScore）→ 座標決定序。

## 收斂

每步讓 **(−H/V 數, 總長) 字典序嚴格下降**——單調有界 → 終止
（movewise 壓縮會改變長度上界，MOVEWISE_CAP=5000 保險）。

## 歷史裁決（2026-07）

- 一次只能移 1 格（原本可吸到任意遠鄰居的欄/列）。
- 候選由四方向擴為八方向（含 45°）。
- 採納改為「直線變多優先，否則路線變最短」（取代舊的 bendGain／藍點專用
  收線分叉）。
- 改名：端點拉直 → 端點移動。
