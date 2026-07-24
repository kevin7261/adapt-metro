---
name: route-force-align
description: 力導向（論文直線鏈 force，Hong et al. 2006 磁力彈簧）——引力 d/δ＋頂點對斥力 δ²/d²＋頂點×不相鄰邊斥力 (γ−d)²/d＋八方向磁場力（力偶垂直於邊）逐頂點在格空間跑 40 輪，位移過 PrEd 8 區域上限，snapAligned 量化後逐頂點批＋嚴格改善套用。當使用者要求修改力導向鏈、調力參數（CM/BM/ALPHA/BETA/γ）、或問「④力導向」tab 的行為時使用。共用機構見 [[route-paper-align]]。
---

# 力導向 (route-force-align)

[[route-paper-align]] 的論文鏈之一（kind `force`）。論文：Hong, Merrick,
do Nascimento 2006 _Automatic visualisation of metro maps_（Method 5 磁力彈簧；
`data/thesis/4_…pdf`＋`4_force-directed_演算法說明.md`）。

## 演算法（整數格改編）

STEP 3（改良版 PrEd）固定 40 輪，**逐頂點算合力、當場移動**（頂點順序固定＝確定性）：

1. **引力（鄰接邊）**：`ratio = d/δ` 乘上朝鄰居的向量；理想距離
   `δ = ℓ·sqrt(min(26, hops))`（§5.3 的 `sqrt(L·(min(W,weight)+1))`，weight =
   邊吞掉的白點數；格空間把單位常數 L 校準成「每跳中位長 ℓ」的平方，W=25）。
2. **頂點對斥力（所有頂點對）**：`ratio = δ²/d²` 反向推開。
3. **頂點×不相鄰邊斥力（式 2）**：垂直投影落在段內且距離 < γ=3ℓ 才作用，
   係數 `(γ−d)²/d`（論文 γ=100 是其輸入座標尺度）。
4. **磁場力（式 4）**：每條鄰接邊取最近八方向，力偶垂直於邊、兩端反向，
   `F_m = c_m·b·len^α·|Δθ|^β`，**論文原值** c_m=0.1, b=30, α=1, β=0.5。
5. **位移上限**：先套 GEM 溫度（STEP 2 的 `step_size ← min(T, |F|)`，T 取一個
   理想邊長——沒有它，格空間近距離的 δ²/d² 會把座標推到溢位），再過
   **PrEd 8 區域移動上限**（§5.1：沿合力方向不得穿過任何不相鄰邊）。

收尾：`snapAligned` 量化 → **逐頂點批＋strict**（`finishBatches` strict）——
力平衡是「接近」八方向而非嚴格對齊（論文自承的弱點），整批套用常淨變差被全退；
改成把力場當提案器、硬規則＋HVD 嚴格改善當接受器。

## 與論文的差異

- STEP 2 的 GEM 初始佈局不需要——輸入已是格網化＋爬山後的佈局（論文允許以
  地理/既有佈局起始）；因此**確定性**（固定頂點順序、無隨機），畫廊預算依賴。
- STEP 1 的 deg-2 收縮已由骨架完成（白點＝被吞掉的站）；STEP 4 的等距回插由下游
  `placeBlacks` 做。
- 連續解最後仍要 `snapAligned` 量化並過 `applyTargets` 硬規則（位移夾 WINDOW）。

## 實作契約

- `buildForceAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `rounds`。
- kind `force`、tab 名「④力導向」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

力參數/輪數/溫度/γ 變動同步本檔與 `paperAlign.js`。strict 批機構記在
[[route-paper-align]]。**bump VIEWS_VERSION**。
