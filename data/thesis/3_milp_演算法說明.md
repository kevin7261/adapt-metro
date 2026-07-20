# ③ MILP 混合整數規劃捷運圖佈局

> 論文：Martin Nöllenburg & Alexander Wolff (2011). *Drawing and Labeling High-Quality Metro Maps by Mixed-Integer Programming*. IEEE Transactions on Visualization and Computer Graphics, 17(5), 626–641.（初版：GD 2005）

本文件是給開發者（或其他 LLM）的完整實作指南。讀完本文件後，不需要再看原始論文即可實作。

---

## 計算邏輯與程式骨架

> 以下依論文寫「要算什麼、怎麼算」——用虛擬碼、公式與迴圈描述計算步驟。實作時照此邏輯寫；不要呼叫既有程式裡的函式名，也不要寫「call xxx」。

### 輸入

- **頂點集合** `V`：每個頂點 v 有地理座標 `(x_v^geo, y_v^geo)`。非平面圖先在每對相交邊的幾何交叉點插入 dummy 頂點，使輸入成為平面嵌入。
- **邊集合** `E ⊆ V × V`：無向，|E| = m。
- **路線覆蓋** `𝓛`：每條 metro line 是 E 的子集，形成一條頂點路徑。
- **最小邊長** `ℓ_e > 0`（L∞ 度量）；若全局統一，可令所有邊 ℓ_e = 1。
- **最小邊距** `d_min > 0`（非相鄰邊的 L∞ 距離下限）。
- **目標函數權重** `(λ_S1, λ_S2, λ_S3)`（建議 (3, 2, 1)）。
- **座標上界** `M`（big-M；取所有可能座標差的上界，約等於格點數 n）。

### 輸出

- 每個頂點 v 的新座標 `(x_v, y_v)`（整數格，L∞ 整數限制的副作用）。
- 每條有向邊 `(u→v)` 的指派方向 `dir[u,v] ∈ {0,1,...,7}`（逆時針，0=東、1=東北……7=東南）。

### 建議內部狀態（MIP 決策變數）

| 變數 | 型別 | 數量 | 說明 |
|---|---|---|---|
| `x[v], y[v]` | 連續（結果自動為整數）| 每頂點 | 輸出座標 |
| `z1[v]` | 輔助連續 | 每頂點 | = (x[v]+y[v])/2，東北–西南軸 |
| `z2[v]` | 輔助連續 | 每頂點 | = (x[v]−y[v])/2，東南–西北軸 |
| `dir[u,v]` | 整數 ∈ {0..7} | 每有向邊 2m | 邊的八方向指派 |
| `α_prec[e], α_orig[e], α_succ[e]` | 0/1 | 3m（無向）| 三候選方向之一選擇 |
| `β_i[v]` | 0/1 | Σ_v deg(v) | 頂點環繞順序的「繞回位置」|
| `γ_{D}[e1,e2]` | 0/1 | lazy 加入 | 邊對 e1,e2 的分隔方向（共 8 個方向）|
| `bd[u,v,w]` | 連續 ≥ 0 | 每線上鄰邊對 | 折彎成本 |
| `δ1[u,v,w], δ2[u,v,w]` | 0/1 | 每線上鄰邊對各 2 | 折彎線性化輔助 |
| `rpos[e]` | 0/1 | m（無向）| 邊是否偏離最近輸入方向 |
| `λ_edge[e]` | 連續 ≥ 0 | m（無向）| 邊 L∞ 長度上界，最小化總長用 |

### 主計算流程

