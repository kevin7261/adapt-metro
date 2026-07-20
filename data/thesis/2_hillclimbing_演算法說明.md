# ② Hill Climbing 多準則最佳化捷運圖佈局（爬山法）

> 論文：Jonathan Stott, Peter Rodgers, Juan Carlos Martínez-Ovando & Stephen G. Walker (2011). *Automatic Metro Map Layout Using Multicriteria Optimization*. IEEE Transactions on Visualization and Computer Graphics, 17(1), 101–114. DOI: 10.1109/TVCG.2010.24

本文件是給開發者（或其他 LLM）的完整實作指南。讀完本文件後，不需要再看原始論文即可實作。

---

## 計算邏輯與程式骨架

> 以下依論文寫「要算什麼、怎麼算」——用虛擬碼、公式與迴圈描述計算步驟。實作時照此邏輯寫；不要呼叫既有程式裡的函式名，也不要寫「call xxx」。

### 輸入

- **站點集合** `V`：每個站 v 有地理座標 `(x_v^geo, y_v^geo)` 及名稱字串。
- **邊集合** `E ⊆ V × V`：無向，表示兩站之間有直接連線。
- **路線集合** `lines`：每條路線 = 有序站序列，路線的邊是 E 的子集。
- **標籤集合** `labels`：每站一個文字標籤（站名），初始未指派位置。
- **格距** `g`（建議 40）；**理想邊長倍數** `l`（建議 4），理想邊長 `ℓ = l·g`。
- **各準則權重** `w_N1..w_N5`（站點）、`w_L1..w_L7`（標籤）（見 §8 論文參考值）。

### 輸出

- 每個站 v 的整數格座標 `(col_v, row_v)` ∈ ℤ²。
- 每個標籤的方向 `label_pos[v] ∈ {0..7}`（0=東、1=東北、2=北……7=東南，逆時針）。

### 建議內部狀態

| 名稱 | 說明 |
|---|---|
| `grid_pos[v]` | 站 v 目前格座標 `(col, row)` |
| `occupied` | `Set<(int,int)>`，已被某站佔用的格點 |
| `label_pos[v]` | 站 v 標籤目前方向（0–7）|
| `search_R` | 搜尋矩形半徑（初始 8，每輪縮小 1，最小 1）|
| `m_T` | 目前總適應度（站點準則和 + 標籤準則和）|

### 主計算流程

