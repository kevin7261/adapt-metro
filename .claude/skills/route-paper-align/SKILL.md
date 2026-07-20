---
name: route-paper-align
description: 七條論文直線鏈的共用機構（src/stores/paperAlign.js）——與直角爬山/軸對齊/整數規劃相同契約的 H/V 最大化後處理：WINDOW ±2 夾擠、clampTargets、finishPass/finishBatches（逐批漸進＋strict 嚴格改善）、snapAligned 對齊感知量化、countHVD 接受準則、dirModel（③⑧ 共用方向指派模型）、coordsFromDirs 鬆弛重建。當使用者要修改論文鏈的共用機構、加新論文鏈、或問七條鏈（筆畫法/MILP規劃/力導向/最小平方/八向格網/路徑簡化/SAT規劃）的整體架構時使用。各鏈細節見 route-stroke-align／route-milp-align／route-force-align／route-lsq-align／route-octi-align／route-path-align／route-sat-align，總覽見 [[route-hillclimb]]。
---

# 論文直線鏈共用機構 (route-paper-align)

`src/stores/paperAlign.js` 收七條「論文直線演算法」後處理鏈——與
[[route-rect-polish]]/[[route-axis-align]]/[[route-axis-ilp]] **完全同契約**：
輸入 Hill Climbing 的 `cellAfter`，短距離移動彩色頂點，回傳 `{ cellAfter, stats }`，
由 `iteratePost` 迭代到不動點（上限 20），下游（端點移動/直線縮減/網格合併/循環/
逐步驗證/RWD/畫廊/LLM 評價互動比較）全部同構。

| kind | tab 名 | 論文 | skill |
|---|---|---|---|
| `stroke` | 筆畫法 | ① Li & Dong 2010 | route-stroke-align |
| `milp` | MILP規劃 | ③ Nöllenburg & Wolff 2011 | route-milp-align |
| `force` | 力導向 | ④ Hong et al. 2006 | route-force-align |
| `lsq` | 最小平方 | ⑤ Wang & Chi 2011 | route-lsq-align |
| `octi` | 八向格網 | ⑥ Bast et al. 2020 | route-octi-align |
| `path` | 路徑簡化 | ⑦ Merrick & Gudmundsson 2007 | route-path-align |
| `sat` | SAT規劃 | ⑧ Fuchs 2022 | route-sat-align |

（② Hill Climbing 已是主演算法；⑨ Shape-Guided 使用者裁決不做；⑫ One Metro
World 無演算法內容。）論文與逐篇說明在 `data/thesis/`。

## 共用機構（paperAlign.js 頂部）

- **WINDOW = 2**：targets 離目前位置的 Chebyshev 上限（同整數規劃鏈的 ±2 視窗）。
- **clampTargets**：連續 targets 四捨五入＋夾 WINDOW＋界內，只留真的要動的格。
- **finishPass**：單批收尾——clamp → `applyTargets(…, countHVD)` → stats。
- **finishBatches**：逐批（逐筆畫/逐鏈/逐頂點）漸進套用，每批獨立過 applyTargets、
  壞批獨立退回；`strict: true` 時批要**嚴格**改善 HVD 才收（單頂點批用——中性
  移動會讓 iteratePost 永不收斂地漂移；嚴格遞增以段數為上界保證終止）。
- **snapAligned**：連續解的「對齊感知」量化——頂點依 id 序逐一吸到四周整數格，
  取入射段 HVD 對齊數最高、平手取近者（純四捨五入會毀掉準確的 45°/軸向）。
- **dirModel ＋ coordsFromDirs**（③⑧ 共用）：每段 3 候選方向（最近扇區 ±1）、
  成本 λ1·同路線彎折 bd ＋ λ2·非原方向、同頂點同向硬 veto；選定方向後用
  shape-matching 式鬆弛重建座標（40 輪）。
- **接受準則一律 `countHVD`**（H/V＋45°）：七篇都是八方向系演算法，用純 countHV
  會把演算法刻意給的 45° 判成退步而整批退回。
- 硬規則沿用 [[route-hillclimb]] 的 `makeMover`/`applyTargets`（不壓點、不新增
  交叉、象限與邊環繞序不變）。全部純函式、確定性（畫廊預算依賴）。

## 註冊與下游

- `PAPER_KINDS`（kind/zh/build）＝唯一清單；`PAPER_BUILD`/`PAPER_ZH` 由它導出。
  D3Tab、mapStore（RWD_COMPACTS）、viewGeometry（CHAIN_KINDS）、DialogHost、
  AllGallery、LayerPanel/DockTab、scripts/llm{Eval,Grid,Compare}.mjs、
  vite.config.js（COMPACT_KINDS）都吃這份或有對應清單。
- **加新鏈**：在 paperAlign.js 實作 build → 加進 PAPER_KINDS → 更新
  vite.config.js 的 COMPACT_KINDS 與 LayerPanel/DockTab/DialogHost/AllGallery
  的中文名 → bump VIEWS_VERSION。

## 修改時

共用機構（WINDOW/finishBatches/snapAligned/dirModel）變動記在本檔；各鏈私有
邏輯記在各自 skill。**改任何鏈都要 bump `scripts/buildViews.mjs` 的
VIEWS_VERSION**（畫廊縮圖是離線預算的）。
