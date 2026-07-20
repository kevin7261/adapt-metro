# ④ 力導向（Force-Directed / 磁力彈簧）捷運圖佈局

> 論文：Seok-Hee Hong, Damian Merrick & Hugo A.D. do Nascimento (2006). *Automatic visualisation of metro maps*. Journal of Visual Languages and Computing, 17(3), 203–224. DOI: 10.1016/j.jvlc.2005.09.001

本文件是給開發者（或其他 LLM）的完整實作指南。讀完本文件後，不需要再看原始論文即可實作。

---

## 計算邏輯與程式骨架

> 以下依論文寫「要算什麼、怎麼算」——用虛擬碼、公式與迴圈描述計算步驟。實作時照此邏輯寫；不要呼叫既有程式裡的函式名，也不要寫「call xxx」。

### 1. 輸入（抽象資料）

- 無向圖 `G = (V, E)`，每個頂點 `v ∈ V` 附初始座標 `(x_v, y_v)`（可以是地理座標或隨機佈局）。
- 路線集合 `lines`：每條路線是頂點的有序序列，所有路線合起來覆蓋 `V` 與 `E` 中所有元素（每個頂點/邊至少屬一條路線）。
- 演算法參數：`L = 0.16, W = 25.0, γ = 100.0, c_m = 0.1, b = 30.0, α = 1.0, β = 0.5`，最大迭代輪數 `MAX_ITER`。

### 2. 輸出

每個頂點的最終連續空間座標 `(x_v, y_v)`（非格點；邊接近但不保證嚴格八方向）。

### 3. 建議內部狀態

| 變數 | 說明 |
|---|---|
| `G′ = (V′, E′)` | deg-2 簡化後的骨架圖（只含轉乘站與端點） |
| `weight[e]` | 簡化邊 `e` 吞掉的 deg-2 頂點數（決定理想邊長） |
| `deg2_chains` | 每條簡化邊對應的原始 deg-2 鏈序列（供回插使用） |
| `pos[v]` | 頂點當前座標 `(x, y)`（整個演算法中持續更新） |
| `T[v]` | GEM 每頂點局部溫度（GEM 階段使用） |
| `skew[v]` | GEM 旋轉偵測向量（累積過去移動方向，用來偵測旋轉/振盪） |

### 4. 主計算流程（Method 5 完整虛擬碼）