```
Algorithm MILPMetroMap(V, E, 𝓛, ℓ, d_min, λ_S1, λ_S2, λ_S3, M):

  ## 前處理

  # 步驟 0a：計算每有向邊的初始扇區（輸入地理方向）
  for each undirected edge {u,v} ∈ E:
      dx ← x_v^geo − x_u^geo;  dy ← y_v^geo − y_u^geo
      sec_u[v] ← round( atan2(dy, dx) / (π/4) ) mod 8
      sec_v[u] ← (sec_u[v] + 4) mod 8     # 反方向
      prec_u[v] ← (sec_u[v] − 1 + 8) mod 8
      succ_u[v] ← (sec_u[v] + 1) mod 8    # 三個候選方向

  # 步驟 0b：度 2 縮減（大幅降低模型規模）
  deg2_paths ← []
  for each maximal path P = u₀—v₁—v₂—…—v_k—u₁ where all v_i have deg = 2:
      deg2_paths.append( (P, u₀, u₁, [v₁..v_k]) )
      replace P in graph with dummy path u₀—a—b—u₁  # 長度 3 路徑
      # 記錄對應關係，供後處理回插

  # 步驟 0c：記錄每個頂點的鄰邊逆時針輸入順序
  for each v ∈ V:
      original_order[v] ← sort adj(v) by sec_v[u] ascending (逆時針)

  ## 建立 MIP 模型

  model ← new MIPModel()

  # 宣告座標變數
  for each v ∈ V:
      x[v], y[v] ← model.addVar(continuous, lb=0, ub=M)
      z1[v] = (x[v] + y[v]) / 2          # 用 addConstr 或輔助表達式
      z2[v] = (x[v] - y[v]) / 2

  # H1 + H3：八方向 + 最小邊長（每無向邊 5 個變數、12 條限制）
  for each undirected edge {u,v} ∈ E:
      dir_uv ← model.addIntVar(lb=0, ub=7)
      α_p, α_o, α_s ← model.addBinaryVars(3)
      model.addConstr( α_p + α_o + α_s = 1 )         # 三選一
      model.addConstr( dir_uv = prec_u[v]·α_p
                               + sec_u[v]·α_o
                               + succ_u[v]·α_s )      # 綁定方向整數
      for (α_i, dir_i) in [(α_p, prec_u[v]),
                            (α_o, sec_u[v]),
                            (α_s, succ_u[v])]:
          addDirectionAndLengthConstraints(model, u, v, dir_i, α_i, ℓ_e, M)
          # 見子計算 A

  # H2：頂點環繞順序（每頂點 deg(v) 個二元變數，deg(v)+1 條限制）
  for each v ∈ V with deg(v) ≥ 2:
      nbrs ← original_order[v]    # u_1, u_2, ..., u_k（逆時針序）
      k ← deg(v)
      β ← model.addBinaryVars(k)
      model.addConstr( Σ_{i=1}^{k} β[i] = 1 )        # 恰一處繞回
      for i in 1..k:
          u_i    ← nbrs[i]
          u_next ← nbrs[(i mod k) + 1]
          model.addConstr( dir[v, u_i] ≤ dir[v, u_next] − 1 + 8·β[i] )
          # β[i] = 1 的那條約束允許遞減（跨 7→0 繞回）

  # S1：折彎成本（每線上鄰邊對 3 個變數、2 條限制）
  cost_S1_expr ← 0
  for each line L ∈ 𝓛:
      for each consecutive triple (u, v, w) in L:
          bd   ← model.addVar(continuous, lb=0)
          δ1, δ2 ← model.addBinaryVars(2)
          # Δdir = dir[u,v] − dir[v,w]（以差值線性化折彎角）
          # |Δdir mod 8| 的最小值即折彎等級（0/1/2/3 對應 0°/45°/90°/135°）
          model.addConstr( −bd ≤ dir[u,v] − dir[v,w] − 8·δ1 + 8·δ2 )
          model.addConstr(  bd ≥ dir[u,v] − dir[v,w] − 8·δ1 + 8·δ2 )
          # bd 在目標最小化驅動下自動等於 |Δdir − 8δ1 + 8δ2| 的最小值
          cost_S1_expr += bd

  # S2：相對位置成本（每無向邊 1 個二元變數、2 條限制）
  cost_S2_expr ← 0
  for each undirected edge {u,v} ∈ E:
      rpos_uv ← model.addBinaryVar()
      model.addConstr( −M·rpos_uv ≤ dir_uv − sec_u[v] )
      model.addConstr(  dir_uv − sec_u[v] ≤ M·rpos_uv )
      # rpos_uv = 0 ⟺ dir_uv = sec_u[v]（選中最近方向，無位置偏離）
      cost_S2_expr += rpos_uv

  # S3：總邊長成本（每無向邊 1 個連續變數、4 條限制）
  cost_S3_expr ← 0
  for each undirected edge {u,v} ∈ E:
      λ_uv ← model.addVar(continuous, lb=ℓ_e)
      model.addConstr(  x[u] − x[v] ≤ λ_uv )
      model.addConstr( −x[u] + x[v] ≤ λ_uv )
      model.addConstr(  y[u] − y[v] ≤ λ_uv )
      model.addConstr( −y[u] + y[v] ≤ λ_uv )
      # λ_uv ≥ L∞_length(e)，最小化時 λ_uv 緊貼等於 L∞ 長度
      cost_S3_expr += λ_uv

  # 目標函數
  model.minimize( λ_S1·cost_S1_expr
                + λ_S2·cost_S2_expr
                + λ_S3·cost_S3_expr )

  ## 求解（Lazy H4 循環）

  sol ← solveWithLazyH4(model, V, E, d_min, M)
  # 見子計算 B

  ## 後處理：等距回插度 2 頂點

  for each (original_path P = u₀—v₁—…—v_k—u₁, dummy_path u₀—a—b—u₁) in deg2_paths:
      # 沿三段繪製線段（u₀→a, a→b, b→u₁）計算總弧長
      seg_lens ← [L∞_dist(sol.x[u₀],sol.y[u₀], sol.x[a],sol.y[a]),
                  L∞_dist(sol.x[a], sol.y[a],  sol.x[b],sol.y[b]),
                  L∞_dist(sol.x[b], sol.y[b],  sol.x[u₁],sol.y[u₁])]
      total_len ← Σ seg_lens
      # 把 k 個原始頂點按等距比例 i/(k+1) 插回
      for i in 1..k:
          t ← i / (k + 1)
          v_i.x, v_i.y ← interpolateAlongPath(u₀, a, b, u₁, t, sol)

  return {(x[v], y[v]) for v ∈ V}, {dir[u,v] for (u,v) directed edge}
```

