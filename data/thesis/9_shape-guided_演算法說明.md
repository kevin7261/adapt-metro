# ⑨ Shape-Guided 混合式地鐵圖佈局（Shape-Guided Mixed Metro Map Layout）

> 論文：T. Batik, S. Terziadis, Y.-S. Wang, M. Nöllenburg & H.-Y. Wu (2022).
> *Shape-Guided Mixed Metro Map Layout*. Computer Graphics Forum (Pacific Graphics 2022), 41(7), 495–506. DOI: 10.1111/cgf.14695
> 開源實作：https://github.com/TobiasBat/Shape-Guided-Mixed-Metro-Map-Layout
> 對應 PDF：`data/thesis/9_Shape-Guided Mixed Metro Map Layout.pdf`

本文件是給開發者（或其他 LLM）的實作指南。論文精神（選 W、兩段 LS、成方、平面）保留；**§6 主路徑改為徑向成方**（密網比 Octi 實用）。

---

## Adapt-Metro 契約（先讀）

| 項目 | 規定 |
|---|---|
| 何時算 | 僅 `shapePresets` 列名的城市；其餘 UI **disable**。進入 tab **不自動算**，按「執行」才跑並顯示過程 log |
| 形狀 | 目前只開 **方形（shape=0）**＝規定路段四邊直線（只 H/V） |
| 規定路段 W | 預置站序（山手／新加坡 Circle／大江戶環段）；對應論文手動指定 W |
| 輸入座標 | 示意整數格（Hill Climbing／循環結果），非經緯度 |
| 拓撲 D1 | 不當交叉 ≤ 輸入；無撞格（**不含**環繞序——那是 Stott／HC，非本論文） |
| 交付 | **成方 ∧ D1**；**永不退回輸入**——不合規則釘方＋修交叉仍交 |
| §6 | **徑向／RBF 整網成方＋釘四邊＋清交叉**（主）；Octi 僅 `opts.tryOcti` |

---

## 三步 → 本庫

```
STEP 1 §4 擺形
  W ← shapePresets
  P_aligned ← 平移＋等比縮放對齊 bbox(W)（不旋轉，D5）

STEP 2 §5 變形（暖身；Wang & Chi 風格兩段 LS）
  2a 平滑：Ω_smooth；鏡射更新 S′_shape；cross>cross0 → 退回上一輪
  2b 混合：C_shape / C_octo；同樣平面性守門
  本庫：W 鎖 P 弧長後再調整其餘站

STEP 3 §6 格網（本庫主路徑＝徑向成方，非論文 Octi）
  輸入＝mixed 佈局（已近形）
  1. 多尺度正方框候選（shrinkBoxes）
  2. 徑向同胚變形（失敗→RBF），W 目標＝四邊均分
  3. 互不撞整數吸附 → 釘 W 四邊 H/V
  4. 疏散框內非 W → 積極修交叉（D1）
  5. 合規交付；否則 ensurePaperDelivery 釘方仍交
  （可選 opts.tryOcti：再跑 shapeOcti.js 比種子）
```

---

## 與論文的差異（刻意）

| 論文 | 本庫 |
|---|---|
| 自動 Fréchet 選 W | `shapePresets` 規定 W |
| 任意引導折線 | 只方形 |
| §6＝Bast Octi 織入 P | §6＝徑向／RBF＋釘方＋修交叉（Octi 可選） |
| 地理座標 → 新建 Octi 格 | 已在示意整數格上變形 |
| route 失敗可不完整 | **永不退回輸入**；強制釘方仍交付 |

程式：`src/stores/paper/shape.js`（主）、`shapeOcti.js`（可選）、`shapePresets.js`；skill：`route-shape-align`。