```
──────────────────────────────────────────────────
STEP 1：度 2 簡化（deg-2 contraction）
──────────────────────────────────────────────────
初始化 weight[e] ← 0 對所有 e

repeat：
  找任意一個 deg(v) = 2 的頂點 v，其兩鄰接頂點為 a, b
  記錄 deg2_chains[a,b].append(v)        // 保留順序，供回插
  w_new = weight[a,v] + 1 + weight[v,b]  // 含 v 本身 +1
  if 邊 (a,b) 已存在：
    weight[a,b] ← max(weight[a,b], w_new)  // 重邊取大
  else：
    新增邊 (a,b)；weight[a,b] ← w_new
  從 G 移除頂點 v 與其兩條邊
until 沒有 deg(v) = 2 的頂點
→ 得到 G′ = (V′, E′)

特殊情況：
  自環（路線端點繞回同站）：v 的兩條邊指向同一頂點 a，
    視為一條 a-a 邊，weight = 原鏈長，回插時沿閉合路徑等距。
  重邊（兩頂點之間有多條輸入邊）：保留所有邊；斥力公式中
    对同一顶点对的多条边分别計算后取最大理想距離（避免被
    最短邊拉太近）。

──────────────────────────────────────────────────
STEP 2：GEM 初始佈局（可選；地理初始時直接跳到 STEP 3）
──────────────────────────────────────────────────
T_init ← 10.0；T_min ← 0.1；T_global ← T_init
T[v] ← T_init；skew[v] ← (0,0)  對所有 v ∈ V′

repeat：
  隨機排列 V′ 的訪問順序 order
  for each v in order：
    // 計算 GEM 合力（不帶邊權）
    F ← (0, 0)
    for each u ≠ v in V′：
      d ← dist(pos[v], pos[u])
      if (v,u) ∈ E′：
        F += (d² / c) * normalize(pos[u] - pos[v])   // 引力
      F -= (c² / d²) * normalize(pos[u] - pos[v])    // 斥力
      // c 為理想邊長常數（GEM 階段不帶 weight，用全域均值）

    // 依溫度截斷移動
    step_size ← min(T[v], |F|)
    Δpos ← step_size * normalize(F)
    pos[v] += Δpos

    // 溫度更新（偵測振盪/旋轉）
    if dot(Δpos, skew[v]) < 0：   // 振盪
      T[v] ← T[v] * 0.5
      skew[v] ← (0,0)
    elif cross(Δpos, skew[v]) 顯著≠0：  // 旋轉
      T[v] ← T[v] * 0.9
    else：
      T[v] ← min(T[v] * 1.1, T_init)
    skew[v] ← Δpos

until 所有 T[v] < T_min

──────────────────────────────────────────────────
STEP 3：改良版 PrEd（Method 5 主迴圈）
──────────────────────────────────────────────────
for iter = 1 to MAX_ITER：
  for each v in V′：
    Fx ← 0；Fy ← 0

    // ── 引力（鄰接邊，帶邊權）──
    for each u ∈ neighbors(v) in G′：
      δ ← sqrt(L * min(W, weight[v,u]))   // 理想距離
      d ← dist(pos[v], pos[u])
      ratio ← d / δ
      Fx += ratio * (pos[u].x - pos[v].x)
      Fy += ratio * (pos[u].y - pos[v].y)

    // ── 斥力（所有頂點對）──
    for each u ≠ v in V′：
      d ← dist(pos[v], pos[u])
      // 無邊時 δ 取 sqrt(L * 1)（吞 0 站）
      δ ← sqrt(L * (if (v,u)∈E′ then min(W,weight[v,u]) else 1))
      ratio ← δ² / d²
      Fx -= ratio * (pos[u].x - pos[v].x)
      Fy -= ratio * (pos[u].y - pos[v].y)

    // ── 頂點×不相鄰邊斥力（PrEd，式 2）──
    for each edge (a,b) ∈ E′ where v ∉ {a,b}：
      t ← dot(pos[v]-pos[a], pos[b]-pos[a]) / |pos[b]-pos[a]|²
      if 0 < t < 1：                          // 投影點落在線段內
        i_v.x ← pos[a].x + t*(pos[b].x-pos[a].x)
        i_v.y ← pos[a].y + t*(pos[b].y-pos[a].y)
        dvi ← dist(pos[v], i_v)
        if dvi < γ：
          coeff ← (γ - dvi)² / dvi
          Fx -= coeff * (i_v.x - pos[v].x)
          Fy -= coeff * (i_v.y - pos[v].y)

    // ── 磁場力（式 4，每條鄰接邊僅取最近方向）──
    for each u ∈ neighbors(v) in G′：
      edge_dx ← pos[u].x - pos[v].x
      edge_dy ← pos[u].y - pos[v].y
      edge_len ← sqrt(edge_dx² + edge_dy²)
      edge_angle ← atan2(edge_dy, edge_dx)
      // 8 個磁場方向：k*45°（k=0..7）
      nearest_k ← round(edge_angle / (π/4)) mod 8
      target_angle ← nearest_k * π/4
      θ ← |angle_diff(edge_angle, target_angle)|  // ∈ [0, π/8]
      F_m ← c_m * b * edge_len^α * θ^β
      // 磁場力方向：垂直於邊，轉向 target_angle
      cross_sign ← sign(sin(target_angle - edge_angle))
      perp_x ← -edge_dy / edge_len * cross_sign
      perp_y ←  edge_dx / edge_len * cross_sign
      // v 受 -F_m * perp，u 受 +F_m * perp（力偶，純旋轉，兩端反向）
      Fx += -F_m * perp_x
      Fy += -F_m * perp_y
      // u 的磁場力：在 u 的迭代中計算（對稱地反向施加）

    // ── PrEd 8 區域移動上限（見關鍵子計算 §5.1）──
    (Fx, Fy) ← clip_by_pred_zones(v, Fx, Fy)

    pos[v].x += Fx
    pos[v].y += Fy
  end for
end for

──────────────────────────────────────────────────
STEP 4：回插 deg-2 頂點
──────────────────────────────────────────────────
for each 簡化邊 (a,b) with deg2_chains[a,b] = [v_1, v_2, ..., v_k]：
  // 最終佈局中 (a,b) 就是一條直線段（G′ 的邊在最終座標中）
  total_len ← dist(pos[a], pos[b])
  for i = 1 to k：
    t ← i / (k+1)           // 等距弧長參數
    pos[v_i].x ← pos[a].x + t*(pos[b].x - pos[a].x)
    pos[v_i].y ← pos[a].y + t*(pos[b].y - pos[a].y)
end for

輸出 pos[v] 對所有 v ∈ V（原始圖的所有頂點）
```