### 關鍵子計算

#### A. 單邊方向與長度約束 `addDirectionAndLengthConstraints(model, u, v, dir_i, α_i, ℓ, M)`

每個候選方向 `dir_i` 決定「哪個座標軸相等、哪個方向的軸差 ≥ ℓ」。`α_i = 0` 時因 M 很大而自動滿足（big-M 技巧）：

```
addDirectionAndLengthConstraints(model, u, v, dir_i, α_i, ℓ, M):
    # dir_i ∈ {0..7}；0=東（v 在 u 正東），1=東北，2=北，…，7=東南（逆時針）
    # 注意：α_i 是二元變數，α_i = 1 才「啟動」這組約束

    if dir_i = 0:   # 東：y 相等，x[v] ≥ x[u] + ℓ
        model.addConstr(  y[u] − y[v] ≤ M·(1−α_i) )
        model.addConstr( −y[u] + y[v] ≤ M·(1−α_i) )
        model.addConstr(  x[v] − x[u] ≥ ℓ − M·(1−α_i) )

    elif dir_i = 1: # 東北：z2（東南–西北軸）相等，z1[v] ≥ z1[u] + ℓ
        model.addConstr(  z2[u] − z2[v] ≤ M·(1−α_i) )
        model.addConstr( −z2[u] + z2[v] ≤ M·(1−α_i) )
        model.addConstr(  z1[v] − z1[u] ≥ ℓ − M·(1−α_i) )

    elif dir_i = 2: # 北：x 相等，y[v] ≥ y[u] + ℓ
        model.addConstr(  x[u] − x[v] ≤ M·(1−α_i) )
        model.addConstr( −x[u] + x[v] ≤ M·(1−α_i) )
        model.addConstr(  y[v] − y[u] ≥ ℓ − M·(1−α_i) )

    elif dir_i = 3: # 西北：z1（東北–西南軸）相等，z2[v] ≥ z2[u] + ℓ
        model.addConstr(  z1[u] − z1[v] ≤ M·(1−α_i) )
        model.addConstr( −z1[u] + z1[v] ≤ M·(1−α_i) )
        model.addConstr(  z2[v] − z2[u] ≥ ℓ − M·(1−α_i) )

    elif dir_i = 4: # 西：y 相等，x[u] ≥ x[v] + ℓ
        model.addConstr(  y[u] − y[v] ≤ M·(1−α_i) )
        model.addConstr( −y[u] + y[v] ≤ M·(1−α_i) )
        model.addConstr(  x[u] − x[v] ≥ ℓ − M·(1−α_i) )

    elif dir_i = 5: # 西南：z2 相等，z1[u] ≥ z1[v] + ℓ
        model.addConstr(  z2[u] − z2[v] ≤ M·(1−α_i) )
        model.addConstr( −z2[u] + z2[v] ≤ M·(1−α_i) )
        model.addConstr(  z1[u] − z1[v] ≥ ℓ − M·(1−α_i) )

    elif dir_i = 6: # 南：x 相等，y[u] ≥ y[v] + ℓ
        model.addConstr(  x[u] − x[v] ≤ M·(1−α_i) )
        model.addConstr( −x[u] + x[v] ≤ M·(1−α_i) )
        model.addConstr(  y[u] − y[v] ≥ ℓ − M·(1−α_i) )

    elif dir_i = 7: # 東南：z1 相等，z2[u] ≥ z2[v] + ℓ
        model.addConstr(  z1[u] − z1[v] ≤ M·(1−α_i) )
        model.addConstr( −z1[u] + z1[v] ≤ M·(1−α_i) )
        model.addConstr(  z2[u] − z2[v] ≥ ℓ − M·(1−α_i) )
```