```
Algorithm HillClimbing(V, E, lines, labels, g, l, weights):

  ## 初始化：吸附到格點

  occupied ← ∅
  for each v in V（任意順序）:
      ideal_col ← round( x_v^geo / g )
      ideal_row ← round( y_v^geo / g )
      if (ideal_col, ideal_row) ∉ occupied:
          grid_pos[v] ← (ideal_col, ideal_row)
      else:
          # BFS 從 ideal 向外找最近空格點
          grid_pos[v] ← nearestEmptyGridPoint(ideal_col, ideal_row, occupied)
      occupied.add( grid_pos[v] )
      label_pos[v] ← 0   # 初始標籤方向任意（如東）

  search_R ← 8
  m_T ← stationFitness(V, E, lines, g, l, weights)
        + labelFitness(V, labels, g, weights)

  ## 主迴圈：反覆直到一整輪沒有改善

  converged ← false
  while not converged:
      converged ← true   # 假設本輪無改善，若有任何移動則重設

      # ── 逐站移動 ──
      for each v in V:
          m0 ← stationFitness(V, E, lines, g, l, weights)   # 移動前站點準則和
          best_pos ← grid_pos[v];  best_fit ← m0
          (c0, r0) ← grid_pos[v]
          for each (dc, dr) with |dc| ≤ search_R and |dr| ≤ search_R:
              (cx, cy) ← (c0 + dc, r0 + dr)
              if (cx, cy) = (c0, r0): continue
              if not satisfiesHardRules(v, cx, cy, V, E): continue
              occupied.remove( grid_pos[v] )
              grid_pos[v] ← (cx, cy)
              fit ← incrementalStationFitness(v, V, E, lines, g, l, weights)
              occupied.add( grid_pos[v] )
              grid_pos[v] ← (c0, r0)          # 還原
              occupied.remove( (cx, cy) )
              occupied.add( (c0, r0) )
              if fit < best_fit:
                  best_fit ← fit;  best_pos ← (cx, cy)
          if best_pos ≠ grid_pos[v]:
              occupied.remove( grid_pos[v] )
              grid_pos[v] ← best_pos
              occupied.add( best_pos )
              converged ← false

      # ── 群集移動 ──
      clusters ← findOverlengthClusters(V, E, g, l)
                ∪ findBendClusters(V, E, lines)
                ∪ findPartitionClusters(V, E, g, l)
      for each cluster C in clusters:
          m0 ← stationFitness(V, E, lines, g, l, weights)
          best_offset ← (0, 0);  best_fit ← m0
          for each (dc, dr) with |dc| ≤ search_R and |dr| ≤ search_R:
              if (dc, dr) = (0, 0): continue
              if any v ∈ C: not satisfiesHardRules(v, col_v+dc, row_v+dr, V\C, E):
                  continue
              tentatively shift every v ∈ C by (dc, dr); update occupied
              fit ← incrementalStationFitness(C, V, E, lines, g, l, weights)
              restore all v ∈ C; restore occupied
              if fit < best_fit:
                  best_fit ← fit;  best_offset ← (dc, dr)
          if best_offset ≠ (0, 0):
              shift every v ∈ C by best_offset; update occupied
              converged ← false

      # ── 逐標籤移動 ──
      for each v in V:
          m0 ← labelFitness(V, labels, g, weights)
          best_lpos ← label_pos[v];  best_lfit ← m0
          for pos_cand in {0, 1, 2, 3, 4, 5, 6, 7}:
              label_pos[v] ← pos_cand
              lfit ← incrementalLabelFitness(v, V, labels, g, weights)
              label_pos[v] ← best_lpos   # 還原
              if lfit < best_lfit:
                  best_lfit ← lfit;  best_lpos ← pos_cand
          if best_lpos ≠ label_pos[v]:
              label_pos[v] ← best_lpos
              converged ← false

      # ── 冷卻 ──
      search_R ← max(1, search_R − 1)

      # ── 收斂判定 ──
      m_T_new ← stationFitness(V,E,lines,g,l,weights)
              + labelFitness(V,labels,g,weights)
      if m_T_new ≥ m_T:
          converged ← true   # 一整輪（站+群集+標籤）後總適應度不再下降
      else:
          m_T ← m_T_new

  return grid_pos, label_pos
```

### 關鍵子計算

#### A. 五項站點準則（增量計算只重算受影響站的鄰域）

計算站 v（移動後）對總站點適應度 `m_N = Σ w_Ni · c_Ni` 的貢獻（式 1–6）：

