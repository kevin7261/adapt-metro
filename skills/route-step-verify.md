---
name: route-step-verify
description: 逐步驗證（原 Step by Step）——按「下一步」＝目前演算法跑到不動點、「下一小步」＝單一移動（前後比對橘圈），含上一步/上一小步復原堆疊、自動執行（每秒一小步）、執行到底與三階段 chips。當使用者要求修改逐步驗證、加/改步進按鈕、前後比對顯示、或問逐步 tab 行為時使用。演算法本體見 [[route-endpoint-move]]/[[route-line-compact]]/[[route-grid-merge]]、輪替語意見 [[route-movewise-loop]]。
---

# 逐步驗證 (route-step-verify)

實作：`src/stores/movewise.js` 的 `stepChainInit`／`stepChainNext`（純資料
state；每步後 compactGridSafe；**done 時套與循環相同的 `loopPostConverge`**）
＋ D3Tab 的浮動面板（step-panel）。

## 操作

按鈕順序：**上一步 → 上一小步 → 下一小步 → 下一步 → 自動執行 → 執行到底 → 重設**。

- **下一步**＝目前演算法**跑到不動點**（`movewiseStage`），再換下一個演算法
  （掃不動也換、同一鍵內自動跳過空階段）。與循環同一語意：算到不能動才換。
- **下一小步**＝**下一個單一移動**，語意與 `movewiseStage` 相同（端點／直線
  每次取目前第一個可動、**不**用 visited 掃過——避免與循環分叉）；網格合併
  用 mergeCursor 逐邊界，單步盡頭再跑一次完整 `movewiseStage('gather')`
  收尾（成對縮方／填空帶）。訊息附座標。
- **上一小步**／**上一步**＝復原堆疊（上限 400）。
- **自動執行**＝每秒一次下一小步。
- **執行到底**＝大步連跑到收斂（與循環同判準＋同 postConverge）；結果寫入
  循環槽。
- **重設**＝回鏈的起點（起點也先壓縮）。
- 一輪＝三個演算法各自至不動點；**一輪全沒改動＝「✔ 收斂完成」**（並套
  `loopPostConverge`）。

## 顯示

- 三階段 chips；小步前後比對橘圈（縮減後 rank 空間）。
- state = { cells, cols, rows, stage, round, steps, roundMoves, done,
  lastStage, movedIds, moves, sweepVisited, mergeCursor, info }。

## 一致性（硬保證）

- 循環＝`movewiseStage` 三階段輪替＋`loopPostConverge`。
- 逐步大步／執行到底＝同一套 `movewiseStage`＋done 時同一套
  `loopPostConverge`。
- 逐步小步連跑到 done＝同一不動點語意＋同一 postConverge → **最終座標與
  循環一模一樣**。
- 起點雙方都先 `compactGridSafe`。
