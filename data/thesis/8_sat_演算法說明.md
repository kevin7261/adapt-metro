# ⑧ SAT / SMT 捷運圖佈局最佳化

> 論文：Samantha Fuchs (2022). *SAT-based Optimization of Octolinear Metro Map Layouts*. Diploma Thesis, TU Wien（指導：Martin Nöllenburg；協助：Soeren Terziadis）。

本文件是給開發者（或其他 LLM）的完整實作指南。讀完本文件後，不需要再看原始論文即可實作。
本論文是「把 Nöllenburg & Wolff 的 MIP 模型（見 ③ MILP 文件）翻譯成 **MaxSAT** 與 **MaxSMT**」的首次嘗試——問題定義、硬/軟限制與 ③ 完全相同，差別只在求解技術。讀本文件前建議先讀 ③。

---

## 計算邏輯與程式骨架

> 以下依論文寫「要算什麼、怎麼算」——用虛擬碼、公式與迴圈描述計算步驟。實作時照此邏輯寫；不要呼叫既有程式裡的函式名，也不要寫「call xxx」。

### 輸入

- `V`：頂點集合，每個頂點 v 有原始嵌入座標 `(x_I(v), y_I(v))`。
- `E`：邊集合，每邊 `e = (u,v)` 帶有：
  - `L_min(e)`：最短長（預設 1）。
  - `sec_u(v)`：`u` 看向 `v` 的原始八方向扇區編號 `∈ {0,1,2,3,4,5,6,7}`（前處理算好、當常數）。`sec_v(u) = (sec_u(v) + 4) mod 8`。
  - `S(u,v) = { (sec_u(v) + d) mod 8 | d ∈ {−dev,…,dev} }`，`dev=1` → 3 個候選方向。
- `𝓛`：路線集合，每條路線是頂點序列（用於 S1 線彎約束）。
- `d_min`：最小邊距（預設 1）。
- `(f1, f2, f3)`：軟限制權重（建議 (3,2,1)）。
- `x_max`：座標上界（從緊設定，例如 `2 × |V|`）。
- `timeout`：求解器最長執行時間（秒）。

### 輸出

對每個頂點 v，最終座標 `(x(v), y(v))`（整數格），滿足：
- 所有邊八方向對齊（H1）。
- 環繞順序保持（H2）。
- 邊長 ≥ L_min（H3）。
- 平面性（H4）。
- S1/S2/S3 軟成本之加權和盡量小（MaxSAT 目標）。

### 建議內部狀態

```
# 四軸放大 2 倍座標（整數變數，一元編碼展開成布林向量）
# z0(v) = 2·x(v)，  z1(v) = x(v)+y(v)，
# z2(v) = 2·y(v)，  z3(v) = y(v)−x(v)
# 值域：z0 ∈ [0, 2·x_max]，z1 ∈ [0, 2·x_max]，
#        z2 ∈ [0, 2·x_max]，z3 ∈ [−x_max, x_max]
z[v][axis] : 整數變數（一元編碼後是一組布林）

# 每邊方向變數
dir[u][v] : 整數 ∈ S(u,v)（一元編碼）
dir[v][u] = (dir[u][v] + 4) mod 8

# 邊方向選擇布林（一熱）
alpha[i][u][v] : bool，i ∈ S(u,v)；恰一為真 → 本邊方向為 i

# 環繞順序輔助布林
beta[i][v]  : bool；v 的第 i 對鄰居之間「繞回」

# 平面性分離布林（按需加入）
gamma[i][e1][e2] : bool；e1, e2 在 z_i 軸上分離

# 軟成本量測變數（一元編碼）
theta[u][v][w] : 整數 ∈ [0,3]，線彎角
xi[u][v]       : 整數 ∈ [0,dev]，方向偏差
lambda_[u][v]  : 整數 ≥ L_min，L∞ 邊長

# 軟子句集合（帶權重）
soft_clauses : [(clause_literals, weight), …]

# 硬子句集合（CNF）
hard_clauses : [clause_literals, …]
```

### 主計算流程

