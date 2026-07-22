---
name: route-grid-merge
description: 網格合併（movewise 三步鏈第 3 步，原「中位集中」重定義）——相鄰 row 兩兩合併、col 兩兩合併：半平面整體移 1 格、自帶壓縮，validShift 判準（不壓點/不新增交叉/拓撲不變），不算中位點。當使用者要求修改網格合併、調合併順序/判準、或問「網格合併」tab 的行為時使用。movewise/循環機構見 [[route-movewise-loop]]、總覽見 [[route-hillclimb]]。
---

# 網格合併 (route-grid-merge)

movewise 三步鏈的**第 3 步**，輸入 = [[route-line-compact]] 後的佈局。
實作：`src/stores/hillClimb.js` 的 `gridMergeSweep(skeleton, cells, cols,
rows, {limit, cursor})`（一遍掃描）＋ `gridMergeStage`（stage 驅動：
single=true 只掃一遍給循環用、否則掃到沒有可合併給 tab 用）。

## 規則

- **合併 r|r+1** ＝「row > r 的所有點整體上移 1 格」（半平面剛體平移）——
  row r+1 的點落進 row r、其下全部跟著上移，**自帶壓縮**、不留空列；
  col 同理左移。**不算中位點**（原「中位集中」的中位數邏輯已全數移除，
  UI 的黃色中位圓標也一併移除）。
- 合法性走 validShift **同一套硬規則**（與 [[route-endpoint-move]]／
  [[route-line-compact]] 同判準）：不壓點（點重疊）、不新增交叉、不產生
  路線重疊、象限與邊環繞序不變＝**拓撲不變**。
- **成方成對縮格**（形狀圖層）：單軸切開方形會破方被護欄擋；改同時併一欄＋
  一列並驗 `isFourLineSquare`，方仍是方但可繼續壓縮（`squarePairShrinkOnce`）。
  掃到不動點的上限用 `MERGE_ITER_CAP`（5000），**不可**共用論文鏈的
  `POST_ITER_CAP`（=20）——否則成對縮格會半途截斷（東京 rot-shape 曾停在
  62×64，跑滿可到 ~21×20）。
- 附帶性質（自動成立、不需另檢）：邊界段跨距只縮不增；H/V 段只增不減
  （水平/垂直段不受影響、dy=1 斜段合併後變水平、dy=1 垂直段因兩端撞格被
  validShift 擋下）。
- 掃描順序：rows 由上而下、cols 由左而右，**每個邊界本遍試一次**（兩兩配
  對、合併成功即前進不重吃）；`cursor`（{phase:'row'|'col', idx}）讓
  [[route-step-verify]] 的小步跨點擊延續同一遍（小步＝合併一個邊界）。
- stats：mergedRows/mergedCols（moved＝總合併次數）。

## 收斂

每次合併使 rows+cols 嚴格 −1（有下界）→ 保證終止。

## 歷史裁決（2026-07）

- 前身「中位集中」：點沿線滑向中位點＋線垂直移向中位點（一次一格、不越過
  中位點、藍點不拉長線）。使用者重定義為 row/col 兩兩合併後，中位點的計算
  與繪製全部移除。
