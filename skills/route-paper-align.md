---
name: route-paper-align
description: 論文直線鏈（直線演算法①〜⑧）的總目錄與共用機構（src/stores/paperAlign.js）——直線演算法＝論文①〜⑧＋LLM 對齊共 9 條，名稱與 data/thesis 的演算法說明一一對應（2026-07 使用者裁決；自創的軸對齊/整數規劃已下架；Shape-Guided 改掛循環之後見 route-shape-align）。共用機構：WINDOW ±2 夾擠、clampTargets、finishPass/finishBatches（逐批漸進＋strict 嚴格改善）、snapAligned 對齊感知量化、scoreAlign 接受準則（HV 優先、45° 次之）、dirModel（③⑧ 共用方向指派模型）、coordsFromDirs 鬆弛重建。當使用者要修改論文鏈的共用機構、加新論文鏈、或問直線演算法（①筆畫法/②直角爬山/③MILP規劃/④力導向/⑤最小平方/⑥八向格網/⑦路徑簡化/⑧SAT規劃）的整體架構時使用。各鏈細節見 route-stroke-align／route-rect-polish／route-milp-align／route-force-align／route-lsq-align／route-octi-align／route-path-align／route-sat-align，總覽見 [[route-hillclimb]]。
---

# 論文直線鏈總目錄與共用機構 (route-paper-align)

「直線演算法」＝**論文①〜⑧＋LLM 對齊共 9 條**（2026-07 使用者裁決：名稱要與
`data/thesis/<n>_*_演算法說明.md` 一一對應；先前自創的軸對齊/整數規劃鏈已下架。
**Shape-Guided（Batik et al. 2022）不在此列**——掛在 Straighten 形狀圖層
⑨，見 [[route-shape-align]]）。
`src/stores/paperAlign.js` 是論文鏈唯一註冊點；每條鏈**完全同契約**：輸入
**Map Adjust 格網化後**（或成方）的 `cellOf`／`cellAfter`，短距離移動彩色頂點，
回傳 `{ cellAfter, stats }`，由 `iteratePost` 迭代到不動點（上限 20），下游
（端點移動/直線縮減/網格合併/循環/逐步驗證/RWD/畫廊/LLM 評價互動比較）全部同構。
**不吃 HC**（HC 僅畫廊參考圖）。

| kind | tab 名 | 論文 | skill |
|---|---|---|---|
| `stroke` | ①筆畫法 | ① Li & Dong 2010 | route-stroke-align |
| `rect` | ②直角爬山 | ② Stott et al. 2011（\|sin 2θ\| 直角變體） | route-rect-polish（build 在 hillClimb.js） |
| `milp` | ③MILP規劃 | ③ Nöllenburg & Wolff 2011 | route-milp-align |
| `force` | ④力導向 | ④ Hong et al. 2006 | route-force-align |
| `lsq` | ⑤最小平方 | ⑤ Wang & Chi 2011 | route-lsq-align |
| `octi` | ⑥八向格網 | ⑥ Bast et al. 2020 | route-octi-align |
| `path` | ⑦路徑簡化 | ⑦ Merrick & Gudmundsson 2007 | route-path-align |
| `sat` | ⑧SAT規劃 | ⑧ Fuchs 2022 | route-sat-align |
| `llm` | LLM 對齊 | —（非論文；headless Claude Code） | route-llm-align |

（② 的全圖佈局本體＝主演算法 Hill Climbing，本鏈是其直角後處理變體；
One Metro World 無演算法內容。）論文與逐篇說明在 `data/thesis/`。

## 共用機構（paperAlign.js 頂部）

- **WINDOW = 2**：targets 離目前位置的 Chebyshev 上限（短距離後處理）。
- **clampTargets**：連續 targets 四捨五入＋夾 WINDOW＋界內，只留真的要動的格。
- **finishPass**：單批收尾——clamp → `applyTargets(…, scoreAlign)` → stats。
- **makeApplier / finishBatches**：逐批（逐子筆畫/逐鏈/逐頂點）漸進套用，每批
  獨立過 applyTargets、壞批獨立退回；一批可給**多個候選**（`Map[]`，依序試到第一
  個被接受——①的「先 H/V、被擋才用 ±45°」）；`strict: true` 時批要**嚴格**改善
  scoreAlign 才收（單頂點批用——中性移動會讓 iteratePost 永不收斂地漂移；嚴格遞增以段數
  為上界保證終止）。①⑦ 直接用 `makeApplier` 邊算邊套（後面的筆畫/路線看得到已
  定案的佈局）；④⑥ 的提案與佈局無關，先算完再用 `finishBatches` 逐批套。
- **snapAligned**：連續解的「對齊感知」量化——頂點依 id 序逐一吸到四周整數格，
  取入射段對齊分最高（HV=2、45°=1）、平手取近者——能 H/V 就不停在 45°。
- **dirModel ＋ coordsFromDirs**（③⑧ 共用）：每段 3 候選方向（最近扇區 ±1）、
  成本 λ1·同路線彎折 bd ＋ λ2·非原方向、同頂點同向硬 veto；選定方向後用
  shape-matching 式鬆弛重建座標（40 輪；段長下限 = H3 最短邊長 `hops`，即該段
  吞掉的白點數 + 1，白點之後等距回插才有空間）。
- **接受準則一律 `scoreAlign`**（HV 主鍵＋HVD 次鍵＝**能 H/V 優先、45° 次之**；
  ②直角爬山例外——爬山本體用自己的適應度）。
- 硬規則沿用 [[route-hillclimb]] 的 `makeMover`/`applyTargets`（不壓點、不新增
  交叉、象限與邊環繞序不變）。全部純函式、確定性（畫廊預算依賴）。

## 註冊與下游

- `PAPER_KINDS`（kind/zh/build；zh 帶論文圈號①〜⑧）＝唯一清單；`PAPER_BUILD`/
  `PAPER_ZH` 由它導出。D3Tab、mapStore（RWD_COMPACTS ＝ ①〜⑧＋llm）、
  viewGeometry（CHAIN_KINDS ＝ hc＋①〜⑧）、DialogHost、AllGallery、
  LayerPanel/DockTab、scripts/llm{Eval,Grid,Compare}.mjs、
  vite.config.js（COMPACT_KINDS）都吃這份或有對應清單。
- **加新鏈**：在 paperAlign.js 實作 build → 加進 PAPER_KINDS（zh 帶編號）→
  更新 vite/compactKinds.js 與 src/lib/rwdCompacts.js → bump VIEWS_VERSION。
  UI 各處的中文名都從 PAPER_ZH 導出，不用手抄。

## 修改時

共用機構（WINDOW/makeApplier/finishBatches/snapAligned/dirModel）變動記在本檔；各鏈私有
邏輯記在各自 skill。**改任何鏈都要 bump `scripts/buildViews.mjs` 的
VIEWS_VERSION**（畫廊縮圖是離線預算的）。
