---
name: route-rect-polish
description: 直角爬山（H/V 最大化後處理①）——把爬山法的方向準則從八方向 |sin 4θ| 換成直角 |sin 2θ|（45° 變最貴）、短半徑 [2,1,1] 在 Hill Climbing 結果上再爬，並迭代到不動點（上限 20 次）。當使用者要求修改直角爬山、調 rect 模式權重/半徑、或問「直角爬山」tab 的行為時使用。總覽與共用機構見 [[route-hillclimb]]。
---

# 直角爬山 (route-rect-polish)

[[route-hillclimb]] 的**第一種 H/V 最大化後處理**：輸入 = Hill Climbing 的
`cellAfter`，目標 = 短距離移動彩色頂點讓**水平/垂直段最多**
（一段是 H/V ⇔ 兩端恰有一個座標相同）。

## 演算法

就是再跑一次 `buildHillClimb`，只差三件事：

1. **方向準則 c_N5 換成 |sin 2θ|**（`opts.rect: true`）——只有 0°/90° 零成本、
   45° 變成最貴的方向，段會被拉向水平/垂直。
2. **權重 octi ×3**（補償比八方向更嚴的 4 方向理想）。
3. **半徑排程 [2,1,1]**（短距離 polish，不做全域重排）。

其餘五準則、4 條硬規則、群集移動全部沿用主 skill。因為半徑排程會先用完
（不是「沒改善才停」），外面再用 `iteratePost` 餵自己的輸出**迭代到不動點**
（上限 `POST_ITER_CAP = 20`；適應度單調下降保證終止）。

## 特性（224 城實測）

- 迭代後全網 H/V **+42.9%**（三種演算法後處理中第二強）；最大迭代 12 次。
- 是唯一「從迭代獲益最多」的——單跑受限的是輪數而非局部最優。
- 也是唯一**跳過 Hill Climbing 仍可用**的（本質是另一次爬山），但適應度會差
  ——管線仍以先 HC 為準。

## 實作契約

- `buildRectPolish(skeleton, cells, cols, rows, opts)`（src/stores/hillClimb.js）
  = `buildHillClimb(..., { rect: true, radii: [2,1,1], weights: { octi: ×3 } })`。
- UI 經 `iteratePost(buildRectPolish, ...)` 呼叫；tab「直角爬山」按鈕 badge
  顯示「已迭代/20」；stats 含 `hvBefore/hvAfter/iters/converged`＋適應度。
- 縮減 tab「直角爬山縮減」= 對結果套 `compactGrid`。

## 修改時

準則/權重/半徑變動同步本檔與 `hillClimb.js`；共用機構（makeMover /
applyTargets / iteratePost）的變動記在 [[route-hillclimb]]。
