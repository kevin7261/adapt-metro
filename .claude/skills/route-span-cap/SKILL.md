---
name: route-span-cap
description: 顏色點間最大跨距（SPAN_CAP）——所有移動不得讓受影響段的兩個顏色點橫跨超過 n 格（Chebyshev），樣式 tab 手動設定＋「重新計算」套用，預設 3。當使用者要求調跨距上限、改設定 UI/預設值、或問為什麼某移動被擋時使用。套用於 [[route-endpoint-move]]/[[route-line-compact]]（[[route-grid-merge]] 只縮不增、自動滿足）。
---

# 顏色點間最大跨距 (route-span-cap)

實作：`src/stores/hillClimb.js` 的 `SPAN_CAP`（模組變數，**預設 3**）＋
`setSpanCap(n)`（夾 ≥1 整數）；`spanOf/spanOk/boundarySpanOk` 檢查。

## 規則

- 任何移動不得讓**受影響段的兩個顏色點橫跨超過 SPAN_CAP 格**
  （Chebyshev：max(|dx|,|dy|)）——防止兩點之間的線被拉太長。
- **舊長段豁免**：本來就超過上限的段只准縮短或不變、不准再拉長
  （否則其端點會被永久凍結）。
- 網格合併只會讓跨距變小 → 自動滿足、不需檢查。

## 設定 UI（樣式 tab，hillclimb / rwd 視圖）

- 「顏色點間最大跨距」輸入（per-layer `layer.spanCap`、預設 3）。
- **改了不會自動重算**——「重新計算」按鈕（樣式同 .llm-run-btn）按下才清
  三階段/循環/逐步/RWD 快取、以新值重算；D3Tab 以 `appliedSpanCap` 快照
  「快取是用哪個值算的」，未套用前顯示提示、新計算沿用舊值避免混雜。
- 離線腳本（llmGrid/buildViews 畫廊）用模組預設值。

## 歷史（2026-07）

預設 2 → 3（使用者裁決）；曾為滑桿、後改手動輸入。