```
ALGORITHM BuildAndSolve(V, E, L, params):

  # ── 步驟 0：前處理 ──
  # 0a. 平面化：在每個拓撲交叉點插 dummy 頂點，斷邊成兩段
  V, E ← planarize(V, E)

  # 0b. deg-2 壓縮：把內部全度-2 的路徑 v_1..v_n 換成單邊 (v_1,v_n)，
  #     L_min(v_1,v_n) ← n+1（畫完後等距插回）
  E, compressed_paths ← compress_deg2_paths(V, E)

  # ── 步驟 1：一元編碼宣告 ──
  for v in V:
      for axis in {0,1,2,3}:
          z[v][axis] ← declare_unary(lo=z_lo[axis], hi=z_hi[axis])
          # 加單調性子句：¬z[v][axis]^i ∨ z[v][axis]^{i−1}，∀ i ≥ lo+2
          hard_clauses += UNARY_MONOTONE(z[v][axis])

  for (u,v) in E:
      dir[u][v] ← declare_unary(lo=min(S(u,v)), hi=max(S(u,v)))
      hard_clauses += UNARY_MONOTONE(dir[u][v])

  for measurable in {theta, xi, lambda_}:
      for 每個對應的三元組/邊:
          hard_clauses += UNARY_MONOTONE(…)

  # ── 步驟 2：加硬子句 ──
  for (u,v) in E:
      hard_clauses += H1_DIRECTION(u, v)    # 一熱 + 方向賦值 + 正交座標相等 + 最短長
  for v in V where deg(v) ≥ 2:
      hard_clauses += H2_ORDER(v)            # 環繞順序嚴格遞增 + 恰一繞回
  # H4 平面性先不加（lazy 策略）

  # ── 步驟 3：加量測子句（不等式展開）──
  for (u,v,w) in line_triples:
      hard_clauses += S1_BEND_CONSTRAINT(u, v, w)   # θ ≥ |dir 差| 的展開
  for (u,v) in E:
      hard_clauses += S2_DEVIATION_CONSTRAINT(u, v)  # ξ ≥ |dir − sec| 的展開
      hard_clauses += S3_LENGTH_CONSTRAINT(u, v)     # λ ≥ L∞ 邊長的展開

  # ── 步驟 4：加軟子句（一元 literal 直讀）──
  for (u,v,w) in line_triples:
      for i = 1 to 3:
          soft_clauses += [(¬theta[u][v][w]^i, weight=f1)]
          # 轉乘站可用 2·f1
  for (u,v) in E:
      for i = 1 to dev:
          soft_clauses += [(¬xi[u][v]^i, weight=f2)]
      for i = L_min(u,v)+1 to L_min(u,v)+4:
          soft_clauses += [(¬lambda_[u][v]^i, weight=f3)]
  # 端點站（deg=1）的 lambda_ 直接硬鎖 = L_min，省掉軟子句

  # ── 步驟 5：Lazy 平面性迴圈 ──
  violated_pairs ← {(e1,e2) | e1,e2 ∈ E, 幾何相交}
  # （初始為空；先解再檢查）

  loop:
      # 加入新違規的分離子句
      for (e1, e2) in violated_pairs:
          hard_clauses += H4_PLANARITY(e1, e2)   # 8 個 gamma 布林 + 分離不等式

      # 呼叫 MaxSAT 求解器
      model ← maxsat_solve(hard_clauses, soft_clauses, timeout=timeout)

      if model 為 UNSAT: 報錯（格網 x_max 太小或問題無解）

      # 從 model 讀出 x(v), y(v)（z0/2、z2/2）
      solution ← extract_coordinates(model, z)

      # 幾何檢查
      new_violations ← check_planar_intersections(solution, E)
      if new_violations 為空: break
      violated_pairs ← new_violations   # 下輪加入子句重解

  # ── 步驟 6：等距插回 deg-2 壓縮的頂點 ──
  solution ← restore_deg2_vertices(solution, compressed_paths)

  return solution
```

### 關鍵子計算

#### A. 一元編碼（Unary / Order Encoding）

整數變數 `a`，值域 `[lo, hi]`，用 `hi − lo` 個布林位元 `a^{lo+1}, a^{lo+2}, …, a^{hi}` 表示：

```
a^i = true  ⟺  a ≥ i
（a^lo 恆真，省略；a^{hi+1} 恆假，省略）
```

**單調性子句**（必加，否則語義崩潰）：
```
for i = lo+2 to hi:
    add clause (¬a^i ∨ a^{i−1})    # a ≥ i 蘊含 a ≥ i−1
```

**常用不等式展開**：