#### B. Lazy H4 求解循環 `solveWithLazyH4(model, V, E, d_min, M)`

初始模型不含 H4；每得到一個候選解就在外部檢查邊距違規，只為違規邊對補加 H4 限制：

```
solveWithLazyH4(model, V, E, d_min, M):
    added_pairs ← ∅   # 已加入 H4 的邊對集合

    loop:
        sol ← model.solve(time_limit = 設定值)  # 接受次優解（intermediate incumbent）
        if sol is infeasible: error("無解；嘗試放寬 ℓ_e 或 d_min")

        # 從解中讀出座標，計算所有不相鄰邊對的 L∞ 距離
        violations ← []
        for each pair (e1={u1,v1}, e2={u2,v2}) with e1 ∩ e2 = ∅:
            if L∞_edgeDist(e1, e2, sol) < d_min:
                violations.append( (e1, e2) )

        if violations is empty: break   # 所有邊距都合法，接受解

        # 只為新違規的邊對補加 H4
        for (e1, e2) in violations:
            if (e1, e2) ∉ added_pairs:
                addH4Constraints(model, e1, e2, d_min, M)
                added_pairs.add( (e1, e2) )
        # 重新求解

    return sol


addH4Constraints(model, e1={u1,v1}, e2={u2,v2}, d_min, M):
    # 引入 8 個分隔方向二元變數
    γ ← {D: model.addBinaryVar() for D in {E,NE,N,NW,W,SW,S,SE}}
    model.addConstr( Σ_D γ[D] ≥ 1 )    # 至少一個方向上分隔

    # 以下僅列 γ_E（e1 整條在 e2 東邊 d_min）與 γ_N（e1 整條在 e2 北邊 d_min）示範；
    # 其餘六個方向按座標軸類推

    # γ_E = 1：x[u1], x[v1] 均 ≥ x[u2] + d_min 且 x[v2] + d_min
    for (s1, s2) in {(u1,u2),(u1,v2),(v1,u2),(v1,v2)}:
        model.addConstr( x[s1] − x[s2] ≥ d_min − M·(1−γ[E]) )

    # γ_W = 1：x[u2], x[v2] 均 ≥ x[u1] + d_min 且 x[v1] + d_min（左右互換）
    for (s2, s1) in {(u2,u1),(u2,v1),(v2,u1),(v2,v1)}:
        model.addConstr( x[s2] − x[s1] ≥ d_min − M·(1−γ[W]) )

    # γ_N = 1：y[u1], y[v1] 均 ≥ y[u2] + d_min（e1 在 e2 北邊）
    for (s1, s2) in {(u1,u2),(u1,v2),(v1,u2),(v1,v2)}:
        model.addConstr( y[s1] − y[s2] ≥ d_min − M·(1−γ[N]) )

    # γ_S 類推（南向，y 互換）
    # γ_NE / γ_SW 用 z1 座標（(x+y)/2）；γ_NW / γ_SE 用 z2 座標（(x-y)/2）


L∞_edgeDist(e1={u1,v1}, e2={u2,v2}, sol):
    # 兩線段的 L∞ 距離 = 各軸投影區間的最大「間隙」
    gaps ← []
    for axis_coord in [sol.x, sol.y,
                       lambda v: (sol.x[v]+sol.y[v])/2,   # z1
                       lambda v: (sol.x[v]-sol.y[v])/2]:  # z2
        a1 ← min(axis_coord(u1), axis_coord(v1))
        b1 ← max(axis_coord(u1), axis_coord(v1))
        a2 ← min(axis_coord(u2), axis_coord(v2))
        b2 ← max(axis_coord(u2), axis_coord(v2))
        gap ← max(a1 − b2, a2 − b1, 0)   # 若區間重疊則 gap = 0
        gaps.append(gap)
    return max(gaps)
```