```
incrementalStationFitness(v, V, E, lines, g, l, weights):
    c1 ← c2 ← c3 ← c4 ← c5 ← 0
    adj_v ← {u : (v,u) ∈ E}
    deg_v ← |adj_v|

    # c_N1 角解析度：相鄰邊對的夾角偏離「均勻分佈理想值 2π/deg_v」的程度
    edge_dirs ← sort [atan2(row_u−row_v, col_u−col_v) for u in adj_v] ascending
    edge_dirs.append( edge_dirs[0] + 2π )   # 循環封口
    for i in 0..deg_v−1:
        θ ← edge_dirs[i+1] − edge_dirs[i]   # 相鄰邊夾角（弧度）
        c1 += |2π/deg_v − θ|

    # c_N2 邊長：每條鄰邊長度趨近理想長度 ℓ = l·g
    for each u in adj_v:
        len_eu ← euclidean(grid_pos[v], grid_pos[u]) * g
        c2 += | len_eu / (l*g) − 1 |

    # c_N3 平衡邊長：只在 deg_v = 2
    if deg_v = 2:
        [u1, u2] ← adj_v
        len1 ← euclidean(grid_pos[v], grid_pos[u1]) * g
        len2 ← euclidean(grid_pos[v], grid_pos[u2]) * g
        c3 += |len1 − len2|

    # c_N4 線條平直：同一路線的進出邊（穿站）要盡量共線
    for each line L in lines containing v:
        neighbours_on_L ← vertices adjacent to v on line L (最多 2 個：前站與後站)
        if |neighbours_on_L| = 2:
            [u_in, u_out] ← neighbours_on_L
            dir_in  ← atan2(row_v−row_{u_in},  col_v−col_{u_in})
            dir_out ← atan2(row_{u_out}−row_v, col_{u_out}−col_v)
            θ_bend ← angleDiff(dir_in, dir_out)   # ∈ [0°, 180°]
            c4 += θ_bend   # 完全直行 = 0（補角差 = 0）；折彎越大值越大

    # c_N5 八方向性：每條鄰邊貼近 45° 整倍數
    for each u in adj_v:
        dc ← |col_u − col_v|;  dr ← |row_u − row_v|
        θ ← atan2(dr, dc)   # atan2 自動處理垂直邊（dc=0 → π/2）
        c5 += |sin(4 · θ)|  # 八方向時 = 0；22.5° 偏離時最大 = 1

    # 僅更新 v 及其鄰站的準則貢獻（增量：先減舊值再加新值）
    return w_N1*c1 + w_N2*c2 + w_N3*c3 + w_N4*c4 + w_N5*c5

angleDiff(θ1, θ2):
    diff ← (θ1 − θ2 + 2π) mod 2π
    return min(diff, 2π − diff)   # ∈ [0, π]
```

#### B. 四條硬規則 `satisfiesHardRules(v, cx, cy, V, E)`

候選位置 `(cx, cy)` 必須全部通過才列入考慮；任一違規直接跳過：

```
satisfiesHardRules(v, cx, cy, V, E):

    # 硬規則 1 邊界：格點在畫布矩形內
    if (cx, cy) outside bounding_box: return false

    # 硬規則 2 象限（相對位置）：
    #   對每個鄰居 u，移動後 v 仍在 u 的「與原地理關係相同的象限」
    for each u in adj(v):
        orig_quad ← quadrant( x_v^geo − x_u^geo,  y_v^geo − y_u^geo )
        new_quad  ← quadrant( cx − col_u,          cy − row_u )
        # quadrant((dx,dy)): 返回 {NE,NW,SE,SW}，dx=0 or dy=0 則可入兩側象限
        if new_quad not compatible with orig_quad: return false

    # 硬規則 3 無遮蔽：
    if (cx, cy) ∈ occupied: return false    # 站疊站
    # 移動後各鄰邊不壓過其他站、不與不相鄰邊新增交叉
    for each u in adj(v):
        new_edge ← segment( (cx,cy), grid_pos[u] )
        for each w ∈ V, w ≠ v, w ≠ u:
            if w on new_edge: return false
        for each (p,q) ∈ E, {p,q} ∩ {v,u} = ∅:
            if new_edge crosses segment(grid_pos[p], grid_pos[q]): return false

    # 硬規則 4 邊環繞順序：
    #   v 在候選位置時，adj(v) 的逆時針循環序與原輸入嵌入相同
    new_dirs ← [atan2(row_u − cy, col_u − cx) for u in adj(v)]
    new_cyclic_order ← argsort(new_dirs)
    if not cyclicEquivalent(new_cyclic_order, original_cyclic_order[v]):
        return false

    return true
```

#### C. 三種群集查找