| 不等式 | 子句形式 | 數量 |
|---|---|---|
| `a = c`（c 常數） | `a^c` 且 `¬a^{c+1}` | 2 條 |
| `a ≤ b` | `¬a^i ∨ b^i`，i 跨兩者重疊域；加邊界 `¬a^{hi_b+1}`, `b^{lo_a}` | O(域大小) |
| `a + g ≤ b`（g 常數） | `¬a^i ∨ b^{i+g}`，加邊界 | O(域大小) |
| `a − b ≤ c` | `¬a^i ∨ b^j ∨ c^{i−j+1}`，∀i,j | O(域²) |
| `a + b + g = c` | 組合上述規則 | O(域²) |

**Literal 直讀技巧**（sec 是常數時）：
- `dir(u,v) > c`  ⟺  `dir[u][v]^{c+1}` 直接是一個 literal，不需新子句。

#### B. 硬子句展開：H1 邊方向與最短長

對每條邊 `e = (u,v)`，先算扇區 `sec_u(v)`，允許方向集合 `S(u,v)` 大小通常為 3（dev=1）：

```
FUNCTION H1_DIRECTION(u, v) → clauses:
    clauses ← []

    # 一熱：至少一
    clauses += [⋁_{i ∈ S(u,v)} alpha[i][u][v]]

    # 一熱：至多一（所有 i<j 對）
    for i,j in pairs(S(u,v)), i≠j:
        clauses += [¬alpha[i][u][v] ∨ ¬alpha[j][u][v]]

    for i in S(u,v):
        # alpha_i → dir(u,v) = i
        clauses += UNARY_EQ(dir[u][v], i, guard=alpha[i][u][v])
        # alpha_i → dir(v,u) = (i+4)%8
        clauses += UNARY_EQ(dir[v][u], (i+4)%8, guard=alpha[i][u][v])

        # 確定 z_i^o（與方向 i 正交的軸）
        perp_axis ← (i + 2) mod 4    # 軸索引：0=z0,1=z1,2=z2,3=z3
        # alpha_i → z_{perp_axis}(u) = z_{perp_axis}(v)（正交座標相等）
        clauses += UNARY_EQ_GUARDED(z[u][perp_axis], z[v][perp_axis],
                                     guard=alpha[i][u][v])

        # alpha_i → z_i(u) + 2·L_min(e) ≤ z_i(v)（i<4 時）
        #            z_{i-4}(v) + 2·L_min(e) ≤ z_{i-4}(u)（i≥4 時）
        if i < 4:
            clauses += UNARY_ADD_LEQ(z[u][i], 2*L_min(e), z[v][i],
                                      guard=alpha[i][u][v])
        else:
            clauses += UNARY_ADD_LEQ(z[v][i-4], 2*L_min(e), z[u][i-4],
                                      guard=alpha[i][u][v])

    return clauses
```

**帶守衛的一元等式/不等式**：把守衛 literal g 加到每條子句：
```
UNARY_EQ(a, c, guard=g) → [(¬g ∨ a^c), (¬g ∨ ¬a^{c+1})]
UNARY_ADD_LEQ(a, offset, b, guard=g):
    # a + offset ≤ b，展開成：∀i: ¬g ∨ ¬a^i ∨ b^{i+offset}
    for i = lo_a+1 to hi_a:
        clause ← [¬g, ¬a^i, b^{i+offset}]   # b^{i+offset} 若超域則省略
        clauses += [clause]
```

#### C. 硬子句展開：H2 環繞順序

`deg(v)` 個鄰居依輸入逆時針序排列為 `u_1, …, u_d`，方向值必須嚴格遞增（mod 8 恰一繞回）：

```
FUNCTION H2_ORDER(v) → clauses:
    d ← deg(v)
    if d == 2:
        # 只需兩邊不同向：∀ i ∈ S(v,u_1) ∩ S(v,u_2): ¬alpha[i][v][u_1] ∨ ¬alpha[i][v][u_2]
        ...
        return

    # beta[i][v]：第 i 對與第 i+1 對之間「繞回」（mod 8 跳回 0）
    clauses += [⋁_i beta[i][v]]                   # 至少一個繞回
    for i≠j: clauses += [¬beta[i][v] ∨ ¬beta[j][v]]  # 至多一個

    for i = 1 to d:
        next ← (i mod d) + 1
        # 若非繞回點：dir(v,u_i) + 1 ≤ dir(v,u_{next})
        # 展開：¬¬beta[i][v] → 不加此子句；即加 (beta[i][v] ∨ dir(v,u_i)+1 ≤ dir(v,u_next))
        for k in S(v, u_i):
            for l in S(v, u_next) where l ≤ k:
                clauses += [beta[i][v], ¬alpha[k][v][u_i], ¬alpha[l][v][u_next]]
                # 若 beta[i] 為假，則方向 k 與 l 不能同時成立（因 l ≤ k 違反嚴格遞增）

    return clauses
```