---

## 1. 問題定義

輸入：平面圖 `G = (V, E)`（非平面時先在交叉處插 dummy 頂點）、每個頂點的地理座標 `Π(v)`、線覆蓋 `𝓛`（每條 metro line 是一條路徑，每條邊至少屬於一條線）、每邊最小長度 `ℓ_e`、最小邊距 `d_min`。
輸出：滿足所有**硬限制**、且**軟限制加權成本全域最小**的繪圖 Γ。這是與爬山法/力導向法的本質差異：MILP 給**全域最佳解**（或證明無解），不會卡在局部極小。

### 七條設計規則 → 硬/軟限制

| 規則 | 建模 |
|---|---|
| (R1) 八方向（0°/45°/90°/135° 各兩向） | 硬 H1 |
| (R2) 拓撲不變 | 硬 H2（環繞順序）+ H4（不新增交叉） |
| (R3) 少折彎、彎角越鈍越好 | 軟 S1 |
| (R4) 相鄰站相對位置保持 | 軟 S2（+ H1 的方向限制部分硬化） |
| (R5) 邊長均勻、有嚴格下限 | 硬 H3（下限）+ 軟 S3（總長上壓） |
| (R6) 標籤不重疊 | §7 擴充 |
| (R7) 路線顏色 | 純繪製問題，不進模型 |

**硬限制**：H1 每邊八方向；H2 每頂點鄰邊環繞順序 = 輸入嵌入；H3 每邊長 ≥ ℓ_e；H4 不相鄰邊距 ≥ d_min。
**軟限制**：S1 沿線折彎少且鈍；S2 相鄰頂點相對方位近似輸入；S3 總邊長小。
目標函數（式 15）：`min λ_S1·cost_S1 + λ_S2·cost_S2 + λ_S3·cost_S3`。

注意：頂點度數上限 8（八方向的直接推論）。判定「硬限制是否可滿足」本身是 NP-complete（Planar 3-SAT 歸約），所以用 MIP 是合理的。

---

## 2. 座標系統與度量

用擴充座標 `(x, y, z1, z2)`，四軸對應四個八方向軸，讓四種方向能用同一種式子處理：

```
z1(v) = (x(v) + y(v)) / 2      # 東北–西南軸
z2(v) = (x(v) − y(v)) / 2      # 東南–西北軸
```

距離用 **L∞ 度量**：`d(u,v) = max(|x(u)−x(v)|, |y(u)−y(v)|)`。副作用：只要所有邊長是整數，解自然落在整數格網上。

