---
name: route-force-align
description: 力導向（論文直線鏈 force，Hong et al. 2006 磁力彈簧）——彈簧引力（理想邊長）＋頂點對斥力＋頂點×不相鄰邊斥力＋八方向磁場力（力偶垂直於邊）在格空間跑 40 輪，snapAligned 量化後逐頂點批＋嚴格改善套用。當使用者要求修改力導向鏈、調力參數（CM/BM/ALPHA/BETA/STEP）、或問「力導向」tab 的行為時使用。共用機構見 [[route-paper-align]]。
---

# 力導向 (route-force-align)

[[route-paper-align]] 的論文鏈之一（kind `force`）。論文：Hong, Merrick,
do Nascimento 2006 _Automatic visualisation of metro maps_（Method 5 磁力彈簧；
`data/thesis/4_…pdf`＋`4_force-directed_演算法說明.md`）。

## 演算法（整數格改編）

固定 40 輪、每輪四種力疊加、位移截斷 STEP=0.25 格：

1. **彈簧（式 1）**：沿邊朝理想長度（中位每跳長 L × min(hops, 6)）；過長拉近、
   過短推開。
2. **頂點對斥力（式 1）**：δ²/d² 沿連線推開，只算 3L 內的近場。
3. **頂點×不相鄰邊斥力（式 2）**：垂直投影落在段內且距離 < γ=1.5L 才作用。
4. **磁場力（式 4）**：每邊取最近八方向，力偶垂直於邊、兩端反向，
   `mag = CM·BM·d^α·|Δθ|^β`（CM=0.1, BM=8, α=0.5, β=0.5——論文 c_m=0.1, b=30,
   α=1 是像素尺度；格空間把 b 縮小、α 降 0.5 防長邊力偶爆掉，量級調到磁力能贏
   彈簧/斥力，八方向對齊才會發生）。

收尾：`snapAligned` 量化 → **逐頂點批＋strict**（`finishBatches` strict）——
力平衡是「接近」八方向而非嚴格對齊（論文自承的弱點），整批套用常淨變差被全退；
改成把力場當提案器、硬規則＋HVD 嚴格改善當接受器。

## 與論文的差異

- 初始佈局＝目前整數格位置（論文 §3.5「保留地理嵌入」變體）；GEM 隨機階段以
  現有佈局取代——**確定性**（固定頂點順序、無隨機），畫廊預算依賴。
- PrEd 的 8 區域移動限制由 `applyTargets` 硬規則等價把關；STEP 截斷是其保守替代。
- deg-2 已在骨架收縮。

## 實作契約

- `buildForceAlign(skeleton, cells, cols, rows)`（src/stores/paperAlign.js）
  → `{ cellAfter, stats }`；stats 含 `rounds`。
- kind `force`、tab 名「力導向」；`iteratePost` 迭代、`countHVD` 接受。

## 修改時

力參數/輪數/STEP 變動同步本檔與 `paperAlign.js`。strict 批機構記在
[[route-paper-align]]。**bump VIEWS_VERSION**。