### 5. 關鍵子計算

#### 5.1 PrEd 8 區域移動上限（clip_by_pred_zones）

PrEd 的核心保嵌入機制：對頂點 `v`，把它周圍空間切成 8 個扇形（每個 45°），對每條不相鄰邊計算「v 在此方向移動多遠就會穿越該邊」，取最小值作為該方向的移動上限。

```
clip_by_pred_zones(v, Fx, Fy)：
  max_dist[dir] ← ∞  for dir = 0..7  // 8 方向（每 45°）

  for each edge (a,b) ∈ E′ where v ∉ {a,b}：
    // 8 個方向向量：dir_vec[k] = (cos(k*45°), sin(k*45°))
    for dir = 0..7：
      dv ← dir_vec[dir]
      // 求 pos[v] + t*dv 與直線 ab 的交點（求 t > 0）
      // 直線 ab：法向 n = rot90(pos[b]-pos[a])，方程 dot(p-pos[a], n) = 0
      n ← (-( pos[b].y - pos[a].y ), pos[b].x - pos[a].x)
      denom ← dot(dv, n)
      if |denom| < ε：continue  // 平行，無交叉
      t ← dot(pos[a] - pos[v], n) / denom
      if t <= 0：continue  // 交點在反向
      // 確認交點在線段 (a,b) 內
      p_cross ← pos[v] + t * dv
      s ← dot(p_cross - pos[a], pos[b]-pos[a]) / |pos[b]-pos[a]|²
      if 0 ≤ s ≤ 1：
        max_dist[dir] ← min(max_dist[dir], t)

  // 把合力 (Fx, Fy) 分解到 8 方向，各分量截斷
  // 簡化做法：把 (Fx,Fy) 投影到最近方向並截斷
  move_len ← sqrt(Fx²+Fy²)
  if move_len = 0：return (0,0)
  dir_k ← round(atan2(Fy,Fx) / (π/4)) mod 8
  limit ← max_dist[dir_k]
  if move_len > limit：
    scale ← limit / move_len
    Fx ← Fx * scale；Fy ← Fy * scale
  return (Fx, Fy)
```

#### 5.2 磁場力偶方向推導

```
確定旋轉方向（cross_sign）的規則：
  target_angle = nearest_k * 45°（以弧度）
  delta = target_angle - edge_angle
  // 正規化到 (-π, π]
  while delta >  π：delta -= 2π
  while delta < -π：delta += 2π
  cross_sign = sign(delta)  // +1 → 逆時針旋轉邊；-1 → 順時針

施力符號確認：
  – v 受 (-F_m * perp_x, -F_m * perp_y)（把 v 推向使邊轉動的方向）
  – u 受 (+F_m * perp_x, +F_m * perp_y)（反向等大）
  – 合力為零（純力偶），不平移整條邊，只旋轉
```

#### 5.3 理想距離 δ 的計算

```
對邊 (u,v) 帶權 w = weight[u,v]：
  δ(u,v) = sqrt(L * min(W, w))

物理意義：
  w = 0（端對端，無吞掉站）→ δ = sqrt(L) ≈ 0.4
  w = 1（吞 1 站）         → δ = sqrt(2L) ≈ 0.57
  w = 25（上限，吞 ≥25站） → δ = sqrt(26L) ≈ 2.04
  比例約為 1 : 1.4 : 5——吞越多站的邊，理想長度越長，回插時才能均勻放下。
```

---

## 1. 問題定義

**metro map graph**：圖 G + 一組路徑（lines），每條線是站的序列，共同覆蓋所有頂點與邊（一站/邊可屬多線，但至少屬一線）。
輸出：G 的「好」佈局，準則：

- C1：每條線盡量直。
- C2：無邊交叉。
- C3：標籤不重疊。
- C4：線大多水平/垂直，少數 45°。
- （C5 每線一色：本論文不處理，視為繪製問題。）

本方法的定位：**快**（雪梨全網數秒級），品質接近手繪但不保證嚴格八方向、不保證站在格點——用連續空間的力平衡逼近，而非離散最佳化。適合當互動預覽或其他方法的初始解。

### 三個基礎演算法（本方法是它們的組合）

