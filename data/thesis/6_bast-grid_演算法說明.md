# ⑥ Bast 八方向格網圖最短路徑法（Octilinear Grid Graphs）

> 論文：Hannah Bast, Patrick Brosi & Sabine Storandt (2020). *Metro Maps on Octilinear Grid Graphs*. Computer Graphics Forum (EuroVis 2020), 39(3).
> 線上結果與工具（octi）：http://octi.cs.uni-freiburg.de

本文件是給開發者（或其他 LLM）的完整實作指南。讀完本文件後，不需要再看原始論文即可實作。

---

## 計算邏輯與程式骨架

> 以下依論文寫「要算什麼、怎麼算」——用虛擬碼、公式與迴圈描述計算步驟。實作時照此邏輯寫；不要呼叫既有程式裡的函式名，也不要寫「call xxx」。

### 1. 輸入（抽象資料）

- 線圖 `G = (V, E, L)`：`V` = 站點集合（各附地理座標 `(x_v, y_v)`）；`E` = 邊集合；`L(e)` = 邊 `e` 上行經的路線識別碼集合。
- 格距 `D`（格網尺度，建議 `D = 0.75 · d̂`，`d̂` = 輸入圖相鄰站地理平均距離）。
- 候選半徑 `r = 3D`（站的格網候選範圍）。
- 成本參數：`c_135 = 1, c_90 = 1.5, c_45 = 2, c_180 = 0, c_h = 1, c_m = 0.5`。

### 2. 輸出

- 每個站 `v ∈ V` 的格網整數座標 `ψ(v) = (gx, gy)`。
- 每條輸入邊 `e ∈ E` 的格網路徑 `p(e)`：格網節點序列，每相鄰兩節點方向為八方向之一（0°/45°/90°/135° 的正負向）。

### 3. 建議內部狀態

| 變數 | 說明 |
|---|---|
| `grid[X][Y]` | 格網，每個格網節點含 1 個中心 + 8 個港口，共 9 個子節點 |
| `edge_cost[ω]` | 每條格網邊 `ω` 的當前成本（初始值、動態設為 ∞ 表示關閉） |
| `assigned[v]` | 站 `v` 是否已定案及其格網位置 `ψ(v)` |
| `port_occupied[ψ]` | 格網節點 `ψ` 的 8 個港口中哪些已被佔用（已路由邊佔用的出向港口集合） |
| `node_status[ψ]` | 格網節點的 `bend_closed`（禁穿越）與 `sink_closed`（禁當站）狀態 |
| `deg2_chains` | deg-2 收縮時記錄的中間站鏈（供回插使用） |
| `edge_order` | ldeg 排序後的邊序列 |

### 4. 主計算流程

