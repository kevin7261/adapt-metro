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

## 設定 UI（StyleBar 第 2 排，**只 hillclimb（Straighten）視圖**）

- 「線段最大跨距」輸入（per-layer `layer.spanCap`、預設 3）。
- **改數字即重算**（@change 直接 emit `recalc-span`）——清三階段/循環/逐步/RWD
  快取、以新值重算；D3Tab 以 `appliedSpanCap` 快照「快取是用哪個值算的」，
  保證同畫面不會新舊上限混雜。
- SPAN_CAP **只約束爬山 movewise**（endpoint-move／line-compact），RWD 畫線
  完全不用——RWD 工具列不顯示此控制（2026-07-20 使用者裁決）。
- 離線腳本（llmGrid/buildViews 畫廊）用模組預設值。

## 歷史（2026-07）

預設 2 → 3（使用者裁決）；曾為滑桿、後改手動輸入；曾同時出現在 RWD 工具列、
2026-07-20 依「SPAN_CAP 只用於 straighten」移除。
