---
name: route-movewise-loop
description: movewise 機構與「端點移動+直線縮減+網格合併循環」——每一個單一移動後立即縮減網格（取消獨立縮減步驟）；循環每輪＝三個演算法各把整個 network 掃一遍輪替，一輪全靜止才停。當使用者要求修改循環/輪替/一遍掃描/movewise 壓縮、調上限、或問「循環」tab 與 RWD 底圖來源時使用。三個演算法見 [[route-endpoint-move]]/[[route-line-compact]]/[[route-grid-merge]]、總覽見 [[route-hillclimb]]。
---

# movewise 與循環 (route-movewise-loop)

實作：`src/stores/hillClimb.js` 的 `movewiseStage`／`movewiseSweep`／
`gridMergeStage`／`straightenCompactLoop`。

## movewise（使用者規則 2026-07）

**取消獨立的縮減網格步驟**——端點移動/直線縮減的**每一個小步驟（單一移動）
完成後就做 compactGrid**（以 limit=1 反覆呼叫該階段的單掃描 pass、每個移動
後立即壓縮，MOVEWISE_CAP=5000 保險）；網格合併的半平面平移**自帶壓縮**。
網格因此隨時緻密、尺寸逐步縮小；`compactGrid` 只在 movewise 內部使用，
不再是 tab。

## 一遍掃描（movewiseSweep）

循環與 [[route-step-verify]] 的「一步」＝該演算法把**整個 network 掃一遍**
（不是跑到自己的不動點）：每個元素本輪最多動一次（動過的進 visited、pass 以
opts.skip 跳過；網格合併用 cursor 逐邊界）。單獨的三個 stage tab 則用
`movewiseStage`（掃到不動點）。

## 循環（straightenCompactLoop）

每輪＝**端點移動掃一遍 → 直線縮減掃一遍 → 網格合併掃一遍 → 回到端點移動**；
某一輪**三個演算法都沒有改動**才停止（上限 LOOP_ROUND_CAP=200 輪——一遍掃描
制的輪數比階段固定點制多）。收斂：端點移動 (−H/V, 斜線長, 總長) 字典序遞減、
直線縮減與網格合併嚴格縮小網格，皆有界。223 城實測全收斂、總計約 5 秒。

## 下游

- **RWD 底圖與 llmGrid 建立在循環結果之上**（使用者裁決；RWD 圖層第一個 tab
  「循環結果」沿用 id 'hc-compact'；`layer.compact` 選鏈，hc 鏈仍可當 RWD
  底圖——D3Tab loop 區塊的 isRWD fallback、key 'hc'）。
- 端點移動/直線縮減/網格合併/循環/逐步驗證**五個 tab 區都沒有 hc 鏈**
  （只有 直角爬山/軸對齊/整數規劃/LLM 對齊 四條鏈，使用者裁決）。
- 畫廊（hcviews 卡片、rwdviews）與 `scripts/llmGrid.mjs` 鏡射同一條鏈——
  **改了演算法要 bump `scripts/buildViews.mjs` 的 VIEWS_VERSION 重算**。