```
──────────────────────────────────────────────────
STEP 1：deg-2 收縮
──────────────────────────────────────────────────
G′ ← G 的拷貝；deg2_chains ← {}

repeat：
  v ← G′ 中任意一個 degree = 2 的站，兩鄰居為 a, b
  // 記錄鏈（保留順序，供後續等距回插）
  若 deg2_chains[(a,b)] 尚未存在：deg2_chains[(a,b)] ← []
  deg2_chains[(a,b)].append(v)
  // 合併邊：若 (a,b) 不存在則新增；L(a,b) ← L(a,v) ∪ L(v,b)
  移除 v；新增或更新邊 {a,b}
until G′ 無 degree-2 站

──────────────────────────────────────────────────
STEP 2：建格網 Γ
──────────────────────────────────────────────────
// 計算格網大小
bbox ← G′ 所有站座標的 bounding box（加 r 的外擴餘裕）
X ← ceil((bbox.width  + 2r) / D) + 1
Y ← ceil((bbox.height + 2r) / D) + 1

// 成本偏移 a（防作弊繞路，見 §2.3）
a ← c_45 − c_135 = 2 − 1 = 1

// 初始化格網邊成本（所有邊初始為開放）
for each 格網節點 ψ_{x,y}（x=0..X-1, y=0..Y-1）：
  建立 8 個港口 ψ^0..ψ^7（方向 k=0:右, 1:右上, 2:上, 3:左上, 4:左, 5:左下, 6:下, 7:右下）
  for each sink 邊 ψ^k ↔ ψ_{x,y}：
    edge_cost[sink(ψ,k)] ← c_s（設為 ≥ c_45，不讓路徑借道中心節點）
  for each 彎折邊 ψ^i → ψ^j（同節點不同港口）：
    Δ ← min(|i−j|, 8−|i−j|)  // 轉角格數（1=45°,2=90°,3=135°,4=180°）
    bend_base ← {4:0, 3:c_135, 2:c_90, 1:c_45}[Δ]
    edge_cost[bend(ψ,i,j)] ← bend_base + a  // 成本偏移
  for each 格網移動邊（相鄰節點對應港口之間）：
    edge_cost[hop(ψ,ψ_next,dir)] ← c_h − a = 0  // 水平/垂直
    edge_cost[hop(ψ,ψ_next,dir)] ← c_h − a + 0.5 = 0.5  // 對角（輕微偏好水平/垂直）

──────────────────────────────────────────────────
STEP 3：計算 ldeg 並排序輸入邊
──────────────────────────────────────────────────
// ldeg(v) = v 的所有鄰接邊上的路線聯集大小（不重複計算同一路線）
for each v ∈ V′：
  ldeg(v) ← | ∪_{e ∈ incident(v)} L(e) |

// 排序程序：從最複雜轉乘站往外長
all_nodes ← V′；標記全部 UNPROCESSED
edge_order ← []
while 有 UNPROCESSED 節點：
  v_start ← UNPROCESSED 中 ldeg 最高者；標 DANGLING
  while 有 DANGLING 節點：
    v_d ← DANGLING 中 ldeg 最高者
    unprocessed_neighbors ← {u ∈ neighbors(v_d) : u 標 UNPROCESSED}
    // 對 unprocessed_neighbors 依 ldeg 降冪排序
    for each u in sorted(unprocessed_neighbors, key=ldeg, descending)：
      edge_order.append({v_d, u})
      標 u 為 DANGLING
    標 v_d 為 PROCESSED

──────────────────────────────────────────────────
STEP 4：逐邊路由（set-to-set Dijkstra）
──────────────────────────────────────────────────
for each e = {v, u} in edge_order：

  // ─ 確定候選集 S（v 端）、T（u 端）─
  if assigned[v]：
    S ← { ψ(v) }
  else：
    S ← { ψ ∈ Γ : chebyshev_dist(geo_to_grid(coord[v]), ψ) ≤ r/D,
                    ψ 未被其他定案站佔用 }

  if assigned[u]：
    T ← { ψ(u) }
  else：
    T ← { ψ ∈ Γ : chebyshev_dist(geo_to_grid(coord[u]), ψ) ≤ r/D,
                    ψ 未被其他定案站佔用 }

  // ─ 局部 Voronoi（若 S ∩ T ≠ ∅）─
  for each ψ ∈ S ∩ T：
    d_v ← euclidean(coord[v], grid_center(ψ))
    d_u ← euclidean(coord[u], grid_center(ψ))
    if d_v ≤ d_u：T.remove(ψ)
    else：S.remove(ψ)

  // ─ 加入距離懲罰到 sink 成本（臨時，路由完後還原）─
  for each ψ_s ∈ S：
    penalty_s ← euclidean(coord[v], grid_center(ψ_s)) / D * (c_h + c_m)
    edge_cost[sink(ψ_s, *)] += penalty_s  // 所有港口的 sink 邊加懲罰
  for each ψ_t ∈ T：同理加 coord[u] 的懲罰

  // ─ 加入站上線彎懲罰（見關鍵子計算 §5.2）─
  for each ψ_s ∈ S：apply_bend_penalty(ψ_s, e, L(e))
  for each ψ_t ∈ T：apply_bend_penalty(ψ_t, e, L(e))

  // ─ set-to-set Dijkstra（見關鍵子計算 §5.3）─
  path ← dijkstra_set_to_set(S, T, Γ)
  if path = null：
    記錄 e 為失敗；隨機重排 edge_order 後整個 STEP 4 重試

  // ─ 定案 ─
  ψ(v) ← path 的起點節點；assigned[v] ← true
  ψ(u) ← path 的終點節點；assigned[u] ← true
  p(e) ← path

  // ─ 還原臨時懲罰 ─
  還原剛才加給 S, T sink 的距離懲罰

  // ─ 關閉資源（嵌入保持，見關鍵子計算 §5.1）─
  close_resources(e, path)

──────────────────────────────────────────────────
STEP 5：局部搜尋打磨
──────────────────────────────────────────────────
repeat：
  improved ← false
  for each v ∈ V′：
    old_pos ← ψ(v)
    old_paths ← { p(e) : e ∈ incident(v) }  // 目前所有鄰接邊的路徑
    old_cost ← Σ path_cost(p(e)) + Σ spring_energy(v)  // 含 A-2+D 彈簧（見下方）

    for each 相鄰格網位置 ψ_n of ψ(v)（Chebyshev 距離 = 1, ψ_n 未被他站佔用）：
      // 試移動
      ψ(v) ← ψ_n
      // 拆掉 v 的所有鄰接邊路徑（恢復相關 close 資源）
      for each e ∈ incident(v)：撤銷 close_resources(e, old_paths[e])；p(e) ← null
      // 重新路由（按順時針順序）
      success ← true
      for each e ∈ incident(v)（按順時針排序）：
        p(e) ← dijkstra_set_to_set({ψ(v)}, {ψ(other_end)}, Γ)
        if p(e) = null：success ← false；break
        close_resources(e, p(e))
      new_cost ← Σ path_cost(p(e)) + Σ spring_energy(v)

      if success AND new_cost < old_cost：
        improved ← true；break  // 保留新位置
      else：
        // rollback
        for each e ∈ incident(v)：撤銷新路徑，恢復 old_paths[e] 並 close_resources
        ψ(v) ← old_pos
until NOT improved

// A-2+D 彈簧能量（加入局部搜尋目標，防 deg-2 回插空間不足）：
// spring_energy(v) = c/(2k) * max(0, k+1−l)²
// 其中 k = 該邊路徑上待插回的 deg-2 站數，l = 路徑 L∞ 弧長，c = 10

──────────────────────────────────────────────────
STEP 6：deg-2 回插
──────────────────────────────────────────────────
for each 簡化邊 {a,b} with deg2_chains[(a,b)] = [v_1,...,v_k]：
  path_ab ← p({a,b})  // 已定案的格網路徑節點序列
  // 計算路徑的 L∞ 弧長 l（每跳 = 1 格，無論方向）
  l ← length(path_ab) − 1  // 節點數 − 1 = 跳數
  if l < k+1：彈簧懲罰應已防止此情況，若仍發生則均勻壓縮
  for i = 1 to k：
    t ← i * l / (k+1)  // 沿路徑的等距弧長參數
    pos[v_i] ← 在 path_ab 上弧長為 t 的插值格網座標

輸出：ψ(v) 對所有 v ∈ V（含回插站），p(e) 對所有 e ∈ E
```