```
findOverlengthClusters(V, E, g, l):
    # 「理想長度邊」= 長度 ≤ l·g 的邊；「超長邊」= 其餘
    ideal_edges ← {e ∈ E : length(e)*g ≤ l*g}
    # 依理想長度邊做連通分量，每個分量就是一個群集
    return connectedComponents(V, ideal_edges)

findBendClusters(V, E, lines):
    clusters ← []
    for each line L in lines:
        for each triple (u, v, w) consecutive in L where deg(v) = 2:
            # 若從 u 到 w 的直接方向角與 u→v 方向差 > 小閾值，v 是 "kink"
            if |angleDiff(atan2(row_w−row_u, col_w−col_u),
                          atan2(row_v−row_u, col_v−col_u))| > kink_threshold:
                clusters.append({v})
    return clusters

findPartitionClusters(V, E, g, l):
    # 對偶圖切割（§6.3）；可選配；省略時返回空列表
    return []
```

#### D. 七項標籤準則 `incrementalLabelFitness(v, V, labels, g, weights)`

計算站 v 的標籤在目前方向 `label_pos[v]` 時對總標籤適應度的貢獻（式 7–9）：

```
incrementalLabelFitness(v, V, labels, g, weights):
    lpos ← label_pos[v]
    lbox ← labelBoundingBox(v, lpos, g)   # 根據方向與標籤長度算矩形框

    # c_L1 標籤 × 站：標籤框與其他站點圓的交疊個數
    cL1 ← count {u ∈ V, u≠v : lbox intersects stationDot(u)}

    # c_L2 標籤 × 邊：標籤框與各邊線段的交疊個數
    cL2 ← count {e ∈ E : lbox intersects edgeSegment(e)}

    # c_L3 標籤 × 標籤：標籤框與其他站標籤框的交疊個數
    cL3 ← count {u ∈ V, u≠v : lbox intersects labelBoundingBox(u, label_pos[u], g)}

    # c_L4 位置偏好（固定查表）
    pref_table ← {0(東):1.0, 4(西):1.1, 2(北):1.4, 6(南):1.4,
                   1(東北):1.5, 7(東南):1.6, 5(西南):1.7, 3(西北):1.8}
    cL4 ← pref_table[lpos]

    # c_L5 位置一致性：與同線相鄰站（deg ≤ 2）標籤方向不同就 +1
    cL5 ← 0
    for each u adjacent to v on any line L, deg(u) ≤ 2:
        if label_pos[u] ≠ lpos: cL5 += 1

    # c_L6 站點鄰近：標籤框到其他站的距離越近越貴
    cL6 ← 0
    for each u ∈ V, u ≠ v:
        d ← distance(lbox, grid_pos[u]) * g   # 框到站的最近距離
        if d < g: cL6 += 1 / d²              # d > g 的項貢獻極小，可略去

    # c_L7 刻度線垂直：刻度線（tick）與兩條鄰邊的夾角差
    cL7 ← 0
    tick_dir ← labelTickDirection(v, lpos)    # tick 的角度（指向標籤中心）
    for each u in adj(v):
        edge_dir ← atan2(row_u − row_v, col_u − col_v)
        cL7 += |angleDiff(tick_dir, edge_dir)|

    return w_L1*cL1 + w_L2*cL2 + w_L3*cL3 + w_L4*cL4
         + w_L5*cL5 + w_L6*cL6 + w_L7*cL7
```

---

## 1. 問題定義

輸入：地理座標下的捷運網（站點 V、邊 E、路線 metro lines、站名標籤 L）。
輸出：一張示意圖——

- 所有站點落在**整數格網交點**上（邊本身不必沿格線走）。
- 邊盡量成八方向（水平、垂直、±45°）。
- 站距均勻、線條平直、標籤不互相遮蔽。
- 拓撲（誰接誰、邊的環繞順序）與相對位置不變。

### 核心理念：加權多準則適應度函數 + 爬山搜尋

定義若干「準則（criteria）」衡量美學品質（值越低越好），加權求和成適應度值；用**爬山法（hill climbing）**反覆微移站點與標籤來降低適應度。為什麼不用模擬退火或基因演算法？論文的結論：爬山更簡單、收斂更快，而示意圖常見的局部極小值用「**群集移動（clustering）**」處理比隨機擾動更有效。

