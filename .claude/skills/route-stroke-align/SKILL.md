---
name: route-stroke-align
description: 筆畫法（論文直線鏈 stroke，Li & Dong 2010）——把段串成筆畫（同路線 every-best-fit 共線接續）、依最大方向扭曲 >45° 遞迴切子筆畫、各子筆畫吸 4 主方向（H/V 優先）後把成員頂點垂直投影到過錨點的定向直線，逐筆畫漸進套用。當使用者要求修改筆畫法、調筆畫配對/切分門檻/投影規則、或問「筆畫法」tab 的行為時使用。七條論文鏈的共用機構見 [[route-paper-align]]、總覽見 [[route-hillclimb]]。
---

# 筆畫法 (route-stroke-align)

[[route-hillclimb]] 的論文直線鏈之一（kind `stroke`）。論文：Li & Dong 2010
_A stroke-based method for automated generation of schematic network maps_
（`data/thesis/1_…pdf`＋`1_stroke-based_演算法說明.md`）。
輸入 = Hill Climbing 的 `cellAfter`，目標 = 短距離移動彩色頂點讓 H/V/45° 段最多。

## 演算法（整數格改編）

1. **FormStrokes（§3.1）**：每個頂點上把入射段做 every-best-fit 配對——只允許
   **共享路線**的段對、偏角（π − 夾角）< 45°、偏角小者優先——再沿配對關係走出
   筆畫（頂點鏈）。
2. **排序（式 3）**：路線數 > 弧長 > 交點數，大筆畫先處理。
3. **遞迴切分（§4.2 方法一）**：子筆畫首尾連線為基準，最大「方向扭曲」（中間點
   對基準的角度偏差）> 45° 就在最壞點切成兩段。
4. **吸附＋投影（§4.3/§5.1）**：子筆畫依首尾方向吸 4 主方向（H/V 可多容 7.5°、
   否則 45°/135°），成員頂點**垂直投影**到過錨點（度數最高、已定案者優先）的
   定向直線。
5. **漸進式**：每筆畫的 targets 自成一批經 `finishBatches` 套用（壞批獨立退回），
   套完的頂點 `fixed`——後續筆畫視為錨、不再動它。

## 與論文的差異

- 拓撲一致性不用論文的點在多邊形修復——targets 統一走 `applyTargets` 硬規則
  （§5 四硬規則；淨 HVD 變差整批退回），效果等價於「移不動就留在原地」。
- 輸入已是格網化＋爬山後的佈局，所以只取方向吸附＋投影核心，位移夾 `WINDOW`（±2 格）。

## 實作契約

- `buildStrokeAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `hvBefore/hvAfter/hvdBefore/hvdAfter/moved/
  proposed/revertedN/strokes/substrokes`。
- 註冊在 `PAPER_KINDS`（kind `stroke`、tab 名「筆畫法」）；UI 經
  `iteratePost(buildStrokeAlign, …)` 迭代到不動點（上限 20）；接受準則用
  `countHVD`（八方向系演算法，45° 不算退步）。
- 下游鏈（端點移動/直線縮減/網格合併/循環/RWD/畫廊）與其他鏈完全同構。

## 修改時

配對門檻/切分準則/方向偏好變動同步本檔與 `paperAlign.js`；共用機構
（finishBatches / clampTargets / snapAligned）變動記在全部七個論文鏈 skill 或
其共同段落。**改演算法要 bump `scripts/buildViews.mjs` 的 VIEWS_VERSION 重算畫廊**。