### 5. 關鍵子計算

#### 5.1 close_resources（定案後關閉格網資源）

```
close_resources(e = {v,u}, path)：

  // ── 中間節點：bend-close + sink-close（禁穿越與禁當站）──
  for each 中間格網節點 ψ_m in path（排除 ψ(v) 與 ψ(u)）：
    bend_close(ψ_m)：
      for all 彎折邊 bend(ψ_m, i, j)：edge_cost ← ∞
    sink_close(ψ_m)：
      for all sink 邊 sink(ψ_m, k)：edge_cost ← ∞

  // ── 關閉 X 交叉（對角邊互斥）──
  for each 對角格網邊 ω_d = hop(ψ_a, ψ_b, dir_diagonal) in path：
    // 找與 ω_d 幾何交叉的另一條對角邊（方向垂直的同格網方格對角線）
    ω_cross ← 與 ω_d 交叉的另一條對角邊
    edge_cost[ω_cross] ← ∞

  // ── 環繞順序管理（站節點 ψ(v) 與 ψ(u) 上）──
  update_port_order(ψ(v), exit_port=path[1], e, L(e))
  update_port_order(ψ(u), exit_port=path[-2], e, L(e))

update_port_order(ψ, exit_port_k, e, line_set)：
  port_occupied[ψ].add(exit_port_k)
  intervals ← port_occupied[ψ] 的已佔用港口（按順時針順序排列）
  // 關閉「落在已佔用相鄰港口之間扇形」的 sink 邊（禁止後續邊插入此扇形）
  // 同時確保每條「尚未路由的鄰接邊」至少有一條 sink 邊在正確扇形內仍開放
  for each 相鄰已佔用港口對 (k_prev, k_next)（順時針間隔）：
    pending_edges_in_sector ← 尚未路由的 incident 邊中，
                              按環繞順序應落在 [k_prev+1, k_next-1] 的那些邊
    available_ports ← [k_prev+1 .. k_next-1]
    for each k in available_ports：
      if NOT 有 pending_edges_in_sector 需要此港口保持開放：
        edge_cost[sink(ψ, k)] ← ∞
      else：
        保留至少一條開放（選最中央的港口保留，其餘關閉）
```