**扇區（sector）編號**：以每個頂點 u 為原點，平面分成 8 個 45° 扇區，中心對準八方向，從正 x 方向逆時針編號 0–7。`sec_u(v)` = 輸入佈局中 v 相對 u 落在哪個扇區。輸出中邊 uv 的實際方向記為整數變數 `dir(u,v) ∈ {0..7}`，且 `dir(v,u) = dir(u,v) + 4 (mod 8)`。

---

## 3. 硬限制建模

### 3.1 H1 + H3：八方向與最小邊長（式 1–3）

關鍵設計：每條邊**只允許 3 個候選方向**——輸入方向的最佳八方向近似 `sec_u(v)` 及其前後扇區（prec/orig/succ）。這把 R4（相對位置）部分硬化：方向偏差最多 67.5°，同時大幅縮小解空間。

每條邊 uv 引入 3 個二元變數 α_prec, α_orig, α_succ：

```
α_prec + α_orig + α_succ = 1                       (1) 三選一
dir(u,v) = Σ_i sec_u^i(v)·α_i   (i ∈ {prec,orig,succ})   (2) 綁定方向變數
```

對每個候選方向 i，用 **big-M** 寫「若 α_i = 1，則座標關係成立」。例如若選中的方向是「水平向左」（sec = 4）：

```
 y(u) − y(v) ≤ M(1 − α_prec)         # y 相等（兩條夾擠）
−y(u) + y(v) ≤ M(1 − α_prec)
 x(u) − x(v) ≥ −M(1 − α_prec) + ℓ_uv  # v 在 u 左邊至少 ℓ_uv
```

通式：被選中的八方向決定「哪個座標軸（x/y/z1/z2）相等、哪個座標軸至少差 ℓ_uv」。α_i = 0 時因 M 很大而自動滿足。M 取所有座標差的上界即可（如 0 ≤ x,y ≤ n 時 M = n）。
每條邊：**5 個變數、12 條限制**。

### 3.2 H2：頂點環繞順序（式 4–5）

對每個 deg(v) ≥ 2 的頂點，設 u_1 < … < u_deg(v) 為輸入嵌入中 v 的鄰居逆時針序。要求輸出的 dir 序列「嚴格遞增、只允許一次繞回（跨過扇區 7→0 的邊界）」：

```
β_1(v) + β_2(v) + … + β_deg(v)(v) = 1              (4)
dir(v,u_1) ≤ dir(v,u_2) − 1 + 8β_1(v)
dir(v,u_2) ≤ dir(v,u_3) − 1 + 8β_2(v)              (5)
…
dir(v,u_deg(v)) ≤ dir(v,u_1) − 1 + 8β_deg(v)(v)
```

β_i = 1 的那一條允許遞減（+8 鬆綁），其餘必須嚴格遞增。推論：同一頂點的兩條邊不可能同方向。每頂點 deg(v) 個二元變數、deg(v)+1 條限制。

### 3.3 H4：邊距與平面性（式 6–7）

對每對**不相鄰**邊 (e1, e2) = (u1v1, u2v2)：只要兩邊在**至少一個八方向**上錯開 ≥ d_min，L∞ 距離就 ≥ d_min。用 8 個二元變數 γ_N, γ_S, γ_E, γ_W, γ_NE, γ_NW, γ_SE, γ_SW：

```
Σ_i γ_i(e1,e2) ≥ 1                                  (6)
```

以 γ_E(e1,e2) = 1（e1 整條在 e2 東邊）為例：

```
x(u2) − x(u1) ≤ M(1 − γ_E) − d_min
x(u2) − x(v1) ≤ M(1 − γ_E) − d_min
x(v2) − x(u1) ≤ M(1 − γ_E) − d_min                  (7)
x(v2) − x(v1) ≤ M(1 − γ_E) − d_min
```

即 e2 的兩端點都在 e1 兩端點的西邊至少 d_min。其他方向類推（斜向用 z1/z2 座標）。每對邊 **8 個二元變數、33 條限制**——這是模型中唯一 Θ(m²) 的部分，是效能瓶頸（見 §6 的削減法）。

> 注意：這種平面性建模依賴「邊方向只有 8 種」的前提，不適用於任意方向線段。

---

## 4. 軟限制建模