#### D. 軟成本量測：S1 線彎

對路線上相鄰邊 `(u,v),(v,w)`，線彎角 `θ = min(|dir(u,v) − dir(v,w)| mod 8, 8 − …) ∈ {0,1,2,3,4}`（4 已是 180° 反向，實務 ≤ 3）。

用修正布林 `δ1, δ2` 消去絕對值與取小：

```
# θ ≥ dir(v,w) − dir(u,v)（若未繞回）→ δ1 = false
# θ ≥ dir(u,v) − dir(v,w)（若未繞回反方向）→ δ2 = false
# δ1 = true 時改用 dir(v,w) + θ − 8 ≥ dir(u,v)（繞回修正）
# δ2 = true 時改用 dir(u,v) + θ − 8 ≥ dir(v,w)

硬子句（展開成一元 literal，參數省略守衛）：
  ¬δ2 ∨ dir(u,v) + θ ≥ dir(v,w)       # (19.1) δ2=false → θ 正向下界
  ¬δ1 ∨ dir(v,w) + θ ≥ dir(u,v)       # (19.2)
   δ1 ∨ dir(u,v) + θ − 8 ≥ dir(v,w)   # (19.3) δ1=true → 繞回版
   δ2 ∨ dir(v,w) + θ − 8 ≥ dir(u,v)   # (19.4)

每條不等式展開方式（以「¬δ2 ∨ dir(u,v) + θ ≥ dir(v,w)」為例）：
  對所有 i（dir(u,v) 的值域）, j（dir(v,w) 的值域）, t（θ 的值域）：
    若 i + t < j（即不等式被違反）：
        add clause (δ2, ¬dir[u][v]^i, dir[u][v]^{i−1}, ¬dir[v][w]^{j+1}, …)
  → 實際用一元 literal 一個個枚舉 i,j: add (δ2, ¬alpha_i[u][v], ¬alpha_j[v][w], θ^{j−i+1})
    即：若 dir=i、dir=j，則 θ ≥ j−i （+1 因一元 a^i = a ≥ i）
```

**軟子句**（目標：θ 盡量小）：

```
for i = 1 to 3:
    soft_clauses += [(¬theta[u][v][w]^i, weight = f1)]
    # θ^i = true ⟺ θ ≥ i；¬θ^i = true 時不罰；θ^i = true 時罰 f1
    # 效果：θ 每多 1 級多罰 f1，壓力使求解器把 θ 最小化
```

轉乘站（`deg(v) > 2`）可改用 `weight = 2·f1`。

#### E. 平面性子句（H4，按需加入）

**按需流程**：

```
FUNCTION H4_PLANARITY(e1=(a,b), e2=(c,d)) → clauses:
    # 8 個分離布林 gamma[i][e1][e2]，i ∈ {0..7}（四軸正負各一）
    clauses += [⋁_{i=0..7} gamma[i][e1][e2]]   # 至少一個分離方向（14.1）

    for i = 0..7:
        # gamma[i] → 在 z_{i mod 4} 軸上，e1 的兩端點均比 e2 的兩端點小至少 d_min
        # 展開四端點組合（式 15.1–15.4）：
        for (p, q) in {(a,c),(a,d),(b,c),(b,d)}:
            # z_{i mod 4}(p) + d_min ≤ z_{i mod 4}(q)（i < 4）
            # 或 z_{i mod 4}(q) + d_min ≤ z_{i mod 4}(p)（i ≥ 4，對稱方向）
            axis ← i mod 4
            if i < 4:
                clauses += [(¬gamma[i][e1][e2]) ∨ UNARY_ADD_LEQ(z[p][axis], d_min, z[q][axis])]
            else:
                clauses += [(¬gamma[i][e1][e2]) ∨ UNARY_ADD_LEQ(z[q][axis], d_min, z[p][axis])]

    return clauses
```

**幾何交叉偵測**（從 model 讀出浮點座標後）：

```
FUNCTION check_planar_intersections(solution, E) → violated_pairs:
    pairs ← []
    for (e1, e2) in all_non_adjacent_pairs(E):
        seg1 ← (solution[e1.u], solution[e1.v])
        seg2 ← (solution[e2.u], solution[e2.v])
        if segments_intersect(seg1, seg2):
            pairs.append((e1, e2))
    return pairs
```

