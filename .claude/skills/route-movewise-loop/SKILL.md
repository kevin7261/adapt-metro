---
name: route-movewise-loop
description: movewise 機構與「端點移動+直線縮減+網格合併循環」——每一個單一移動後立即縮減網格（取消獨立縮減步驟）；循環每輪＝三個演算法各自跑到不動點再換下一個，一輪全靜止才停。當使用者要求修改循環/輪替/不動點/movewise 壓縮、調上限、或問「循環」tab 與 RWD 底圖來源時使用。三個演算法見 [[route-endpoint-move]]/[[route-line-compact]]/[[route-grid-merge]]、總覽見 [[route-hillclimb]]。
---

# movewise 與循環 (route-movewise-loop)

實作：`src/stores/hillClimb.js` 的 `movewiseStage`／`movewiseSweep`／
`gridMergeStage`／`straightenCompactLoop`。

## movewise（使用者規則 2026-07）

**取消獨立的縮減網格步驟**——端點移動/直線縮減的**每一個小步驟（單一移動）
完成後就做 compactGridSafe**（以 limit=1 反覆呼叫該階段的單掃描 pass、每個移動
後立即壓縮，MOVEWISE_CAP=5000 保險）；網格合併的半平面平移**自帶壓縮**。
網格因此隨時緻密、尺寸逐步縮小；壓縮只在 movewise 內部使用、不再是 tab。
**壓縮有硬規則把關**（大邱重疊案 2026-07）：移除空欄＝右半平面左移 1 格＝
validShift 同一套硬規則（含變形段檢查，見 [[route-hillclimb]] ③′）——會製造
壓點/交叉/共線重疊的空帶**保留**（畫面多一條空帶），佈局永不因壓縮而劣化。

## 跑到不動點（movewiseStage）

循環與 [[route-step-verify]] 的「下一步」＝該演算法**跑到自己的不動點**
（`movewiseStage`：元素可重複動；網格合併掃到沒有可合併＋成對縮方）。
**算到不能動才換下一階段／下一輪**（2026-07 使用者裁決；勿只掃一遍就換）。

`movewiseSweep`（一遍掃描、每個元素本遍最多動一次）只給逐步「下一小步」
延續同一遍用；單獨的三個 stage tab 也走 `movewiseStage`。

## 循環（straightenCompactLoop）

每輪＝**端點移動至不動點 → 直線縮減至不動點 → 網格合併至不動點 → 下一輪**；
某一輪**三個演算法都沒有改動**才停止（與 [[route-step-verify]] 相同判準；
上限 LOOP_ROUND_CAP=200）。勿用「欄列＋H/V 不變」提前停。
收斂：端點移動 (−H/V, 斜線長, 總長) 字典序遞減、直線縮減與網格合併嚴格縮小網格。

## 下游

- **RWD 底圖與 llmGrid 建立在循環結果之上**（使用者裁決；RWD 圖層第一個 tab
  「循環結果」沿用 id 'hc-compact'；`layer.compact` 選鏈，hc 鏈仍可當 RWD
  底圖——D3Tab loop 區塊的 isRWD fallback、key 'hc'）。
- 端點移動/直線縮減/網格合併/循環/逐步驗證**五個 tab 區都沒有 hc 鏈**
  （只有論文①〜⑧＋LLM 對齊 九條鏈，無 hc 鏈，使用者裁決）。
- 畫廊（hcviews 卡片、rwdviews）與 `scripts/llmGrid.mjs` 鏡射同一條鏈——
  **改了演算法要 bump `scripts/buildViews.mjs` 的 VIEWS_VERSION 重算**。