兩個關鍵設計：

1. **離散化搜尋空間**：站點只能在格點上，候選位置數大幅減少。
2. **標籤是佈局的一級公民**：標籤準則跟站點準則整合在同一個爬山迴圈裡，不是事後貼標籤。

---

## 2. 資料模型

- `G = (V, E)`：站點與邊。一條邊代表兩站之間的**單一**連線；多條路線共走同一走廊時仍是一條邊（帶多個路線色的 metadata）。
- **metro line**：邊的子集合，構成一條路線（如 Central Line）。
- 格網間距 `g`；理想邊長 = `l × g`（`l` 是偏好倍數，論文用 `l = 4`, `g = 40`，見 §9 參數表）。
- 標籤空間：每個站的標籤只能放 **8 個離散位置**（東、西、北、南、東北、東南、西南、西北，見圖 8）。

---

## 3. 主迴圈（Algorithm 1）

```
MetroMapLayout(G = (V, E, L)):
    snapStations(V)                       # 初始佈局：原地理位置就近吸附到格點，
                                          #   保證一格點最多一站（衝突時找最近空格點）
    m_T0 ← calcStationCriteria(V) + calcLabelCriteria(L)
    running ← true
    while running:
        # ---- 逐站移動 ----
        for v in V:
            m_N0 ← calcStationCriteria(V)
            m_N  ← findLowestStationCriteria(v)   # 掃描 v 周圍矩形內所有格點
            if m_N < m_N0: moveStation(v)
        # ---- 群集移動（見 §6）----
        P ← clusterOverlengthEdges(V,E) ∪ clusterBends(V,E) ∪ clusterPartitions(V,E)
        for p in P:
            m_N0 ← calcStationCriteria(V)
            m_N  ← findLowestStationCriteria(p)   # 整個群集平移，內部相對位置不變
            if m_N < m_N0: moveCluster(p)
        # ---- 逐標籤移動 ----
        for l in L:
            m_L0 ← calcLabelCriteria(L)
            m_L  ← findLowestLabelCriteria(l)     # 試 8 個標籤位置
            if m_L < m_L0: moveLabel(l)
        # ---- 收斂判定 ----
        m_T ← calcStationCriteria(V) + calcLabelCriteria(L)
        if m_T ≥ m_T0: running ← false
        else:          m_T0 ← m_T
```

- `findLowestStationCriteria(v)`：以 v 為中心、邊長 = 目前允許移動距離的**矩形**內，逐一嘗試每個格點，取適應度最低者。
- **冷卻（cooling）**：每一輪迭代後縮小搜尋矩形（論文初始最大移動 8 格，迭代 5 輪），先粗調後微調。
- 移動一個站之後**只需增量重算受影響的準則項**（該站的鄰邊/鄰站），不必全圖重算——這是效能關鍵。

---

## 4. 站點準則（5 項，式 1–5）

值一律「越低越好」。總和：`m_N = Σ w_Ni · c_Ni`（式 6）。

### c_N1 角解析度（Angular Resolution）

站上相鄰兩邊的夾角要盡量大（平均分佈），否則難以分辨：

```
c_N1 = Σ_{v∈V} Σ_{相鄰邊對 (e1,e2)∈E_v} | 2π/ρ(v) − θ(e1,e2) |
```

`ρ(v)` = v 的度數，`θ` = 兩相鄰邊的夾角（弧度）。理想情況每對相鄰邊夾角 = 2π/度數。

### c_N2 邊長（Edge Length）

所有邊長趨近理想長度 `lg`：

```
c_N2 = Σ_{e∈E} | |e|/(lg) − 1 |
```

### c_N3 平衡邊長（Balanced Edge Length）

