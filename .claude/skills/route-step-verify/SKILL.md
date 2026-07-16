---
name: route-step-verify
description: 逐步驗證（原 Step by Step）——按「下一步」＝目前演算法掃整個 network 一遍、「下一小步」＝單一移動（前後比對橘圈），含上一步/上一小步復原堆疊與三階段 chips。當使用者要求修改逐步驗證、加/改步進按鈕、前後比對顯示、或問逐步 tab 行為時使用。演算法本體見 [[route-endpoint-move]]/[[route-line-compact]]/[[route-grid-merge]]、輪替語意見 [[route-movewise-loop]]。
---

# 逐步驗證 (route-step-verify)

實作：`src/stores/hillClimb.js` 的 `stepChainInit`/`stepChainNext(skeleton,
state, {limit})`（純資料 state、不變異輸入）＋ D3Tab 的浮動面板（step-panel）。

## 操作

- **下一步**＝目前演算法把整個 network 掃**一遍**（movewiseSweep；接續小步已
  走過的進度），掃完就換下一個演算法（掃不動也換、同一鍵內自動跳過空掃描）。
- **下一小步**＝這一遍中的**下一個單一移動**（limit=1；端點移動/直線縮減用
  sweepVisited 跳過本輪動過的元素、網格合併用 mergeCursor 逐邊界），訊息附
  座標（單點 (c,r)→(c,r)、線位移向量＋成員數、合併 row r｜r+1）。
- **上一小步**＝回退一個動作；**上一步**＝一路吞掉其後的小步、回退到上一個
  大步之前（D3Tab stepHistory[鏈] 快照堆疊、上限 400 筆——state 純資料所以
  pop 即還原）。
- **重設**＝回鏈的起點（起點也先壓縮）。
- 一輪＝三個演算法各掃一遍；**一輪全沒改動＝「✔ 收斂完成」**、前進鍵停用。

## 顯示

- 三階段 chips（端點移動→直線縮減→網格合併）——剛執行的亮起（lastStage）。
- **前後比對**（小步）：moves = [{id, from, to}]（縮減後 rank 空間；被壓掉的
  欄/列 → -0.5 半格、像素內插）——舊位置虛線空心圈、虛線軌跡、新位置橘色
  實圈；大步與網格合併不畫（合併動的是整個半平面）。
- state = { cells, cols, rows, stage, round, steps, roundMoves, done,
  lastStage, movedIds, moves, sweepVisited, mergeCursor, info }。

## 一致性

全用大步跑到收斂＝循環 tab 的結果（實測台北 12×13 等多城一致）；
大小步可混按。逐步是純顯示視圖，不餵下游。