### 4.1 S1 折彎成本（式 8–10）

對每條線 L ∈ 𝓛 上的相鄰邊對 (uv, vw)，夾角只可能是 180°/135°/90°/45°，折彎成本 bd 依序定 0/1/2/3。令 `Δdir_{u,v,w} = dir(u,v) − dir(v,w)`，則：

```
bd(u,v,w) = min( |Δdir|, 8 − |Δdir| )               (9)
```

線性化：引入兩個二元變數 δ1, δ2：

```
−bd ≤ Δdir − 8δ1 + 8δ2
 bd ≥ Δdir − 8δ1 + 8δ2                              (10)
```

因為 bd 在目標函數中被最小化，它會貼緊下界 `|Δdir − 8δ1 + 8δ2|`，而 δ1/δ2 會自動取讓下界最小的值（Δdir ∈ [5,7] 時 δ1=1,δ2=0；Δdir ∈ [−7,−5] 時 δ1=0,δ2=1；其餘兩者相等）。總成本：

```
cost_S1 = Σ_{L∈𝓛} Σ_{uv,vw∈L} bd(u,v,w)            (8)
```

每對線上相鄰邊：3 個變數、2 條限制。可以對轉乘站的折彎加倍計價以強調「線穿站直行」。

### 4.2 S2 相對位置成本（式 11–12）

每條邊一個二元變數 rpos(uv)，「沒有用最接近輸入方向的 α_orig」時 = 1：

```
−M·rpos(uv) ≤ dir(u,v) − sec_u(v) ≤ M·rpos(uv)      (12)
cost_S2 = Σ_{uv∈E} rpos(uv)                          (11)
```

### 4.3 S3 總邊長成本（式 13–14）

每邊一個實數變數 λ(uv) 當長度上界，最小化其總和使其貼緊：

```
 x(u) − x(v) ≤ λ(uv)
−x(u) + x(v) ≤ λ(uv)
 y(u) − y(v) ≤ λ(uv)                                 (14)
−y(u) + y(v) ≤ λ(uv)
cost_S3 = Σ λ(uv)                                    (13)
```

（L∞ 長度；配合 H3 的下限 ℓ_uv，實現「邊長均勻」。）

### 4.4 模型規模總覽（表 1）

| 部分 | 變數 | 限制 |
|---|---|---|
| H1+H3 | 5m | 12m |
| H2 | 2m | 2m + n |
| H4 | ≤ 8(m²−m)/2 | ≤ 33(m²−m)/2 |
| S1 | 3m′（m′ = 線上相鄰邊對數） | 2m′ |
| S2 | m | 2m |
| S3 | m | 4m |

權重範例：`(λ_S1, λ_S2, λ_S3) = (3, 2, 1)`（雪梨無標籤版）。三個極端權重的效果（圖 6）：只重 S1 → 全直但改變地理；只重 S2 → 忠於地理但彎多；只重 S3 → 全部壓成最短邊、中心擠爆。必須平衡。

---

## 5. 前處理：度 2 頂點縮減（§5.1）

捷運圖大量非轉乘站是度 2。做法：把「兩轉乘站之間的度 2 頂點路徑」**整條換成長度 3 的路徑**（允許最多兩個折彎——比換成單一直邊更能平衡 S1 與 S2），解完後把原頂點**等距**插回對應的三段上。雪梨：174 頂點/183 邊 → 縮到 88 頂點/97 邊。

---

## 6. 效能關鍵：H4 的削減（§5.2）

H4 是唯一平方級的部分，兩層削減：

1. **同面限制**：平面圖中，兩條不同面的邊要相交，必先跟面的邊界邊相交。所以只對「**共享同一個面**的不相鄰邊對」建 H4。
2. **Callback 延遲加入（lazy constraints）**：初始模型**完全不含 H4**。求解過程中每得到一個候選解，用回呼函式在外部檢查是否有邊相交；有 → 只為**相交的那幾對**邊加入 H4 限制、否決該候選解、繼續求解。實際效果驚人：雪梨無標籤版只需為 **3 對**邊加入 H4（全對數 4520），有標籤版 123 對（全對數 35896）。