**只針對度數 = 2 的站**：兩條鄰邊長度要接近（捷運圖大量中間站是度 2，若一邊長一邊短會很難看，而 c_N2 察覺不到這種不平衡）：

```
c_N3 = Σ_{v∈V, ρ(v)=2} | |e1| − |e2| |
```

### c_N4 線條平直（Line Straightness）

**同一條路線**經過站 v 的進邊與出邊要盡量共線（穿站直行）。只在「e1、e2 是同一條 metro line 且都接在 v 上」時計算：

```
c_N4 = Σ_{v∈V} Σ_{同線邊對 (e1,e2)} θ(e1,e2)
```

`θ` 取相鄰邊間最小夾角；越小（越接近直線的補角關係）越好。注意：這一項與 c_N1 有張力——c_N1 想把邊撐開，c_N4 想把同線的邊拉直，權重要平衡。

### c_N5 八方向性（Octilinearity）

每條邊要貼近 45° 的倍數：

```
c_N5 = Σ_{{u,v}∈E} | sin( 4 · arctan( |y(u)−y(v)| / |x(u)−x(v)| ) ) |
```

角度是 45° 倍數時 sin(4θ) = 0；離 45° 倍數最遠（22.5° 附近）時值最大。**實作注意**：x 差為 0 時 arctan 要當 90° 處理（用 `atan2` 即可）。

---

## 5. 站點硬規則（4 條，違反即否決候選位置）

準則是軟性的；以下 4 條是**硬性規則**，任何候選位置違反其一直接跳過：

1. **邊界限制（Bounding Area）**：站不得移出畫布範圍。
2. **相對位置（Relative Position）**：站只能在「以每個相鄰站為原點劃分的四象限」中，停留在自己原本所在的象限（在象限邊界上的可入兩側象限）。保證「A 在 B 的東北」這類地理關係不被破壞。
3. **無遮蔽（Occlusions）**：移動後不得站疊站、站壓邊、邊交邊（新增交叉）。
4. **邊環繞順序（Edge Ordering）**：站 v 移動前後，v 及其鄰站上「邊的順時針環繞順序」必須不變——相對位置規則擋不住所有拓撲翻轉（論文圖 7 的反例），必須顯式檢查循環順序。

---

## 6. 群集移動（Clustering）——對付局部極小值

單站移動的典型死結：一條「超長邊」兩端各是一團站，單獨移動任何一站都會被其他準則懲罰，只有**整團一起移**才能縮短。三種找群集的方法（三者並用，結果聯集）：

### 6.1 超長邊群集（Overlength Edges）

定義超長邊 = 長度 > `lg` 的邊。把圖依「**理想長度的邊**」做連通分量分割——每個分量是一個群集；整個群集平移可同時縮短多條跨群集的超長邊（單看線端點群集會漏掉圖 12 那種多條超長邊並存的情況）。

### 6.2 折彎群集（Nonstraight Lines / Bends）

找「小歪折」：檢查恰有 1–2 個鄰居的站鏈，識別出「拿掉後其餘站共線」的最小站集合（圖 13）。把這些造成 kink 的站群整體移動，即可把略歪的線拉直。

### 6.3 二分割群集（Partitioning）

對付「兩大塊被一排超長邊隔開」的情況（圖 14）：

1. 邊交叉處插 dummy 站，得平面圖。
2. 取**對偶圖**（每面一頂點；對偶邊切過原圖每條邊）。
3. 刪除「切過理想長度邊」與「切過懸掛邊」的對偶邊，只留切過超長邊的。
4. 在對偶圖中從外面頂點出發、經至少一個內部頂點回到外面頂點，找一條路徑 → 該路徑切開的邊集合把圖分成兩半。啟發式：優先切「**近乎平行、彼此相對**」的邊（圖 15），分割品質較好。
5. 兩半各當一個群集，相向平移。

群集移動方式與單站相同（掃描矩形內位移、算適應度、硬規則檢查），只是**群集內所有站一起平移、內部相對位置固定**。

---

