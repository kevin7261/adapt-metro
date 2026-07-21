# ⑨ Shape-Guided 混合式地鐵圖佈局（Shape-Guided Mixed Metro Map Layout）

> 論文：T. Batik, S. Terziadis, Y.-S. Wang, M. Nöllenburg & H.-Y. Wu (2022).
> *Shape-Guided Mixed Metro Map Layout*. Computer Graphics Forum (Pacific Graphics 2022), 41(7), 495–506. DOI: 10.1111/cgf.14695
> 開源實作：https://github.com/TobiasBat/Shape-Guided-Mixed-Metro-Map-Layout
> 對應 PDF：`data/thesis/9_Shape-Guided Mixed Metro Map Layout.pdf`

本文件是給開發者（或其他 LLM）的實作指南。論文三步不必逐行複製；**Adapt-Metro 的硬目標**：

1. **成方 ∧ 鐵律同時必要**：規定路段嵌正方形（四條 H/V）；不當交叉 ≤ 輸入、邊環繞序不變、無撞格。**破鐵律＝錯誤，禁止交付假方**（交不出 → 退回輸入）。
2. **做法**：先慢慢 `validMove`；**真的沒辦法**才在規定路段 W 插綠色轉折（網格交叉點、≤4）。禁硬釘撕網。密網（山手）比大江戶難得多——附著輻射多，A0 過不了就不能硬釘。

變形段沿用 Wang & Chi（本庫 ⑤）的兩段最小平方；格網段論文用 Octi（⑥），本庫在整數格上改為「整網變形＋釘邊＋平面性守門／綠控」（見文末「與本系統的關係」）。


---

## Adapt-Metro 契約（先讀）

| 項目 | 規定 |
|---|---|
| 何時算 | 僅 `shapePresets` 列名的城市；其餘 UI **disable**。進入 tab **不自動算**，按「執行」才跑並顯示過程 log |
| 形狀 | 目前只開 **方形（shape=0）**＝規定路段四邊直線（只 H/V、禁斜切角） |
| 規定路段 W | 預置站序（山手／新加坡 Circle／大江戶環段）；對應論文手動指定 W，**不做**自動 Fréchet 選路 |
| 輸入座標 | 示意整數格（Hill Climbing／循環結果），非經緯度 |
| 拓撲 | **鐵律不可破**：不當交叉 ≤ 輸入；點周圍邊環繞序不變；無撞格 |
| 失敗策略 | §6F **持續算到**成方∧鐵律（不提前停／不退回假結束）。禁硬釘假方。綠點僅 W |

論文 D1（Constrained Layouts）：示意化時 **輸入拓撲的保持是自然約束**。本庫把「不當交叉不增」當硬規則。

---

## 計算邏輯與程式骨架

> 以下依論文寫「要算什麼、怎麼算」。實作照邏輯寫；不要綁死既有函式名。

### 1. 輸入（抽象資料）

- 運輸網 `N = (S, C)`：站＋連線；座標論文＝地理、本庫＝整數格。
- 引導形狀 `P`：折線（本庫＝單位正方 → 對齊到 W 的 bbox）。
- **本庫**：`W` 來自規定表（論文之 user-defined / manual path）。

### 2. 輸出

規定路段可辨識地貼指定形狀；其餘趨向示意化；**拓撲與輸入等價**（無新增不當交叉、無撞格）。

### 3. 內部狀態（精簡）

| 變數 | 說明 |
|---|---|
| `W` | 規定路徑（擺形用） |
| `P_aligned` | 平移＋等比縮放後凍結（D5） |
| `S′_shape` / `C′_shape` | 動態描形站／邊（**W ≠ C_shape**） |
| `cross0` | 輸入不當交叉數（拓撲預算） |

### 4. 主流程

```
前處理
  cross0 ← improperCrossCount(輸入)
  （論文：非平面則插 dummy；本庫以 cross0 為預算）

STEP 1：擺形（§4）
  W ← 規定表站序
  P_aligned ← 只平移＋等比縮放對齊 bbox(W)（不旋轉，D5）

STEP 2a：平滑 LS（§5.1）
  Ω_smooth = wc·Ωc + wl·Ωl + wa·Ωa + wp·Ωp
  每輪：鏡射規則更新 S′_shape → 解 LS → 更新 R_ij
  平面性：若 cross(S′) > cross0 → 整輪退回上一輪
  （論文：新交叉退回上一輪＋能量懲罰；站–邊過近推開）

STEP 2b：混合 LS（§5.2）
  邊分 C_shape / C_octo；octo 匈牙利八方向
  Ω_mixed = wo·Ωo + wp·Ωp + wc·Ωc
  同樣平面性守門
  本庫：W 鎖 P_aligned 弧長目標後，再只動其餘站若干輪

STEP 3：格網（§6）
  論文：Octi 織入 P、先 route shape 邊（分鐘級）——本庫不做完整 Octi
  本庫整數格：
    1. 整網連續變形（RBF／徑向同胚／仿射）讓鄰站跟著 W 走
    2. 吸附整數格；W 釘成四邊直線正方（站序均分四邊）
    3. 清撞格；交叉修復（W 凍結）
    4. fourLine ∧ 鐵律 → 交付
    5. §6F 鐵律內 validMove＋綠控再試；仍不成 → 退回輸入
```

---

## 關鍵子計算

### A. 自動路線比對（§4.1）——論文有、本庫不做

方向式積分 Fréchet 成長路徑。本庫 W 由規定表給定。

### B. 描形站動態指派

```
pi = closest_on(P_aligned, v′i)
v* = 2·pi − v′i
若 v′i–v* 不穿任何邊 → v′i ∈ S′_shape
```

鐵律：**W ≠ C_shape**。本庫仍強制 W ⊆ S′_shape。

### C. 八方向衝突 → 匈牙利／小 n 精確重排

### D. 平面性守門

```
每輪 LS 後若 cross > cross0 → 回退
§6 A0–E：僅 fourLine ∧ 鐵律 → 交付
§6 F：鐵律內再試（綠控＋validMove）；仍不成 → 退回輸入
```

不當交叉＝不共端點的真交叉。

---

## 設計準則

| # | 準則 | 落點 |
|---|---|---|
| D1 | **拓撲保持** | cross≤cross0；禁止交付撕網結果 |
| D2 | 相對位置 | Ωp；不旋轉 |
| D3 | 站距分離 | Ωl；清撞格 |
| D4 | 少彎 | Ωa |
| D5 | 形狀不旋轉 | bbox 對齊後凍結 P |
| D6 | 形狀可辨識 | Ωc；四邊直線方 |
| D7 | 混合方向 | 描形邊可非八方向 |

---

## 與本系統（Adapt-Metro）的關係

| 論文 | 本庫 |
|---|---|
| 自動 Fréchet 選 W | `shapePresets` 規定 W |
| 任意引導折線 | 只方形（四邊 H/V） |
| 地理 → Octi 格網 | 示意格 LS → 整網變形釘邊 |
| 新交叉退回＋懲罰 | LS 輪回退；§6 全程鐵律；交不出成方∧鐵律 → 退回輸入 |
| 獨立管線 | ⑨ `layout-shape`（格網→貼形）；未規定城 disable |

程式：`src/stores/paper/shape.js`、`shapePresets.js`；skill：`route-shape-align`。

**檢查清單**：D5 不旋轉；D1 交叉不增；W≠唯描形集；只釘 W 必撕網；未規定城不跑。