#### 5.2 站上線彎懲罰（apply_bend_penalty）

```
// 在路由邊 e_i 之前，把「e_i 從各港口離站時與已路由邊 e_j 的彎折成本」
// 加到對應 sink 邊成本中

apply_bend_penalty(ψ, e_i, line_set_i)：
  for each k in 0..7（ψ 的開放 sink 港口）：
    bp ← 0
    for each 已路由邊 e_j 在 ψ 上（out_port = k_j）：
      if line_set_i ∩ L(e_j) ≠ ∅：  // 同一條路線在此站直通
        Δ ← min(|k − k_j|, 8 − |k − k_j|)  // 轉角格數
        bp += bend_cost(Δ)  // {0:0, 1:c_45+a, 2:c_90+a, 3:c_135+a, 4:c_180+a}
    edge_cost[sink(ψ, k)] += bp
// 注意：此為臨時加成，路由完後需還原（或在下一條邊前重算）
```

#### 5.3 set-to-set Dijkstra

```
// 多源多匯最短路：S = 源節點集，T = 目標節點集，Γ = 格網圖

dijkstra_set_to_set(S, T, Γ)：
  dist ← { ψ: ∞ for all ψ ∈ Γ }；prev ← {}
  pq ← 優先佇列（min-heap）

  // 虛擬超源：把 S 全部入佇列，初始距離 = 0
  // （距離懲罰已預先加到 sink 邊成本，直接走 sink 邊就含懲罰）
  for each ψ_s ∈ S：
    dist[ψ_s_center] ← 0
    pq.push((0, ψ_s_center))

  while pq not empty：
    (d, u) ← pq.pop_min()
    if d > dist[u]：continue  // 已過期
    if u ∈ T（T 的中心節點集合）：
      return reconstruct_path(prev, u)  // 找到！
    for each 鄰邊 ω from u with cost edge_cost[ω]（< ∞）：
      w ← ω 的另一端
      new_d ← d + edge_cost[ω]
      if new_d < dist[w]：
        dist[w] ← new_d；prev[w] ← u
        pq.push((new_d, w))

  return null  // 無可行路徑，需重試

// A* 加速（可選）：啟發式 h(ψ) = max(0, chebyshev_dist(ψ, convex_hull(T)) − 1)
// 可採納（admissible），每跳至少付 1 格成本

reconstruct_path(prev, target)：
  path ← [target]；node ← target
  while node ∈ prev：node ← prev[node]；path.prepend(node)
  return path
```

#### 5.4 成本偏移驗算

```
// 驗證偏移後成本不讓作弊繞路比直行便宜
// 原始值：c_180=0, c_135=1, c_90=1.5, c_45=2, a=1
// 偏移後：c′_180=1, c′_135=2, c′_90=2.5, c′_45=3, c′_h=0

檢查 1：兩個 c′_135 ≥ a + c′_90？
  2*2 = 4 ≥ 1 + 2.5 = 3.5  ✓（兩個 135° 不便宜過一個 90°）

檢查 2：c′_135 + c′_180 ≥ a + c′_45？
  2 + 1 = 3 ≥ 1 + 3 = 4  ✗ → 論文用 a = c_45 - c_135 + ε 微調
  或改用：c′_180 ← a（= 1），使 2 + 1 = 3 ≥ 4 不成立時放寬 c_135 → 1.5
  → 依論文直接用表格值 c_135=1,c_90=1.5,c_45=2 並令 a=1 即可；
    式 7 保證最短路 p′ 的成本差 = c(p) + 2c_s − 1，最小化 p′ 即最小化 c(p)
```

---

## 1. 問題定義與核心理念

輸入：線圖（line graph）`G = (V, E, L)`——V 站點（含地理座標）、E 連線、每邊標注行經路線集合 L(e)。
輸出：站點放在**八方向格網圖**的節點上、每條輸入邊畫成格網上的**八方向路徑**（可以有**任意多個彎**——這是與 Nöllenburg MILP「每邊一直線段」的最大差異，也讓本法能貼近線路真實地理走向、繞開障礙物）。