## 7. 標籤準則（7 項，式 7–9）

總和 `m_L = Σ w_Li · c_Li`。標籤位置只有 8 個離散選項（圖 8）。標籤太長（> 0.75·lg）就折行。

| 準則 | 內容 |
|---|---|
| c_L1, c_L2, c_L3 遮蔽 | 分別計數「標籤×站」「標籤×邊」「標籤×標籤」的相交次數 |
| c_L4 位置偏好 | 每個位置有偏好值（表 2）：東 1.0（最佳）、西 1.1、北/南 1.4、東北 1.5、東南 1.6、西南 1.7、西北 1.8（最差）；加總全部標籤 |
| c_L5 位置一致性 | 同一條線上相鄰站的標籤盡量同側（讀起來像清單）。只對度 ≤ 2 的站算：相鄰站標籤位置不同就 +1 |
| c_L6 站點鄰近 | 懲罰標籤貼近**別的**站：`c_L6 = Σ_k Σ_{v≠k_v} 1/d(k,v)²`，d = 標籤框到站的最近距離；d > g 的貢獻可略去（省時間） |
| c_L7 垂直刻度 | 標籤刻度線（tick）盡量垂直於路線：對每站取 `|θ1_v − θ2_v|`（tick 與兩條鄰邊的夾角差），加總 |

---

## 8. 權重設定

論文的權重靠試誤決定，原則：

1. 先把各準則的量級**歸一化**（各準則值域差異可達數個數量級，用權重拉平）。
2. 再依想強調的效果微調。

論文對 Mexico City / Sydney 用的實際數值（表 4）：

| 站點權重 | 值 | 標籤權重 | 值 | 其他參數 | 值 |
|---|---|---|---|---|---|
| w_N1 角解析度 | 30000 | w_L1 | 300 | 迭代輪數 | 5 |
| w_N2 邊長 | 50 | w_L2 | 80 | 理想倍數 l | 4 |
| w_N3 平衡邊長 | 45 | w_L3 | 19 | 格距 g | 40 |
| w_N4 平直 | 220 | w_L4 | 15 | 最小群集距離 | 3 |
| w_N5 八方向 | 9250 | w_L5 | 3 | 最大站移動 | 8 |
| | | w_L6 | 1 | | |
| | | w_L7 | 30 | | |

---

## 9. 效能參考

Java 1.6、1.4 GHz 單核：Atlanta（39 站）125 s；Mexico City（175 站）3559 s；Sydney 7189 s。慢的主因是每個候選位置都重算準則——**增量計算**（只重算受影響項）與**跳過遠處項**是最重要的兩個加速手段。

---

## 10. 實作檢查清單與陷阱

1. **初始吸附要處理格點衝突**：兩站吸到同一格點時，後者找最近空格點；否則一開始就違反遮蔽規則。
2. **硬規則是否決式**，不是加大懲罰值——違規位置直接不列入候選。
3. **邊環繞順序檢查不可省**：只靠象限規則會漏掉拓撲翻轉（圖 7）。實作：候選位置上重算 v 與每個鄰站的邊順時針序，與原序（循環等價）比對。
4. **c_N4 只算同一條路線的邊對**；c_N1 算所有相鄰邊對。兩者不要混。
5. **c_N5 用 atan2**，處理垂直邊除零。
6. **群集三法並用**：只做超長邊群集會卡在圖 13（歪折）與圖 14（二分割）型局部極小。
7. **冷卻**：搜尋矩形逐輪縮小；不縮小則後期一直大幅跳動、難收斂。
8. **標籤與站點在同一迴圈交替最佳化**，不是佈局完成後才排標籤——這是本法与力導向法（Hong et al.）的關鍵差異。
9. 收斂條件是「一整輪（站+群集+標籤）後總適應度沒有下降」。
10. 準則權重與地圖特性相關，換城市可能要微調（尤其 w_N1 vs w_N4 的張力：調高角解析度會犧牲平直度，反之亦然）。