無標籤雪梨：23 分 22 秒得到最終佈局（12 小時內無法證明最優，gap 16.4%——**次優解通常已經視覺上足夠好，且 CPLEX 很快就給出不錯的中間解**，大部分時間花在微小改進）。

---

## 7. 標籤整合（§5.3）

原則：標籤是佈局的一部分（整合式），不是事後貼——這樣才能**保證**放得下且零重疊。

- 假設已做 §5 的度 2 縮減。對每條「兩轉乘站之間的長度 3 路徑」，把標籤區建成**貼在中段邊上的平行四邊形**：在中段邊 vw 上插 dummy 頂點 r、s，強制 `dir(v,r) = dir(r,s) = dir(s,w)`（式 16，讓該邊在 r、s 處不彎）；再加頂點 t、u 與邊 rt、tu、su——rt 與 su 水平、長度 = 該路徑上最長站名的長度 ℓ_rt（式 17，用二元變數 ρ(e) 決定標籤在邊的左側或右側），tu 與 rs 平行（式 18）。四條新邊圍成的平行四邊形就是保證淨空的標籤區，解出後把縮減掉的站名沿路徑排進去，全在**同一側**（符合 R6）。
- 標籤方向：一律水平；若邊本身是水平的，改用 z1 方向（45°）的平行四邊形。
- r、s 不套 H2 環繞順序限制；新邊不計入 S3。
- **單一頂點（轉乘站）的標籤**：附加一個新頂點 w 與邊 vw，長度 = 標籤長，方向可取水平或 z1 對角、可插入 v 的邊環繞序任意空隙。

代價：雪梨加標籤後模型變大（242 頂點/270 邊），求解 10.5 小時（權重 (3,3,1)）——但**前 3 分鐘就有第一個次優解**。

---

## 8. 實作檢查清單與陷阱

1. **非平面輸入先插 dummy 交叉頂點**，交叉在輸出中被保留（H2 作用在 dummy 上維持交叉方位）。
2. **dir(v,u) = dir(u,v)+4 (mod 8)**——實作時兩個方向變數都要建，或只建一個並在限制裡做 mod 轉換。
3. **每邊只開 3 個候選方向**（orig ±1）。開放全部 8 個會既慢又破壞相對位置；3 個是論文實驗出的平衡點。
4. **big-M 盡量小**（座標上界），M 太大會讓 LP 鬆弛很鬆、分支變慢。
5. **H4 一定要用 lazy constraint/callback**，否則中型城市（>100 邊）模型直接爆炸。現代求解器（Gurobi/CPLEX/HiGHS+自寫迴圈）都可實作：解 → 檢查交叉 → 加違規對 → 重解。
6. **H2 的 β 技巧**：環狀順序「恰一處繞回」用 Σβ=1 + 「+8β_i 鬆綁」表達，這是把循環序線性化的標準手法，抄式 (4)(5) 即可。
7. **S1 線性化**（式 10）依賴「bd 被最小化」才會貼緊下界；若你的目標函數不含某條 bd，它的值就不可信。
8. **度 2 縮減用長度 3 路徑**，不是單邊；等距回插時沿三段的實際繪製長度按弧長比例分配。
9. 求解設**時間上限**並接受次優解（intermediate incumbent）——論文明說次優解常常視覺上跟最優一樣好甚至更好。
10. 目標權重是使用者偏好：偏 S1 = 現代簡潔風，偏 S2 = 忠於心智地圖。沒有唯一正確值。

## 9. 建議參數

| 參數 | 建議值 | 說明 |
|---|---|---|
| 候選方向數 | 3（orig ±1） | 最大偏差 67.5° |
| (λ_S1, λ_S2, λ_S3) | (3,2,1)～(3,3,1) | 論文雪梨用值 |
| ℓ_e | 1（縮減後統一單位長） | L∞ 整數 → 自動落格網 |
| d_min | > 0，如 1 | 邊距下限 |
| M | 座標上界（≈ n） | 越小越好 |
| 時限 | 依規模，分鐘～小時級 | 接受次優解 |
