---
name: route-rwd-draw
description: RWD Maps（版面路網畫線）——把 Hill Climbing 的「縮減網格」佈局重繪成嚴格 H/V/45° 折線：每段產生依轉折數排序的候選折線（直線→單折→雙折 1/2→1/4→3/4），衝突（共線重疊/壓過節點）就換下一個候選；合法直線衝突時有平行偏移與三角/L 繞行；黑點沿選定折線弧長放回。八方向約束以版面 pixel 為準（非整數格索引）。當使用者要求 RWD Maps、版面路網、H/V/45 畫線、或在 RWD Maps layer group 加/改視圖時使用。實作在 src/stores/rwdMap.js（純函式）＋ D3Tab 的 rwd 圖層模式。
---

# RWD Maps 版面路網畫線 (route-rwd-draw)

把 [[route-hillclimb]] 的**縮減網格**佈局重繪成示意圖折線：每段路線只用
**水平（H）／垂直（V）／45°** 三種方向的腿。此 skill 是這個畫線規則的**唯一權威依據**。

> **硬規則：八方向約束以「版面 pixel」為準**——H/V/45° 是在 SVG 畫面座標上判定，
> **不是整數格索引**。欄寬 ≠ 列高（任何非正方畫布）時，格座標的對角線在畫面上不是
> 45°，所以折線必須**在像素空間重建**；視窗改變大小就整組重算（NYC 也只 ~12ms），
> 不跨 resize 快取。
> 實作：`src/stores/rwdMap.js` 的 `buildRwdMap(segs, pos, opts)`；UI 在 `D3Tab.vue`
> （`layer.type === 'rwd'`），layer group「RWD Maps」。

## 資料流

```
Hill Climbing 圖層的 縮減網格（compactGrid cells）
  → 換成像素座標（等寬格心）
  → buildRwdMap：每段（buildHcGraph 的 cut-to-cut segment）選一條 H/V/45 折線
  → 黑點沿選定折線弧長平均放回
```

- 新圖層由 Layers 面板 RWD Maps group 的 **+** 建立：選一個 Hill Climbing 圖層
  （來源即其縮減網格，存在 `layer.sourceLayerId`）。
- Tab 有 2 個視圖：**縮減網格**（輸入）與 **RWD 路網**（結果）；工具列顯示
  段數與轉折直方圖（直線/單折/雙折/兜底/強制重疊）。

## 候選折線（轉折數由少到多）

方向判準（像素座標，容差 ~0.75px）：`Δy≈0`→H、`Δx≈0`→V、`|Δx|≈|Δy|`→45°、其餘不合法（X）。

1. **直線** `S→T`：本身已是 H/V/45 → 轉折 0。
2. **單轉折**：45° 先走到與較短邊等長處再接 H/V；純 L 形（先 H 後 V／先 V 後 H）；
   鏡像（H/V 先、45° 收尾）。
3. **雙轉折**：45–H–45（|Δx|>|Δy|）或 45–V–45（|Δy|>|Δx|），中段預設落在 **1/2**，
   衝突時改用 **1/4、3/4** 的替代版本（三版都先產生、依序嘗試）。
4. **兜底**：以上全衝突才畫原方向直線（非 H/V/45），計入 `stats.fallback`。

**合法直線也要有替代**（頭尾共點的平行邊、走廊已被先前折線佔用）：
平行偏移（45° 出去、以 d=1→2 個格單位並行、45° 回來，小偏移優先）→
大繞行（H/V 線的 45° 三角頂點、45° 線的 L 轉角）。全部衝突仍畫直線，
計入 `stats.forced`（工具列顯示「強制重疊」）。

## 衝突判定（否決候選）

1. **共線重疊**：兩腿同族（H/V/D+/D−）、同一條線（key 差 < 0.5px）、延伸重疊
   超過一點 → 衝突。橫向交叉（不同方向穿過）**允許**。
2. **壓過節點**：腿的內部（端點除外）掃過任何其他彩色節點 → 衝突。
3. 段的處理順序：**長走廊優先**（替代路徑最少），同長依序，結果確定性。

## 黑點

黑點不是折線頂點：第 j 個（共 k 個）放在選定折線**弧長** j/(k+1) 處
（方向與 segment a→b 一致）。共用黑點（環線/折返路線同站出現在兩段）以後處理者為準。

## 實作契約

- `buildRwdMap(segs, pos, opts)`：`segs` 來自 [[route-hillclimb]] 的
  `buildHcGraph(skeleton, cellOf).segs`（含 `interior` 黑點 id 與父 edge 參照）、
  `pos` 為**像素座標** `Map<id,[x,y]>`（縮減網格格心）、`opts.unit` 為繞行偏移單位
  （像素，呼叫端傳 ~一格）。回傳 `{ lines: [{seg, pts, bends, fallback}],
  posAfter: Map<id,[x,y]>, stats: {straight, single, double, fallback, forced, segs} }`。
- 純函式、無亂數；同輸入同輸出。
- 繪製沿用 D3Tab 的路線著色（單線實色、共線交錯虛線）與節點分類色。

## 未實作（原規格屬另一專案的機制，此處明確排除）

- 非均勻欄寬列高（AI 權重／線 weight max／黑點 max 三種比例來源）——目前**恆為均勻網格**。
- 黑點精簡（依鄰站 weight 差值隱藏黑點）。
- 若之後要做，非均勻映射後**必須在新像素座標上重跑 buildRwdMap**（見頂部硬規則）。

## 修改此轉換時

候選/衝突/黑點規則變動，**同步更新本 SKILL.md 與 `src/stores/rwdMap.js`**；
上游契約（buildHcGraph/compactGrid）變動同步 [[route-hillclimb]]。