#### F. Timeout 退回策略

**路線 A：MaxSAT 求解器（如 RC2 / PySAT）**

RC2 不支援中途解，timeout 就一無所有。建議做法：
```
# 用 binary search on cost bound C_max 取得 anytime 行為：
best_solution ← None
C_max ← 初始上界（例如所有軟子句都不滿足的總罰值）

for C_try in [C_max, C_max//2, C_max//4, …]:
    # 加一條硬子句：軟成本 ≤ C_try
    # （一元加法展開：Σ weights × cost_indicators ≤ C_try）
    result ← maxsat_solve(hard + cost_bound(C_try), soft, timeout=timeout//log2(C_max))
    if result is SAT:
        best_solution ← result
        C_max ← actual_cost(result)
    # 若 UNSAT 表示 C_try 太緊，放寬繼續

return best_solution
```

**路線 B：MaxSMT（Z3 νZ，支援中途解）**

```
solver ← Z3_optimize()
for clause in hard_clauses:
    solver.add(clause)
for (clause, weight) in soft_clauses:
    solver.add_soft(clause, weight=weight)

solver.set("timeout", timeout × 1000)   # ms
result ← solver.check()                  # sat / unsat / unknown

# Z3 4.9+ 即使 unknown 也可讀 model（最後一個 SAT 的中途解）
if result in {sat, unknown}:
    model ← solver.model()
    return extract_coordinates(model)
else:
    return None
```

**自寫分支定界（DPLL-style）**：

```
ALGORITHM DPLL_MaxSAT(hard, soft, timeout):
    # 優先隊列：(已違反軟子句的罰值下界, 剩餘變數清單, 部分賦值)
    pq ← priority_queue()
    pq.push((0, all_variables, {}))
    best_cost ← ∞
    best_model ← None

    while pq not empty and elapsed < timeout:
        cost_lb, remain_vars, assignment ← pq.pop_min()
        if cost_lb ≥ best_cost: continue   # 剪枝

        # 單元傳播（BCP）
        assignment, conflict ← unit_propagate(hard, assignment)
        if conflict: continue

        if remain_vars 為空:
            cost ← eval_soft_cost(soft, assignment)
            if cost < best_cost:
                best_cost ← cost; best_model ← assignment
            continue

        # Most-constrained 變數選擇
        v ← most_constrained(remain_vars, hard, assignment)

        for val in {true, false}:
            new_assign ← assignment ∪ {v: val}
            lb ← cost_lb + violated_soft_lower_bound(soft, new_assign)
            pq.push((lb, remain_vars − {v}, new_assign))

    return best_model, best_cost
```

---

## 1. 問題定義（與 MILP 相同，重述要點）

輸入：平面圖 G = (V,E)（最大度 8）、線覆蓋 𝓛、輸入嵌入 Γ_I(G)。
可選參數：每邊最小長 L_min(e)（預設 1）、最小邊距 d_min（預設 1）、方向偏差 dev（預設 1）、軟限制權重 w = (f1, f2, f3)（預設 (1,1,1)）。

- 硬限制 H1 八方向（z0=0°, z1=45°, z2=90°, z3=135° 四軸）；H2 環繞順序保持；H3 邊長 ≥ L_min；H4 平面性/邊距 ≥ d_min。
- 軟限制 S1 線彎最少最鈍（權 f1）、S2 相對位置（權 f2）、S3 總長最短（權 f3）。
- 扇區：每邊 e=(u,v) 依輸入方位算 sec_u(v) ∈ {0..7}（sec_v(u) = sec_u(v)+4 mod 8，**前處理算好、當常數**）。允許方向集合：

```
S(u,v) = { i mod 8 | sec_u(v) − dev ≤ i ≤ sec_u(v) + dev }    （dev=1 → 3 個候選方向）
```

### 前處理（§2.3）

1. **平面化**：非平面嵌入在每個交叉點插 dummy 站，兩條邊各斷成兩段（保面結構）。
2. **deg-2 啟發式**：找內部頂點全為度 2 的路徑 P = (v_1..v_n)（deg(v_1), deg(v_n) ≠ 2），刪掉 v_2..v_{n−1}、換成單邊 (v_1, v_n)，設 **L_min(v_1,v_n) = n + 1**，畫完後等距插回。市中心太擠會不可行時可改用 Nöllenburg 的加強版：內部路徑保留兩個外側頂點（允許兩個彎）、通往端點站的路徑保留一個。維也納 90 站 → 44 站。

