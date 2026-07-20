---
name: route-octi-align
description: 八向格網（論文直線鏈 octi，Bast et al. 2020）——邊依 ldeg（線度數）排序逐邊定案：未定案端點在半徑 WINDOW 內的空格候選中選一對，成本＝位移懲罰＋非八方向弦的彎折成本＋站上與已定案同路線段的線彎；定案格關閉（一格一站），逐頂點批＋嚴格改善套用。當使用者要求修改八向格網鏈、調成本權重/候選半徑/排序、或問「八向格網」tab 的行為時使用。共用機構見 [[route-paper-align]]。
---

# 八向格網 (route-octi-align)

[[route-paper-align]] 的論文鏈之一（kind `octi`）。論文：Bast, Brosi, Storandt
2020 _Metro Maps on Octilinear Grid Graphs_（`data/thesis/6_…pdf`＋
`6_bast-grid_演算法說明.md`）。

## 演算法（整數格改編）

1. **ldeg（§4.1）**：`ldeg(v)` ＝鄰接段的不重複路線數總和；邊依端點 ldeg 大者
   優先排序（完整 dangling 排程的簡化——複雜轉乘樞紐先佔位）。
2. **逐邊定案**：每邊的未定案端點取原位 Chebyshev 半徑 `R=WINDOW` 內的**空格**
   候選（已定案端點只剩定案格），對每組 (A,B) 計成本：
   - 位移懲罰 `(dispA + dispB)·CMOVE(=0.5)`——對應論文式 8 的 (c_h+c_m)/D
     在 offset 技巧（格網邊實際成本歸零）下只付 c_m；
   - 弦非正對八方向＝至少一個 45° 彎的下界，計 `2 + 角度偏差/(π/8)`；
   - **站上線彎（§4.4）**：與該頂點上已定案同路線段的彎折 `BEND[cyc8]·0.5`。
3. **定案＝關閉資源**：選定後兩端就地定案、該格從空格集合移除（一格一站——
   論文資源競爭即拓撲保證的對應）。
4. 收尾：依定案順序**逐頂點批＋strict**（`finishBatches` strict）——貪婪定案
   的個別提案好壞不一，整批淨退回會把好的一起丟掉。

## 與論文的差異

- 下游模型是「彩色點之間單直段」，Bast 的多彎 Dijkstra 路徑無法表示——取其
  **候選集＋成本模型＋貪婪定案順序**做節點指派（單 link 路由）；多彎路由屬於
  RWD 畫線器的職責（[[route-rwd-draw]] 已是同精神的 H/V/45 重繪）。
- 不做論文的 local search 輪替（iteratePost 的不動點迭代承擔同角色）。

## 實作契約

- `buildOctiAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `settled`（定案頂點數）。
- kind `octi`、tab 名「八向格網」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

成本權重/半徑/排序變動同步本檔與 `paperAlign.js`。**bump VIEWS_VERSION**。