1. **GEM**（Frick et al.）：彈簧模型 + 每頂點局部溫度/skew gauge 的冷卻控制。每輪隨機選頂點，算斥力（所有頂點對）+ 引力（鄰接邊），依該頂點溫度決定移動距離；偵測到振盪/旋轉就降溫，方向一致就升溫。
2. **PrEd**（Bertault）：**保嵌入**的力導向——最終佈局的邊環繞順序與輸入相同。除了頂點斥力、邊引力，還加「頂點×不相鄰邊」斥力；並且每輪把每個頂點周圍分成 8 個區域（zone），依鄰近的不相鄰邊縮小各區域可移動半徑，**保證頂點不會跨越任何邊**（拓撲不變的機制就在這裡）。
3. **磁力彈簧**（Sugiyama & Misue）：磁場向量把邊「轉」向指定方向的力。

---

## 2. 五個方法（遞進式，Method 5 是最終方案）

```
Method 1: 直接 GEM（僅當 baseline）
Method 2: 前處理簡化 → GEM（帶邊權）→ 回插
Method 3: 前處理簡化 → GEM（不帶權）→ 改良版 PrEd（帶邊權）→ 回插
Method 4: Method 3 + 正交（上下左右）磁場力
Method 5: Method 4 + 45° 對角磁場力   ← 最佳，實作這個
```

### Method 5 完整流程

```
(1) 簡化：從 G 移除所有度 2 頂點得 G′（只留轉乘站與端點站；
    注意自環與重邊的特殊處理）
(2) 初始佈局：對 G′ 跑 GEM（不帶邊權）
(3) 精修：對 G′ 跑改良版 PrEd——帶邊權 + 正交磁場 + 45° 磁場
(4) 回插：把移除的度 2 頂點沿 L″ 中對應邊等距擺回，得最終佈局 L
```

**為何先簡化**：度 2 頂點不影響嵌入/拓撲，卻佔大量計算；簡化後力模型只需擺好骨架。**邊權**記錄每條簡化邊吞掉幾個度 2 頂點，讓吞得多的邊拉得長，回插時才擺得下。

---

## 3. 力模型（改良版 PrEd）

以下都寫 x 分量，y 分量同型。

### 3.1 引力與斥力（式 1）——帶理想邊長

```
F_a_x(u,v) =  d(u,v)/δ(u,v) · (x(v) − x(u))          # 相鄰頂點引力
F_r_x(u,v) = −δ(u,v)²/d(u,v)² · (x(v) − x(u))        # 所有頂點對斥力
```

`d(u,v)` = 目前距離；`δ(u,v)` = **理想距離**：

```
δ(u,v)² = L · min(W, weight(u,v))
```

- `weight(u,v)` = 該簡化邊吞掉的度 2 頂點數（重邊取最大權）。
- `L` 控制整體比例，`W` 是邊權上限（避免超長路徑把圖撐爆）。
- 論文用值：**L = 0.16, W = 25.0**。W 太小 → 中心擠成一團；W 太大 → 多站路徑被過度壓縮。

### 3.2 頂點×邊斥力（式 2）——PrEd 原版

對頂點 v 與不相鄰邊 (a,b)：設 i_v 為 v 在直線 ab 上的投影點，若 i_v 落在線段內且 d(v,i_v) < γ：

```
F_e_x(v,(a,b)) = −(γ − d(v,i_v))²/d(v,i_v) · (x(i_v) − x(v))
```

否則為 0。γ = 頂點與不相鄰邊的期望距離，論文用 **γ = 100.0**。這個力把頂點推離邊，配合 PrEd 的 8 區域移動限制防止拓撲翻轉。

### 3.3 磁場力（式 4）——八方向對齊的來源

磁場向量集合：Method 4 用 4 個正交向量（上、下、左、右）；Method 5 再加 4 個對角（↗↙↘↖），共 8 個。

每條邊 (u,v) **每一時刻只受一個磁場力**：選與該邊夾角 θ 最小的磁場向量，力量：

```
F_m(u,v) = c_m · b · d(u,v)^α · θ^β
```

- 力的方向**垂直於邊**（旋轉邊，而非拉伸）；對 u 施 +F_m、對 v 施 −F_m（等大反向 → 純旋轉力偶）。
- 論文用值：**c_m = 0.1, b = 30.0, α = 1.0, β = 0.5**。
- b、c_m 控制磁力相對其他力的權重：太低 → 邊不對齊八方向；太高 → 對齊了但犧牲其他美觀。
- β 越高越忽略小角度誤差（收斂後殘留歪斜）；β = 0.5 使小角度也有足夠矯正力。

