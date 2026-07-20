---
name: route-path-align
description: 路徑簡化（論文直線鏈 path，Merrick & Gudmundsson 2007）——每條路線的頂點鏈當折線，C=8 方向、ε-圓刺穿求最少 link 的 C-directed 簡化（reach＋BFS 分層），頂點垂直投影到刺穿它的 link；路線依轉乘站數排序漸進、先處理的定案。當使用者要求修改路徑簡化鏈、調 ε/方向集/固定點機制、或問「⑦路徑簡化」tab 的行為時使用。共用機構見 [[route-paper-align]]。
---

# 路徑簡化 (route-path-align)

[[route-paper-align]] 的論文鏈之一（kind `path`）。論文：Merrick & Gudmundsson
2007 _Path Simplification for Metro Map Layout_（`data/thesis/7_…pdf`＋
`7_merrick-path-simplification_演算法說明.md`）。

## 演算法（整數格改編）

1. **逐路線分解**：每條路線的段集合分解成最大開放鏈（deg-1 端點起走；剩下的環
   任取起點）。路線依**重要性＝轉乘頂點數**（§3 (1)）排序，先處理的路線頂點
   `fixed`——後續路線只動自己獨有的頂點（固定點機制的簡化）。
2. **C-directed 最少 link（Definition 1）**：C = 8 方向、每點 ε-圓（EPS=1.4 格
   ——相鄰站均距 1–2 倍的下緣 §5.9；固定點 ε 收縮成 1e-6＝「恰過該點」）。
   `reach(i, c)`＝從點 i 起、方向 c 的單一 link 能**依序刺穿**到的最遠索引：
   offset 可行區間收縮＋取中點、沿 link 參數單調驗證（貪婪）。實作採 O(|C|²·n²)
   直觀版（論文自己說可以先寫直觀版）。
3. **BFS 分層求最少 link 數**（狀態＝點索引；同方向連續 link 無意義，不必記方
   向）；ε 蓋不住（罕見）該鏈放棄。
4. **投影**：回溯 links，每 link 的 offset 取兩端中點（固定端以其為準），中間
   頂點**垂直投影**到 link 上；每條鏈的 targets 自成一批經 `finishBatches`。

## 與論文的差異

- 不做論文的同時多路徑衝突消解——逐路線漸進＋`applyTargets` 硬規則（不壓點/
  不新增交叉）等價把關。
- 位移夾 WINDOW（±2 格）：這是短距離後處理，不是全圖重佈局。

## 實作契約

- `buildPathAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `chains`（處理鏈數）/`links`（總 link 數）。
- kind `path`、tab 名「⑦路徑簡化」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

ε/方向集/排序變動同步本檔與 `paperAlign.js`。**bump VIEWS_VERSION**。