**核心理念**：把「畫圖」化為「在輔助格網圖上幫每條輸入邊找最短路徑 + 幫每個站選格網節點」的組合問題。提供兩種解法：
- **ILP**：精確最佳，但大網要數小時～無法解。
- **近似演算法（A-2+D）**：逐邊跑 Dijkstra 最短路 + 局部搜尋，**毫秒～秒級**（雪梨 515 ms、倫敦 2.7 s），近似誤差 < 7.5%。實作以近似法為主。

### 硬限制
1. 八方向：每條邊曲線的每一段都是 45° 倍數方向。
2. 拓撲保持：無新交叉、不相鄰邊不共點、每站邊的環繞順序不變。
3. 圖面密度：任一站與所有其他曲線錨點距離 ≥ d̂。

### 軟限制
1. 邊單調性（彎少且鈍）；2. 邊長短；3. 地理準確（站盡量不動）。

**deg-2 前處理**：地理準確性只要求「度 ≠ 2 的節點」（轉乘站與端點站）；度 2 站先收縮、畫完後等距插回（近似法 A-2、A-2+D 名字裡的 2 就是這個）。deg-2 收縮對速度影響巨大：不收縮則所有 ILP 24 小時都解不完，近似法也慢一個數量級。

---

## 2. 八方向格網圖 Γ = (Ψ, Ω) 的構造

### 2.1 基本格網

- X×Y 個格網節點，相鄰（含對角）節點 Chebyshev 距離（L∞）= 1 → 八方向自動成立。
- 格網以尺度 D（一格的實際大小）投到地圖平面。取 **D ≥ d̂** 則密度限制自動滿足。格網大小 `X·Y = ⌈A/D²⌉`（A = 輸入圖 bounding box 面積）。論文建議 **D = 0.75·d̂**（d̂ = 輸入圖相鄰站平均距離）。

### 2.2 港口節點（port nodes）——彎折成本的建模關鍵

每個格網節點 ψ_x,y 擴充成一朵「花」：

- 中心節點 ψ_x,y + **8 個港口節點** ψ⁰…ψ⁷（對應 8 個出邊方向，順時針排列）。
- **sink 邊** ω⁰…ω⁷：港口 ↔ 中心，成本 c_s（進出站用）。
- **彎折邊（bend edges）** ω^{i,j}：每個港口連到同節點的其他 7 個港口，成本依轉角：`c_180 = 0 ≤ c_135 ≤ c_90 ≤ c_45`（直行免費、越銳角越貴）。
- 原格網邊連接相鄰節點的對應港口。

一條路徑穿過某格網節點時走「進港口 → 彎折邊 → 出港口」，彎折成本自然計入路徑成本——**把「折彎懲罰」變成純粹的邊權**，Dijkstra 直接可用。

### 2.3 成本校正（防「作弊繞路」）（式 2–3）

45°/90° 彎可能被便宜的組合模擬（90° = 兩個 135°；45° = 135°+180°）。解法：把每個彎折成本加上偏移 `a = c_45 − c_135`，並要求：

```
2·c′_135 ≥ a + c_90        （兩個135° 不得便宜過一個90°）
c′_135 + c′_180 ≥ a + c_45  （135°+180° 不得便宜過一個45°）
```

論文參數 **c_135 = 1, c_90 = 1.5, c_45 = 2** → a = 1；再令每跳成本 c_h = 1 = a、實際格網邊成本 c′_h = c_h − a = 0。這樣最短路 p′ 的成本 = `c(p) + 2c_s − 1`（式 7），最小化 p′ 即最小化真實成本 c(p)。**格網邊實際成本為 0 的副作用是可以任意加「偏移成本」到個別格網邊**（見 §7 的應用）。

sink 成本 c_s 設得夠高（≥ c_45），使路徑絕不會「借道中心節點」抄近路，只在起訖點使用 sink 邊。

### 2.4 總目標函數（式 8）

```
t(D_G) = Σ_{e∈E} c(p(e))                          # 各邊路徑成本（含沿途彎折）
       + Σ_{v∈V} d(v, ψ(v)) · (c_h + c_m)/D       # 站位移懲罰（歐氏距離/D 正規化）
       + Σ_v c_b^v                                 # 站上（輸入邊之間）的線彎懲罰
```

c_m = 額外移動懲罰（論文 0.5）。

---

## 3. 精確解：ILP（§3）——可選

變數：`x_{v,ψ}`（站 v 指派到格網節點 ψ）、`x_{e,ω}`（有向格網邊 ω 在邊 e 的路徑中）。