---

## 2. SAT 模型（第 3 章）——核心貢獻

SAT 求解器只吃 CNF 布林子句，最佳化用 **MaxSAT**（硬子句 + 帶權軟子句）。挑戰：把 MIP 的整數變數與不等式全部展成布林子句。

### 2.1 一元編碼（unary / order encoding，§3.1）——整數變數的表示法

有界整數 l_a ≤ a ≤ u_a 用 u_a − l_a 個布林變數表示：**a^i = true ⟺ a ≥ i**（省略 a^{l_a}，恆真）。單調性子句：

```
¬a^i ∨ a^{i−1}        ∀i: l_a+2 ≤ i ≤ u_a       （a ≥ i 蘊含 a ≥ i−1）
```

以此為基礎的（不）等式全是**線性數量**的子句（naive 編碼是平方）：

- `a = i`：兩子句 a^i 與 ¬a^{i+1}。
- `a ≤ b`：`¬a^i ∨ b^i`（i 在兩變數重疊值域內）+ 邊界子句 ¬a^{u_b+1}、b^{l_a}。
- `a + g ≤ b`（g 常數）：同上但 b 的索引平移 g：`¬a^i ∨ b^{i+g}`。
- `a = b·g`：索引乘除（⌈i/g⌉）版。
- **三變數**不等式 `a − b ≤ c`：需要**平方**數量子句 `¬a^i ∨ b^j ∨ c^{i−j+1}`（∀i,j）+ 值域裁剪子句——這是 SAT 版比 SMT 版子句爆炸的主因。
- `a + b + g = c`：上述規則的組合（式 8.1–8.14）。
- 邊界不可能滿足時：不是直接加 ⊥，而是把（不）等式所在子句的該 literal 換成 ⊥（式 9.1 De Morgan 展開），保持其餘 literal 仍可救。

### 2.2 座標（§3.2）——放大 2 倍的 L∞ 格網

沿用 ③ 的四軸座標，但原版 z1 = (x+y)/2 會出現 0.5——一元編碼只能表整數，所以**全部放大 2 倍**：

```
z0(v) = 2x(v)      z1(v) = x(v) + y(v)
z2(v) = 2y(v)      z3(v) = y(v) − x(v)
```

值域：0 ≤ x,y ≤ x_max（實驗 y_max = x_max）→ 0 ≤ z0 ≤ 2x_max、−x_max ≤ z3 ≤ y_max 等。
記號：z_i^o = z_{(i+2) mod 4} = 「與方向 i 正交的座標軸」。
每邊兩個整數方向變數 0 ≤ dir(u,v), dir(v,u) < 8（實際值域再裁到 S(u,v)）。

### 2.3 硬限制子句（§3.3）

**邊方向 + 最小長（3.3.1）**：每邊、每個 i ∈ S(u,v) 一個布林 α_i(u,v)，恰一為真：

```
⋁_i α_i(u,v)                                  (11.1 至少一)
¬α_i ∨ ¬α_j       ∀ i<j                        (11.2 至多一)
¬α_i(u,v) ∨ dir(u,v) = i                       (11.3)
¬α_i(u,v) ∨ dir(v,u) = (i+4) mod 8             (11.4)
¬α_i(u,v) ∨ z_i^o(u) = z_i^o(v)                (11.5 正交座標相等 → 邊沿方向 i)
¬α_i(u,v) ∨ z_i(u) + 2·L_min(u,v) ≤ z_i(v)     (11.6, i<4；注意 2 倍格網 → 2L_min)
¬α_i(u,v) ∨ z_{i−4}(v) + 2·L_min(u,v) ≤ z_{i−4}(u)  (11.7, i≥4)
```

**環繞順序（3.3.2）**：deg(v) > 2 的頂點，鄰居依輸入逆時針序 (u_1..u_deg)，方向值嚴格遞增、恰一處繞回（β_i 恰一為真標記繞回處）：

```
⋁ β_i(v)；¬β_i ∨ ¬β_j
β_i(v) ∨ dir(v,u_i) + 1 ≤ dir(v,u_{i+1})
β_deg(v) ∨ dir(v,u_deg) + 1 ≤ dir(v,u_1)
```

deg(v) = 2 只需兩邊不同向：`¬α_i(v,u_1) ∨ ¬α_i(v,u_2)`（式 13.1）。

