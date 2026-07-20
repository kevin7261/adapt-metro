---
name: route-stroke-align
description: 筆畫法（論文直線鏈 stroke，Li & Dong 2010）——把段串成筆畫（同路線＝具名優先、剩餘段跨路線 every-best-fit）、依最大方向扭曲 >45° 遞迴切子筆畫、各子筆畫先試 H/V 被擋才退用 ±45°，成員頂點垂直投影到過錨點的定向直線，逐子筆畫當場套用。當使用者要求修改筆畫法、調筆畫配對/切分門檻/投影規則、或問「①筆畫法」tab 的行為時使用。論文鏈總目錄與共用機構見 [[route-paper-align]]、總覽見 [[route-hillclimb]]。
---

# 筆畫法 (route-stroke-align)

[[route-hillclimb]] 的論文直線鏈之一（kind `stroke`）。論文：Li & Dong 2010
_A stroke-based method for automated generation of schematic network maps_
（`data/thesis/1_…pdf`＋`1_stroke-based_演算法說明.md`）。
輸入 = Hill Climbing 的 `cellAfter`，目標 = 短距離移動彩色頂點讓 H/V/45° 段最多。

## 演算法（整數格改編）

1. **FormStrokes（§3.1 → §3.2）**：每個頂點兩輪配對——先「具名」（捷運的路線
   就是名稱）：**共享路線**的段對依偏角（π − 夾角）小者優先串接，**不設門檻**
   （路線該轉就轉，過彎交給 §4.2 切分）；再「無名」：剩下沒配到的段跨路線做
   every-best-fit，偏角 < 45° 才配。沿配對關係走出筆畫（頂點鏈）。
2. **排序（式 3）**：類型（路線數）> 總長 > 交點數（deg ≥ 3 的頂點數），大筆畫先處理。
3. **遞迴切分（§4.2 方法一）**：子筆畫首尾連線為基準，最大「方向扭曲」（中間點
   對基準的角度偏差）> 45° 就在最壞點切成兩段。
4. **吸附＋投影（§4.3/§5.1/§D）**：4 主方向模式——**先試**最近的水平/垂直，
   被硬規則擋下或淨對齊變差**才退用**最近的 ±45°（論文的「斜線是備援」）。
   成員頂點**垂直投影**到過錨點的定向直線；錨點 = 交點（deg ≥ 3）中已定案且
   所屬筆畫排序鍵最高者 → 沒有交點時取首尾中點。
5. **漸進式（§6.3）**：每條子筆畫**當場套用**（`makeApplier`，兩個方向候選依序
   試、壞的獨立退回），套完的頂點 `fixed`——後續筆畫看到的是已定案的佈局。

## 與論文的差異

- 拓撲一致性不用論文的點在多邊形修復——targets 統一走 `applyTargets` 硬規則
  （§5 四硬規則；淨 HVD 變差整批退回），效果等價於「移不動就留在原地」。
- 輸入已是格網化＋爬山後的佈局，所以只取方向吸附＋投影核心，位移夾 `WINDOW`（±2 格）。

## 實作契約

- `buildStrokeAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `hvBefore/hvAfter/hvdBefore/hvdAfter/moved/
  proposed/revertedN/strokes/substrokes`。
- 註冊在 `PAPER_KINDS`（kind `stroke`、tab 名「①筆畫法」）；UI 經
  `iteratePost(buildStrokeAlign, …)` 迭代到不動點（上限 20）；接受準則用
  `countHVD`（八方向系演算法，45° 不算退步）。
- 下游鏈（端點移動/直線縮減/網格合併/循環/RWD/畫廊）與其他鏈完全同構。

## 修改時

配對門檻/切分準則/方向偏好變動同步本檔與 `paperAlign.js`；共用機構
（finishBatches / clampTargets / snapAligned）變動記在全部七個論文鏈 skill 或
其共同段落。**改演算法要 bump `scripts/buildViews.mjs` 的 VIEWS_VERSION 重算畫廊**。