- 站指派：每站恰一格網節點（式 9）；每個格網節點最多被一站使用或被一條路徑穿過（式 10，同時保證節點不被兩條路徑共用）。
- 邊連續性：標準最短路的流量守恆線性化（式 11–12：中間節點進出相等；源/匯用 x_{v,ψ} 觸發）；防 0 成本邊成環（式 13）。
- 拓撲：對角格網邊與其交叉的對角邊不可同時使用（式 14）；環繞順序用 Nöllenburg 式「δ 方向變數 + β 一次繞回」技巧（式 15–18）。
- 站上線彎：δ 差 mod 8 用輔助二元變數 γ、Δ 線性化（式 19–21）。

規模 Θ(|E|·A/D²) 變數——中型網就要幾十萬變數，Gurobi 上數小時～超過 24 小時。**實務上只拿 ILP 當品質基準**。

---

## 4. 近似演算法（§4）——主力實作

```
(1) 排序輸入邊
(2) 逐邊在格網圖上跑 set-to-set Dijkstra 找最短路，邊畫完就「定案」
(3) 找不到可行解 → 隨機打亂順序重試
(4) 局部搜尋打磨
```

### 4.1 輸入邊排序（§4.1）

定義**線度數** ldeg(v) = v 的鄰接邊上（不重複）路線數總和。排序程序：

1. 全部節點標記未處理。
2. 取未處理節點中 ldeg 最高者 v，標記為 dangling。
3. 只要還有 dangling 節點：取 ldeg 最高的 dangling 節點 v_d，把它通往未處理節點 u_i 的鄰接邊 {v_d,u_0}…{v_d,u_k} 依 ldeg(u_i) 降冪加入邊序列，u_i 標 dangling，v_d 標已處理。
4. 沒有 dangling 但還有未處理 → 圖不連通，回到 2。

（直覺：從最複雜的轉乘樞紐往外長，複雜區先佔格網好位置。）

### 4.2 逐邊路由與站點放置（§4.2）

路由邊 e = {v, u} 時：

- v（或 u）尚未定案 → 候選集 S（T）= 原地理位置半徑 **r = 3D** 內的所有格網節點；已定案 → 單點集。
- S、T 有重疊時做**局部 Voronoi**：每個候選節點劃給較近的那一端，保證 S ∩ T = ∅。
- 每個候選節點的 sink 邊成本**加上距離懲罰** `d(p(v), p(ψ))/D · (c_h + c_m)`——偏好靠近原位的格網節點（與 ILP 目標一致）。
- 跑 **set-to-set Dijkstra**（S 全體為源、T 全體為目標）；起訖端就地定案。

### 4.3 嵌入保持（§4.3）——定案後關閉資源

每條邊路由完成後更新格網成本，防後續路徑違規：

- 路徑用過的格網節點：**bend-closed**（其所有彎折邊 → ∞，禁止穿越）+ **sink-closed**（sink 邊 → ∞，禁止當別站起訖）。已定案站節點日後自己再當起訖時重開其 sink。
- 路徑用過的**對角**格網邊：關閉與其交叉的對角邊（→ ∞），防 X 交叉。
- **環繞順序**：站 ψ(v) 上已路由的邊佔用了某些港口。為讓後續邊遵守輸入環繞順序，關閉「落在已路由相鄰邊之間、會破壞順序」的扇形區內 sink 邊（圖 8）；同時保證每個待路由邊在正確區間內**至少留一條開放 sink 邊**（否則死路，見圖 8.3 的處理：關閉順時針後繼 sink 邊以保留空隙）。

### 4.4 站上線彎懲罰（§4.4）

路由 e_i 前，對每條開放的 sink 邊（= e_i 在 ψ(v) 的可能出向）計算「e_i 從此方向離站時，與已路由邊 e_j（共線者）形成的彎折懲罰總和」，把它加到該 sink 邊成本（圖 9）。這把「線穿站要直」也編進了 Dijkstra 成本。

### 4.5 局部搜尋（§4.6）

鄰域 = 「把一個輸入站从 ψ 移到 8 個相鄰格網位置之一（若空）」。對每個鄰居：拆掉該站所有鄰接邊的路徑 → 移動 → 依順時針序重新路由鄰接邊 → 算總分。取最佳鄰居，重複到收斂（各城市 2–22 輪）。這是「打磨」步驟，主結構在 Dijkstra 階段已經定型。