**平面性/邊距（3.3.3）**：E′ = **同一面上**的不相鄰邊對。每對 8 個布林 γ_i(e,e′)（分離方向），至少一為真（14.1）；γ_i 為真 → e 的兩端點在 z_i 軸上都比 e′ 的兩端點小至少 d_min（式 15.1–15.4，四端點組合各一子句）；i+4 是對稱方向（e′ 較小，式 16.x）。
**按需加入（on demand）**：先不加平面性子句求解 → 檢查交叉 → 只為違規邊對加入子句 → 重解。這沿用 MILP 的 lazy 策略，是唯一平方級的部分。

### 2.4 最佳化（§3.4）——量測變數 + MaxSAT 軟子句

**S1 線彎**：每對同線相鄰邊 (u,v),(v,w) 一個整數 θ(u,v,w) ∈ [0,3]，目標 θ = min(|dir(u,v) − dir(v,w)|, 8 − |…|)。用兩個修正布林 δ1, δ2 把絕對值/取小線性化（式 18.1–18.4）：

```
δ2 ∨ dir(u,v) + θ ≥ dir(v,w)
δ1 ∨ dir(v,w) + θ ≥ dir(u,v)
¬δ1 ∨ dir(u,v) + θ − 8 ≥ dir(v,w)
¬δ2 ∨ dir(v,w) + θ − 8 ≥ dir(u,v)
```

（SAT 版為避免三變數和，再展開成含 θ^i literal 的版本，式 19.1–19.4。）因為 θ 被軟子句往下壓，它會貼緊正確值。

**S2 相對位置**：每邊整數 ξ(u,v) ∈ [0, dev] = |dir(u,v) − sec_u(v)| 的環狀距離，同樣用 η1, η2 修正變數（式 20–22；sec 是常數，`dir > c` 可直接寫成 literal dir^{c+1}，比 θ 省很多子句）。

**S3 緊湊度**：每邊整數 λ(u,v) ≥ L∞ 邊長：

```
x(u) − x(v) ≤ λ；x(v) − x(u) ≤ λ；y(u) − y(v) ≤ λ；y(v) − y(u) ≤ λ   (23.1–23.4)
```

**端點站優化**：接端點站（deg = 1）的邊在最優解必為最短（否則可縮短而不增其他成本，圖 3.4），直接硬編 `λ(u,v) = L_min(u,v)`（式 24.1/25.x），省掉這些邊的軟子句。

**軟子句**（一元編碼的紅利——「a < i」就是單一 literal ¬a^i）：

```
(¬θ(u,v,w)^i, 權重 f1)   ∀ 1 ≤ i < 4      # 每高一級彎折多付一次 f1
(¬ξ(u,v)^i,   權重 f2)   ∀ 1 ≤ i ≤ 4
(¬λ(u,v)^i,   權重 f3)   ∀ L_min < i ≤ L_min + 4    # 超過 L_min+4 的長度不再細分（實驗定的截斷）
```

選配：deg(v) > 2 的站（轉乘站）的線彎子句可用權重 **2·f1**（轉乘站直行更重要，圖 3.5）。

### 2.5 求解器

PySAT（python-sat）+ **G3** SAT 求解器，MaxSAT 用 **RC2**（Relaxable Cardinality Constraints）演算法，作者擴充了 timeout 支援。不用 LSU 的原因：LSU 不支援「按需加子句」（加了要重啟、丟掉所有已學子句）。
**已知弱點**：所用 MaxSAT 求解器**無法輸出中途解**（timeout 就什麼都沒有）——這是 SAT 版在大實例上的致命傷（見 §4）。

---

## 3. SMT 模型（第 4 章）——同一模型的第二種寫法

SMT = SAT + 背景理論（整數算術）。整數變數原生宣告（`(declare-fun |x(v)| () Int)`），不等式直接寫（`(assert (or |¬α_i| |z_i(u) + 2L_min ≤ z_i(v)|))`），**完全不需要一元編碼**——所有 §2 的限制逐條照搬、但子句數少一個「值域倍數」的因子（線彎約少 8×4 倍）。差異點：

- dir 變數用緊界 `min S(u,v) ≤ dir ≤ max S(u,v)`（比 0..8 更緊，加速）。
- 三變數不等式（18.1–18.4）直接寫，不必展開成 19.x。
- 軟子句用 `(assert-soft |θ(u,v,w) < i| :weight f1)` 等，語義同 SAT 版。
- 平面性同樣按需加入。
- 求解器：**Z3**（Z3Py / νZ MaxSMT 模組）。Z3 4.9.0 起支援**輸出中途（非最優/部分）解**——這是作者向 Z3 開發者（Nikolaj Bjørner）提的功能請求，timeout 時至少拿得到目前最好的圖。

