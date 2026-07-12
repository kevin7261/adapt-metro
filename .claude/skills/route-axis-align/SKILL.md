---
name: route-axis-align
description: 軸對齊（H/V 最大化後處理②）——方向指派＋座標指派：逐軸把貼近該軸的段用 union-find 併群、每群吸到成員座標的中位數（L1 最小移動），x/y 兩個獨立 1-D 問題，目標經硬規則多輪套用，並迭代到不動點（上限 20 次）。當使用者要求修改軸對齊、調 maxShift/群組規則、或問「軸對齊」tab 的行為時使用。總覽與共用機構見 [[route-hillclimb]]。
---

# 軸對齊 (route-axis-align)

[[route-hillclimb]] 的**第二種 H/V 最大化後處理**：輸入 = Hill Climbing 的
`cellAfter`。思路承自 orthogonal drawing 的 coordinate assignment——
「一段是水平 ⇔ 兩端 y 相同」，所以 H/V 最大化可拆成 **x、y 兩個獨立的
1-D 對齊問題**。

## 演算法（每軸各做一次）

1. **方向指派**：段「嚴格較貼近該軸」（45° 不算、保持斜線）且垂距
   ≤ 2×maxShift（預設 maxShift=2）→ 兩端點用 union-find 併入同一群。
   已對齊的段也入群（整條鏈共享同一座標）。
2. **座標指派**：每群取成員座標的**中位數**（L1 總移動最小）；離中位數
   超過 maxShift 的成員逐輪剔除、中位數重算，群剩 <2 人就解散。
3. **套用**：合併後的目標經 `applyTargets`（與優化器同一套 4 條硬規則，
   先試全目標、再逐軸拆半、多輪重試；**淨 H/V 變差整批退回**）。

單發演算法；動完會冒出新的可對齊機會，外面用 `iteratePost` 迭代到不動點
（上限 20；靠上限保底，實測 ≤5 次收斂）。

## 特性（224 城實測）

- 迭代後全網 H/V **+28.5%**（三種中最保守，但移動站數最少、最快 <10ms）。
- 高度依賴 Hill Climbing 先把佈局整理近示意圖——跳過 HC 幾乎失效
  （短距離內沒有可對齊候選）。

## 實作契約

- `buildAxisAlign(skeleton, cells, cols, rows, opts)`（src/stores/hillClimb.js），
  `opts.maxShift` 預設 2。stats 含 `hvBefore/hvAfter/groupsH/groupsV/passes`。
- UI 經 `iteratePost(buildAxisAlign, ...)`；tab「軸對齊」badge 顯示「已迭代/20」；
  縮減 tab「軸對齊縮減」= `compactGrid`。

## 修改時

分群/中位數/剔除規則變動同步本檔與 `hillClimb.js`；共用機構的變動記在
[[route-hillclimb]]。