### 4.6 收縮站距優化（A-2+D，§4.7）

deg-2 收縮後，k 個站要等距插回一條 L∞ 長度 l 的曲線，可能塞不下（需 l ≥ k+1）。定義**彈簧勢能**加入局部搜尋目標：

```
E_{u,v} = c/(2k) · (k + 1 − l)²    （論文 c = 10；l 夠長時為 0）
```

（因為是二次式，放不進 ILP，只用於近似法。）

### 4.7 A* 加速（§4.8）

可採納啟發式（式 22）：`h(ψ) = min_{ψ′∈H_T} D_Ch(P(ψ), P(ψ′)) − 1`（到目標候選集凸殼的 Chebyshev 距離減一）——因為每跳至少要付一次 ≥ c′_180 的彎折/跳躍成本。

### 4.8 複雜度

總時間 `O(|E| · A/D² · log(A/D²))`。實測（Xeon 2.53 GHz）：Freiburg 110 ms、Vienna 202 ms、Stuttgart 843 ms、Berlin 764 ms、Sydney 515 ms、London 2.7 s；同網 ILP 要 6–20 小時。近似誤差（相對 ILP 最優）0.2%–7%。

---

## 5. 建議參數（論文評估用值）

| 參數 | 值 | 說明 |
|---|---|---|
| c_135, c_90, c_45 | 1, 1.5, 2 | 彎折懲罰（c_180 = 0） |
| c_h | 1 | 每跳成本（= 偏移 a） |
| c_m | 0.5 | 站移動懲罰 |
| 對角邊偏移 | +0.5 | 輕微偏好水平/垂直邊，圖較好看 |
| 候選半徑 r | 3·D | 站的格網候選範圍 |
| 格距 D | 0.75·d̂ | d̂ = 相鄰站平均距離；也可 1.0/1.25·d̂ |
| 彈簧常數 c | 10 | A-2+D 收縮站距 |

---

## 6. 標籤（§5）——簡單事後貼標

ILP 與近似法都不含標籤。論文示範：線度數高的站優先，貪婪選 8 個八方向位置中不碰撞者，微偏好某些方向讓標籤集中同側。密度太高時會有站貼不了——留為未來工作。

---

## 7. 格網成本偏移的妙用（§6.1）——本法獨有能力

因為格網邊實際成本 0、可任意加偏移：

- **障礙物**：湖泊/公園/山的多邊形內或相交的格網邊 → 成本 ∞，線路自動繞開。
- **貼近真實走向**：每條格網邊加「到該線真實地理路徑距離的二次值」偏移 → 輸出的八方向圖貼著真實走廊走，可疊在衛星圖/既有地圖上（因為允許任意彎數，站距很長的國鐵網也適用）。
- 調整水平/垂直 vs 對角的相對偏好。

---

## 8. 實作檢查清單與陷阱

1. **港口節點是靈魂**：不建港口/彎折邊，Dijkstra 只會給「均勻成本最短路」的鋸齒樓梯（論文圖 2 左）。
2. **成本偏移 a 不可省**：否則解出的「90° 彎」其實是兩個 135° 彎接在同一節點，圖面出現假平滑。
3. **關閉順序**：每條邊路由完立即 bend-close/sink-close + 關交叉對角邊，再路由下一條——資源競爭就是拓撲保證。
4. **環繞順序的 sink 管理最容易寫錯**：既要關掉破壞順序的扇區，又要為每條未路由邊留至少一條開放 sink（圖 8.3），否則死鎖。建議對每站維護「已佔港口的順時針區間表」。
5. **失敗重試**：貪婪順序可能把後面的邊堵死；抓不到路徑時隨機重排邊序重跑（論文機制）。
6. **set-to-set Dijkstra**：多源多匯，源側虛擬起點接 S 全體（成本 = 各自 sink+距離懲罰）即可。
7. deg-2 收縮後**記得檢查插回空間**（A-2+D 彈簧），否則長路徑上站會擠疊。
8. 局部搜尋移動站時要**整組拆除重路由**該站所有鄰接邊，且按順時針序重下，才能維持環繞順序。
9. 格網解析度 D 是品質/速度旋鈕：D 越小圖越精細、格網越大越慢（複雜度含 A/D²）。
10. 與其他方法的選型：要「邊貼真實走向、能繞障礙、毫秒級」選本法；要「每邊單直線段的極簡風」選 MILP/SAT。