### 3.4 合力（式 5）

```
F_x(v) = Σ F_a_x(u,v)          # 對每條鄰接邊
       + Σ F_r_x(u,v)          # 對每個其他頂點
       + Σ F_e_x(v,(a,b))      # v 對每條不相鄰邊
       − Σ F_e_x(u,(v,w))      # v 的鄰接邊被其他頂點斥 → 反作用力
       + Σ F_m_x(u,v)          # v 的每條鄰接邊的磁場力
```

迭代：每輪對每個頂點算合力、依 PrEd 的 8 區域限制截斷移動量、更新位置；跑固定輪數或力量收斂為止。

---

## 4. 保留地理嵌入的變體（§3.5）

把步驟 (2) 的 GEM 換成「直接用真實經緯度當初始佈局」。因為 PrEd 保嵌入，之後整個過程邊的環繞順序與交叉都與地理版一致——輸出自然保有地理心智地圖。**捷運應用建議直接用這個變體**（拓撲即地理拓撲，不必依賴 GEM 的隨機初始）。

---

## 5. 標籤（§4）——事後組合式貼標

與佈局分離的第二階段（這是本法的弱點：佈局沒為標籤預留空間）：

1. **八位置模型**：每站 8 個候選標籤位（4 正交 + 4 對角，圖 5）。實證觀察：**45° 對角標籤視覺上最舒服**，優先採用。
2. **衝突圖**：每個候選位一個頂點；兩候選位在圖面上重疊 → 連邊；同一站的 8 個候選位互為 clique；每頂點帶偏好成本。
3. 求衝突圖的**最小成本最大獨立集**（NP-hard，用模擬退火 + 貪婪啟發式，論文的 LabelHints 系統）；獨立集中的候選位就是採用的標籤位，沒有任何候選位入選的站不貼標。

---

## 6. 效能參考

3.0 GHz Pentium 4、Java：雪梨 CityRail 全網（數百頂點）**7.6 秒**。比 MILP（小時級）、爬山（小時級）快 2–3 個數量級；代價是：邊只是「接近」八方向而非嚴格對齊、站距不均、站不在格點上。

---

## 7. 實作檢查清單與陷阱

1. **一定要做度 2 簡化**（Method 1 vs 2 的差距極大）；簡化時記邊權，處理自環（線的迴圈端）與重邊（多線共走）。
2. **回插是等距擺回**：沿最終佈局的邊（折線）按弧長均分。
3. **邊權要設上限 W**：否則吞了 30 站的邊會要求 30 倍長，圖被撐爆。
4. **磁場力每邊只取最近方向那一個**，不是 8 個都施；方向垂直於邊、兩端反向。
5. **PrEd 的移動限制不可省**——只靠頂點×邊斥力「不鼓勵但不保證」不跨邊；8 區域半徑限制才是拓撲保證。若自己實作：對每個頂點 v 與每條不相鄰邊，計算 v 沿 8 個方向各可移動多遠而不越過該邊，取每方向最小值作為該方向移動上限。
6. **力的量級要平衡**：引/斥力、頂點邊斥力（γ）、磁力（c_m·b）三組互相競爭。用論文參數起步（L=0.16, W=25, γ=100, c_m=0.1, b=30, α=1, β=0.5），再按圖面大小縮放。
7. GEM 初始佈局有隨機性；要可重現或要保地理，用 §4 的地理初始 + PrEd（跳過 GEM）。
8. 本法**不產生嚴格八方向**。若下游需要嚴格對齊（如吸附格網），把本法輸出當初始解餵給 MILP/SAT/爬山等離散方法。
9. 標籤是事後貼的，密集區可能無解（不貼標）——這是與 Stott（標籤入爬山迴圈）和 Nöllenburg（標籤入 MILP）的本質差距，論文自己也列為缺點。

## 8. 建議參數

| 參數 | 論文值 | 作用 |
|---|---|---|
| L | 0.16 | 整體比例 |
| W | 25.0 | 邊權上限（最長理想邊） |
| γ | 100.0 | 頂點×邊期望距離 |
| c_m | 0.1 | 磁力總權重 |
| b | 30.0 | 磁場強度 |
| α | 1.0 | 磁力的邊長指數 |
| β | 0.5 | 磁力的角度指數 |
| 磁場向量 | 8（4 正交 + 4 對角） | 八方向對齊 |