---

## 4. 實驗結論（第 5 章）——選型依據

設定：5 城市（前處理後頂點/邊）：Montreal 26/27（最小）、Vienna 44/50、Washington 47/50、Lisbon 49/61、Karlsruhe 70/76（最大，10 線）；權重 (3,2,1)、(5,2,1)、(6,4,2)；d_min = 1；每實例 20 次、timeout 10 小時；單執行緒。

| 實例 | MIP | SAT | SMT |
|---|---|---|---|
| Montreal | 9–11 s | 12–24 s | 72–200 s |
| Vienna | 177–1130 s | 8.7k–14.1k s | 5.5k–14.9k s |
| Washington | 202–778 s | ~3k s | 4.8k s–timeout |
| Lisbon | 3.3k–7.6k s（最優） | timeout 無解 | 7k–11.4k s（最優） |
| Karlsruhe | timeout（有解，最優性未知） | timeout **無解** | timeout（有解但確定非最優，成本比 MIP 差 67–110%） |

結論：

1. **MIP 整體最快**——本問題目前仍是 MIP 的主場。
2. SAT 在**小**實例贏 SMT；SMT 在**大**實例贏 SAT（SMT 初始化開銷大、但編碼緊湊）。
3. SAT 的 pysat/RC2 拿不到中途解 → 大實例 timeout = 一無所有；SMT/Z3 4.9+ 至少有次優解。
4. 相同權重比例（(3,2,1) vs (6,4,2)）理論上等價，但求解時間可以差很多（求解器內部行為，無法解釋）——**權重請用最簡比例**。

---

## 5. 實作檢查清單與陷阱

1. **格網放大 2 倍後所有 L_min 都要乘 2**（式 11.6/11.7 的 2·L_min）；輸出時座標再除回來。
2. 一元編碼的**單調性子句不可漏**（¬a^i ∨ a^{i−1}），漏了整個整數語義崩潰。
3. **避免三變數不等式**能避就避（SAT 版子句平方爆炸）；sec 這類常數用「literal 直讀」技巧（dir > c ⟺ dir^{c+1}）。
4. **θ/ξ/λ 的正確性依賴軟子句往下壓**——修正變數 δ/η 的設計只保證「θ ≥ 正確值」可滿足，最小化才使其等於正確值。不參與目標的量測變數值不可信。
5. **平面性一定按需加**：先解 → 幾何檢查交叉 → 加違規對 → 重解。選 MaxSAT 演算法時確認支援增量加子句（RC2 可、LSU 不可）。
6. **端點站邊長直接鎖 L_min**，白拿的模型縮減。
7. λ 軟子句**截斷在 L_min+4**：超長邊一律同罰，不再細分（超過 4 的邊實務罕見；界限是實驗定的）。
8. timeout 策略：用 SMT/Z3（νZ）可拿中途解；純 SAT 路線要自己實作「binary search on cost + 保存最後 SAT 的模型」才有 anytime 行為。
9. **規模天花板現實**：70 頂點級（Karlsruhe）三種方法 10 小時都證明不了最優。密集大城市（東京、倫敦級）直接不可行——SAT/SMT 路線只適合**小網或骨架**（先 deg-2 收縮 + 只排轉乘骨架），大網請改用近似法（⑥ Bast）或把 SAT 當局部精修。
10. 布林變數/子句數估算（除錯用）：一元編碼下每個整數變數 ≈ 值域大小個布林；x_max 設太大（格網太大）會直接讓模型脹爆——**x_max 從緊（例如 2×頂點數）開始試，不可行再放大**。

## 6. 建議參數

| 參數 | 建議值 | 說明 |
|---|---|---|
| dev | 1 | 每邊 3 個候選方向（同 MILP） |
| d_min | 1 | 整數格網的自然值 |
| (f1, f2, f3) | (3, 2, 1) | 用最簡比例；等比放大無益且可能變慢 |
| 轉乘站彎權 | 2·f1（選配） | 強調線穿站直行 |
| λ 軟子句上限 | L_min + 4 | 論文實驗值 |
| SAT 求解器 | PySAT G3 + RC2 | 支援增量；無中途解 |
| SMT 求解器 | Z3 ≥ 4.9.0（νZ） | 支援 assert-soft 與中途解 |
| timeout | 依規模；小時級 | 大實例接受次優解 |
