# ⑦ Merrick 路徑簡化法（C-Directed Path Simplification）

> 論文：Damian Merrick & Joachim Gudmundsson (2007). *Path Simplification for Metro Map Layout*. Graph Drawing 2006 (GD'06), LNCS 4372, 258–269.
> 完整技術細節在技術報告：Merrick & Gudmundsson, *C-Directed Path Simplification for Metro Map Layout*（論文 [25]，正文因篇幅省略大量證明與實作細節）。

本文件是給開發者（或其他 LLM）的完整實作指南。讀完本文件後，不需要再看原始論文即可實作。

---

## 計算邏輯與程式骨架

> 以下依論文寫「要算什麼、怎麼算」——用虛擬碼、公式與迴圈描述計算步驟。實作時照此邏輯寫；不要呼叫既有程式裡的函式名，也不要寫「call xxx」。

### 輸入

- `P = [p_1, p_2, …, p_n]`：折線路徑，每個 p_i 是二維浮點座標 `(x_i, y_i)`。
- `C`：有限方向集合，每個元素是單位向量 `(cos θ, sin θ)`。**必須對每個 c ∈ C 也包含反方向 −c**。  
  - 4 方向：`{(1,0), (−1,0), (0,1), (0,−1)}` 共 4 個向量。  
  - 8 方向：再加 `{(1,1)/√2, (−1,1)/√2, (1,−1)/√2, (−1,−1)/√2}` 共 8 個向量。
- `ε > 0`：距離閾值（浮點數）。每個輸入點 p_i 的可接受誤差半徑。
- （多路線模式）`fixed_points`：字典，`vertex_index → 固定座標`，表示已由先前路線確定位置的頂點，其「ε-圓」退化為半徑 0 的點。

### 輸出

`P′ = [p′_1, p′_2, …, p′_{k+1}]`：簡化折線，k+1 個頂點、k 段，滿足：
1. 每段 `(p′_j, p′_{j+1})` 平行於 C 中某個方向。
2. P′ **依序刺穿** p_1…p_n 的所有 ε-圓（固定點的圓半徑為 0）。
3. k 在所有滿足上述條件的簡化中**最小**。

### 建議內部狀態

```
# 每個輸入點的 ε-圓
circle[i] = { center: p_i, radius: ε }   # 固定點時 radius = 0

# 方向對（排除平行對）與三元組
dir_pairs   = [(c1, c2)     | c1 ∈ C, c2 ∈ C, not parallel(c1, c2)]
dir_triples = [(c1, c2, c3) | (c1,c2) ∈ dir_pairs, c3 ∈ C, not parallel(c2, c3)]

# 動態規劃表：方向對 (ci, cj) → 目前「刺穿前綴最長」的 BoundaryPath
# BoundaryPath = {
#   links : [LinkBoundary, …],   # 已建好的 link boundary 序列（長度 = k）
#   reach : int,                 # 這條路徑刺穿到 p_reach（含）
# }
beta : dict[(ci, cj)] → BoundaryPath

# LinkBoundary = {
#   dir    : c,                  # 本 link 的射線方向
#   rays   : [(Q_j, c), …],      # 組成包絡的射線（起點 Q_j，方向 c）
#   envelope : Polyline,         # 射線族的上包絡折線（在 c_next 方向上排序）
#   i_start  : int,              # 本 link 負責刺穿 circles[i_start..i_end]
#   i_end    : int,
# }
```

### 主計算流程

```
ALGORITHM SimplifyPath(circles[1..n], C, fixed_points):

  # ── 步驟 0：套用固定點 ──
  for i in fixed_points:
      circle[i].radius ← 0
      circle[i].center ← fixed_points[i]

  # ── 步驟 1：建 k=1 的初始 boundary path（每個方向對一條）──
  for (c1, c2) in dir_pairs:
      B ← BUILD_LINK_BOUNDARY(circles[1..n], c1, c2, start=1)
      beta[(c1,c2)] ← BoundaryPath(links=[B], reach=B.i_end)

  # ── 步驟 2：逐層擴展，直到某條路徑刺穿全部 n 點 ──
  k ← 1
  while max reach over all beta < n:
      next_beta ← {}
      for (c1, c2, c3) in dir_triples:
          bp ← beta.get((c1, c2))
          if bp is None or bp.reach == n: continue
          B_new ← EXPAND_BOUNDARY_PATH(bp, c3, circles[1..n])
          new_bp ← BoundaryPath(links = bp.links + [B_new],
                                 reach = B_new.i_end)
          key ← (c2, c3)
          if key not in next_beta or new_bp.reach > next_beta[key].reach:
              next_beta[key] ← new_bp
      # 合併：每個方向對保留 reach 最遠的
      for key, bp in next_beta:
          if key not in beta or bp.reach > beta[key].reach:
              beta[key] ← bp
      k ← k + 1

  # ── 步驟 3：選出第一條刺穿全部 n 點的路徑 ──
  best_bp ← any bp in beta where bp.reach == n

  # ── 步驟 4：從邊界路徑反推具體頂點 ──
  return COMPUTE_PATH(best_bp, circles[1..n])
```

### 關鍵子計算

#### A. ε-圓「依序刺穿」的判定

**核心幾何**：射線 `Q + t·c`（`t ≥ 0`）與圓 `(center, r)` 的交集是參數區間 `[t_enter, t_exit]`：

```
d    ← center − Q
proj ← dot(d, c)            # 射線方向投影
perp² ← |d|² − proj²        # 垂直距離平方

if perp² > r²:  return ∅    # 射線不過此圓
half  ← sqrt(r² − perp²)
t_enter ← proj − half
t_exit  ← proj + half
交集區間 ← [t_enter, t_exit]
```

**依序刺穿判斷**（Definition 1）：對 circles[1..m]，射線必須先後依序通過每個圓。用「滾動下界」驗證：

```
FUNCTION ray_stabs_in_order(Q, c, circles[i..j]) → bool:
    t_lb ← −∞     # 下一個圓的 t_enter 必須 ≥ t_lb
    for k = i to j:
        [t_enter, t_exit] ← ray_circle_interval(Q, c, circles[k])
        if 區間為空 or t_exit < t_lb:
            return false   # 此圓完全在已通過區域之前
        t_lb ← max(t_lb, t_enter)
    return true
```

**求射線最遠刺穿前綴**：

```
FUNCTION ray_reach(Q, c, circles[1..n]) → int:
    t_lb ← −∞
    for i = 1 to n:
        [t_enter, t_exit] ← ray_circle_interval(Q, c, circles[i])
        if 區間為空 or t_exit < t_lb: return i − 1
        t_lb ← max(t_lb, t_enter)
    return n
```

#### B. 建立單一 Link Boundary（BUILD_LINK_BOUNDARY）

一個 link boundary（方向對 (c1, c2)）是「所有可從本段射出方向 c1、依序刺穿指定前綴的射線」的包絡折線。**直觀版**（O(n) 次射線檢查，每次 O(n)，總計 O(n²)）：

```
FUNCTION BUILD_LINK_BOUNDARY(circles[1..n], c1, c2, start=1) → LinkBoundary:
    # c1 = 本 link 射線方向；c2 = 下一 link 方向（決定切線偏側）
    # c2_perp = c2 旋轉 90° 的方向（用來在 c2 側找切線起點）
    c2_perp ← rotate90(c2)

    rays ← []
    reach ← start − 1

    for i = start to n:
        # 在 circle[i] 上，沿 c2 偏 c1 側找切線起點候選 α_i
        # 「偏 c1 側」= 使下一段 c2 射線能從本段 c1 射線接出的那側
        # 幾何：α_i = circle[i].center + r · sign(cross(c1, c2)) · c2_perp
        sign ← sign(cross_2d(c1, c2))   # +1 左偏、−1 右偏
        alpha_i ← circle[i].center + circle[i].radius × sign × c2_perp

        # 驗證：從 alpha_i 出發方向 c1，是否能依序刺穿 circles[start..i]
        if not ray_stabs_in_order(alpha_i, c1, circles[start..i]):
            break   # 找不到合法起點，無法再延伸

        rays.append((alpha_i, c1))
        reach ← i

    envelope ← COMPUTE_UPPER_ENVELOPE(rays, c1, c2)
    return LinkBoundary(dir=c1, rays=rays, envelope=envelope,
                        i_start=start, i_end=reach)
```

**上包絡（upper envelope）**：把射線起點按 c2 方向排序，取「在 c1 方向上最遠」的分段折線。對直觀版，可直接用凸包 / 排序取端點。

#### C. 擴展邊界路徑（EXPAND_BOUNDARY_PATH）

把新 link boundary B_new（方向 c3）接到已有 BoundaryPath bp（最後一段方向 c2）的尾端。

```
FUNCTION EXPAND_BOUNDARY_PATH(bp, c3, circles[1..n]) → LinkBoundary:
    B_last ← bp.links[-1]     # 最後一個 link boundary，方向 c2
    start  ← bp.reach + 1     # 從下一個未刺穿的點開始
    c2     ← B_last.dir
    c3_perp ← rotate90(c3)

    new_rays ← []
    reach    ← start − 1

    for i = start to n:
        # ── 步驟 1：從 B_last 的包絡上找 stabbing interval ──
        # 即：B_last.envelope 上哪些點 Q，使得 (Q, c3) 能刺穿 circles[start..i]？
        interval ← STABBING_INTERVAL(circles[start..i], c3, B_last.envelope)

        if interval 為空: break   # 無法延伸

        # ── 步驟 2：取 interval 邊界上、c2 方向最小的起點 γ ──
        gamma ← interval 在 B_last.envelope 上 c2 方向最小的端點

        new_rays.append((gamma, c3))
        reach ← i

        # ── 步驟 3：回溯截斷 B_last 並轉移責任 ──
        # 過 gamma 作方向 c2 的直線 γ̄，與 B_last.envelope 相交於截斷點 X
        X ← line_intersect_envelope(gamma, c2, B_last.envelope)
        if X 存在:
            # 把 B_last 截短到 X 之前
            B_last.envelope ← truncate_envelope(B_last.envelope, X)
            # 驗證截短後 B_last 尾端的圓是否仍被刺穿
            # 若某個 circle[j]（j ≤ bp.reach）因截斷而漏刺 → 責任轉移：
            #   B_last.i_end ← j − 1；start ← j（改由 B_new 從 j 開始刺）
            B_last, start ← RECHECK_AND_TRANSFER(B_last, start)

    B_new ← LinkBoundary(dir=c3, rays=new_rays,
                          envelope=COMPUTE_UPPER_ENVELOPE(new_rays, c3, ...),
                          i_start=start, i_end=reach)
    return B_new
```

#### D. Stabbing Interval 計算

`STABBING_INTERVAL(circles[i..j], c, envelope)` 回傳 envelope 上「出發方向 c 可依序刺穿 circles[i..j]」的合法起點區間。

**直觀版（逐點採樣）**：

```
FUNCTION STABBING_INTERVAL(circles[i..j], c, envelope) → Interval:
    feasible_params ← []
    for t in linspace(0, envelope.length, N_samples):
        Q ← envelope.point_at(t)
        if ray_stabs_in_order(Q, c, circles[i..j]):
            feasible_params.append(t)

    if 無可行點: return ∅
    return [min(feasible_params), max(feasible_params)]
```

**精確版（邊界由切線確定）**：stabbing interval 的邊界恰好是「射線恰切過某個 circle[k]」的位置——對每個 k，解「從 envelope 上的 Q 出發方向 c、與 circle[k] 恰相切」的 Q，共兩解（左切/右切）。取所有切線起點後，以「刺穿條件從可行變不可行」的轉換點為區間端點。

#### E. 從邊界路徑反推頂點（COMPUTE_PATH）

```
FUNCTION COMPUTE_PATH(bp, circles[1..n]) → P′:
    k ← len(bp.links)
    P′ ← array[1..k+1]

    # 最後一頂點：p_n 的 ε-圓內、沿 B_k 主方向最遠（t 最大）的點
    c_last ← bp.links[k-1].dir
    P′[k+1] ← farthest_in_circle(circles[n], c_last)
    # = circles[n].center + circles[n].radius × c_last

    # 從後往前逐層回推
    for j = k downto 2:
        B_j   ← bp.links[j-1]      # 第 j 段，方向 c_j
        B_j_1 ← bp.links[j-2]      # 第 j-1 段，方向 c_{j-1}
        # P′[j] = 過 P′[j+1]、方向 −c_j 的射線，與 B_{j-1} 包絡的交點
        P′[j] ← ray_intersect_envelope(P′[j+1], −B_j.dir, B_j_1.envelope)

    # 第一頂點：p_1 的 ε-圓內、沿 B_1 主方向最靠後（t 最小）的點
    c_first ← bp.links[0].dir
    P′[1] ← nearest_in_circle(circles[1], c_first)
    # = circles[1].center − circles[1].radius × c_first

    return P′
```

#### F. 多路線固定點機制

```
ALGORITHM SimplifyMetroMap(lines, vertex_coords, C, ε):
    # ── 1. 路線重要性排序（轉乘站數降序）──
    for L in lines:
        L.importance ← count of L.vertices that appear in ≥ 2 lines
    sorted_lines ← sort(lines, by=importance, descending=true)

    fixed ← {}   # vertex_id → 固定後的 2D 座標

    for L in sorted_lines:
        # ── 2. 在已固定頂點處切開子路徑 ──
        subpaths ← split_at_fixed(L.vertices, fixed)

        for subpath in subpaths:
            # subpath = [v_1, v_2, …, v_m]（頂點 id 序列）
            coords ← [vertex_coords[v] for v in subpath]

            # ── 3. 固定點的 ε-圓退化為點 ──
            fp ← {}
            if subpath[0] in fixed: fp[0]   ← fixed[subpath[0]]
            if subpath[-1] in fixed: fp[m-1] ← fixed[subpath[-1]]

            # ── 4. 建圓並執行路徑簡化 ──
            circles ← build_circles(coords, ε, fp)
            P′ ← SimplifyPath(circles, C)

            # ── 5. 把簡化路徑上的頂點投影回最近 link，固定座標 ──
            for i, v in enumerate(subpath):
                proj ← project_to_nearest_link(coords[i], P′)
                fixed[v] ← proj

    return fixed   # 所有頂點的最終格座標
```

**投影規則**（`project_to_nearest_link`）：
- 找 P′ 中最近的 link（線段）。
- 投影點 = 垂直投影到 link 上的最近點（若投影落在線段外則取最近端點）。
- 等距重排（美觀但可能超 ε）：在 link 上以等距間隔重新排列同 link 上的所有投影點。

---

## 1. 問題定義

**C-directed 路徑簡化問題（Problem 1）**：

- 輸入：折線路徑 `P = ⟨p_1, …, p_n⟩`、有限方向集合 `C`（要求對每個 c ∈ C 其反方向 c̄ 也在 C；例如 4 方向 = 水平+垂直、8 方向 = 加 ±45°）、距離閾值 ε。
- 輸出：**連結數（link 數）最少**的簡化路徑 P′，滿足：
  1. P′ 的每一段（link）都平行於 C 中某方向；
  2. P′ 依序**刺穿（stab）**每個輸入點 p_i 的 **ε-圓**（以 p_i 為心、半徑 ε 的圓盤）。

「依序刺穿」（Definition 1）：對每對 i < j，P′ 上存在點 q_i ∈ E(p_i)、q_j ∈ E(p_j)，且沿 P′ 前進時 q_i 不晚於 q_j。

### 與其他簡化法的差異（選型依據）

- **簡化點不限定是輸入點的子集**（Imai–Iri/Douglas–Peucker 系列是子集法）——彎點可以落在任何位置，換取更少的段數。
- 用 **ε-圓刺穿**（等價於限制 Hausdorff 距離）而不是 Fréchet 距離（Neyer 的方法）：方向集合小的時候 Fréchet 會產生 zig-zag，ε-圓在彎處自由度更高。
- 保證**最少 link 數**（Theorem 3：演算法輸出是最小 link 的 (C, ε)-簡化）。
- 複雜度 `O(|C|³·n²)` 時間、`O(|C|²·n)` 空間——**快**（雪梨全網 150–270 ms、倫敦 280–570 ms，2006 年的 Pentium 4）。這是本法的最大賣點：即時互動、超大網。
- 代價（論文自承）：**不保證拓撲**（多條路徑各自簡化可能新增/失去交叉）、不處理標籤、整體結構感較弱。

---

## 2. 演算法總覽（§2.1）

兩步：

```
(1) 建「邊界路徑（boundary path）」B = ⟨B_1, …, B_k⟩：
    每個 B_i 是一個「link boundary」，對應最終簡化 P′ 的第 i 段的所有可能位置的包絡。
(2) 從 B 反向抽出一條具體的最小 link 簡化 P′ = ⟨p′_1, …, p′_{k+1}⟩。
```

### 2.1 幾何基元

給定方向對 (c1, c2)（c1 = 本段方向、c2 = 下一段方向）與點序列 S：

- **τ_i**：p_i 的 ε-圓在方向 c2 上「最偏 c1 側」的切線。
- **α_i**：τ_i 上 c2 座標最小、且「過 α_i 的 c1 方向直線能依序刺穿 p_1…p_i」的點。
- **ι**：第一個不存在 α 的索引（= 這個方向的單一直線最多只能照顧到 p_{ι−1}）。
- **ℓ_j**：從 α_j 出發、方向 c1 的射線（j < ι）。
- **link boundary L（Definition 2）**：射線族 {ℓ_1…ℓ_j} 在 c2 方向上的**上包絡（upper envelope）**折線。直觀：L 是「第 i 段可以擺放的極限位置」，凡是從 L 上出發沿 c1 的射線都能依序刺穿它負責的那段點列。

**boundary path（Definition 3）**：依序刺穿整個 S 的 link boundary 序列。大小 k 的 maximal boundary path = 用 k 個 link boundary 能刺穿的**最長前綴**。

### 2.2 主迴圈 StabbingPath（虛擬碼）

動態規劃風格：狀態 = 「最後一段的方向對 (c_i, c_j)」，每個狀態保留一條「刺得最遠」的 maximal boundary path β_k(c_i, c_j)。

```
StabbingPath(P, ε):
    for 每對方向 (c_i, c_j): β_1(c_i,c_j) ← 該方向對的最大單一 link boundary
    k ← 1
    while 尚無 boundary path 刺穿全部 S:
        for 每個三元組 (c_i, c_j, c_ℓ) ∈ C³（排除 c_i∥c_j 或 c_j∥c_ℓ）:
            tmp ← ExpandBoundaryPath(β_k(c_i,c_j), c_ℓ, S)   # 接上方向對 (c_j,c_ℓ) 的新 link boundary
            β_{k+1}(c_j,c_ℓ) ← 兩者中刺穿前綴較長者（與既有候選比較）
        k ← k + 1
    Δ(S) ← 第一條刺穿全部 S 的 boundary path（大小 k）
    return ComputePath(Δ(S), S)
```

貪婪最遠前綴的正確性由 Lemma 1 保證：「給定起點與前一個 link boundary，演算法構造的 (B_i, B_{i+1}) 刺穿盡可能遠的點」——所以每層只需要對每個方向對保留一條最好的。

### 2.3 ExpandBoundaryPath（§2.2）——實作難點

把新 link boundary B_{k+1}（方向對 (c_j, c_ℓ)）接到 β_k 尾端。核心工具：

**boundary-restricted stabbing interval（Definition 4）**：`I(S, c, B)` = 平面區域，「從 B 上某點出發、方向 c 的射線」若起點落在此區域內，則該射線依序刺穿 S。

程序（概念）：

1. **初始化第一條射線**：看 c_i→c_j 與 c_j→c_ℓ 的轉向。同向（都左轉或都右轉）→ 從 c_i 看無窮遠處的 c_j 射線即可；反向 → 要找「沿 B_k 盡量靠後、但 B_k 或射線本身仍刺穿 B_k 負責的所有點」的 c_j 射線（它是 B_{k+1} 所有射線的最後界，圖 3b）。
2. **逐點延伸**：處理 B_k 未刺穿的剩餘點 q_1, q_2, …。對前綴 ⟨q_1…q_m⟩ 計算 stabbing interval；非空 → 取 c_ℓ 值最小的邊界線 γ，γ 與 B_k 的交點 x 發出 c_i 方向射線 γ̄，**反向回溯** B_k 尾端的點：若 γ̄ 把某點 p 的 ε-圓切成兩半，表示截短後 B_k 不再刺穿 p，p 改歸 B_{k+1} 負責（更新 γ 重算）。空 → 停止，B_{k+1} 定案。
3. **接合與截斷**：把新射線加進 B_{k+1}，B_k 與 B_{k+1} 在交點互相截斷。**截斷正確性是本步的陷阱**（圖 2c）：截短 B_k 可能讓原本靠 B_k 刺穿的點漏掉，必須回溯轉移責任（上一步的機制）。

效率（Theorem 1–2）：用一個 O(n) 的增量資料結構，stabbing interval 查詢 O(1)、尾端加點攤銷 O(n)，使 `ExpandBoundaryPath` 為 `O((|S_k| + |S_{k+1}|)²)`；總時間 `O(|C|³ n²)`。
（**實作備註**：正文只給規格，資料結構細節在技術報告 [25]。若不追求理論最優，每次前綴重算 stabbing interval 的直觀版是 O(n²)/次，總體 O(|C|³ n³)——對百站級網路仍在毫秒～秒級，可以先寫直觀版。）

### 2.4 ComputePath——從邊界路徑抽出簡化

```
p′_{k+1} ← p_n 的 ε-圓內、沿 B_k 主方向最遠的點
ℓ_k     ← 過 p′_{k+1} 的 B_k 最後射線方向直線
p′_k    ← ℓ_k 與 B_{k−1} 的交點
ℓ_{k−1} ← 過 p′_k、B_{k−1} 主方向的直線
…（依此回推）…
p′_1    ← p_1 的 ε-圓內、B_1 上沿主方向最靠後的點
```

---

## 3. 延伸到整張捷運圖（§3）

metro map graph（Hong et al. 模型）：圖 G + 覆蓋所有點邊的路徑（路線）集合。逐路線簡化：

```
(1) 重要性排序：importance(路線) = 該路線上「同時屬於其他路線的頂點數」
    （= 轉乘站數；可換成人工指定或其他啟發式）
(2) 取最重要路線 → 用 §2 演算法簡化 → 把原始點放上簡化線：
    投影到刺穿它的 link 上，或沿 link 等距重排
    （等距重排可能使個別點離原位 > ε，但圖面更整齊）→ 這些點「固定」
(3) 取次重要路線：先在「已固定頂點」處切成子路徑
    （每條子路徑首尾至多各一個固定頂點），逐子路徑簡化；
    簡化演算法小改：固定點的允許區間收縮成「恰過該點的那條線」
    （每個方向一條）。簡化完的點也固定。
(4) 重複 (3) 直到所有路線處理完。
```

### 兩個品質擴充（§3，實務必加）

- **最大彎角 α**：主迴圈直接**跳過**夾角 > α 的方向對三元組 (c_i,c_j,c_ℓ)。Theorem 3 的最優性在此限制下仍成立。
- **最小 link 長 l_min**：建 link boundary 時，把所有 boundary-restricted stabbing interval 從前一個 link boundary 起點**修剪掉 l_min 距離**。若因此刺不到某點：該輪縮小 l_min；連續多輪無進展則 l_min 歸零（保證有解，但不再保證最少 link）。沒有這條的話「最大彎角」會被零長度 link 鑽漏洞。

---

## 4. 實驗設定參考（§3.1）

- 雪梨 CityRail：173 頂點/182 邊；|C| = 4/6/8 方向分別 154/201/268 ms。
- 倫敦：266 頂點/308 邊；282/423/573 ms。倫敦市中心過密，先用 betweenness centrality 尺度變換（Merrick & Gudmundsson APVIS 2006，參數 α=10, β=50, γ=2）放大市中心再簡化。
- ε：各資料集**試誤**選定（自動選 ε 是 open problem；技術報告有 FPTAS：給定 k 反求最小 ε 的 (1+δ)-近似）。

---

## 5. 實作檢查清單與陷阱

1. **C 要含反方向**：4 方向集合實際是 8 個向量（±x, ±y），8 方向是 16 個向量。方向對 (c1,c2) 遍歷時排除平行對。
2. **ε-圓刺穿要「依序」**：檢查順序不能只看幾何相交，要沿射線的參數座標驗證單調（Definition 1）。
3. **link boundary 是射線族的包絡折線**，不是單一直線——第 i 段的可行放置是一個區域，這是本法能做到最少 link 的原因；別把它簡化成「單一候選線」。
4. **接合截斷後的責任轉移**（圖 2c / 圖 1c）是正確性核心：B_k 被截短後，尾端點必須確認仍被 B_k 或新射線刺穿，否則回溯移交給 B_{k+1}。漏掉這步會輸出「看似合法但漏刺點」的路徑。
5. **多路線簡化的固定點機制**：固定點在後續簡化中不是「ε-圓」而是「恰過該點」；子路徑切割保證每段至多首尾各一個固定點。
6. **本法不保拓撲**：路線各自簡化，交叉可能增減。需要拓撲保證時：(a) 把本法輸出當初始解交給保拓撲方法（MILP/爬山/Bast），或 (b) 事後偵測拓撲差異並局部調 ε 重跑。
7. **等距重排 vs 投影**：投影忠實（≤ ε）；等距重排美觀但可能超 ε——捷運圖建議等距（站距均勻是核心美學）。
8. 重要路線先處理 = 先佔好方向與位置；順序不同結果差異大（與 stroke 法的「先大後小」同精神）。
9. ε 太小 → link 數暴增趨近原折線；ε 太大 → 不同路線互相漂移、拓撲錯誤變多。從「相鄰站平均距離的 1–2 倍」附近開始試。

## 6. 建議參數

| 參數 | 建議 | 說明 |
|---|---|---|
| C | 8 方向（|C|=8） | 4 方向過於僵硬（見論文圖 4c/4d 對比） |
| ε | 試誤；~相鄰站均距 1–2 倍起 | 自動選定是 open problem |
| 最大彎角 α | 90° | 禁銳角彎 |
| 最小 link 長 l_min | > 0（如 ε） | 防零長 link 鑽漏洞，卡住時自動遞減 |
| 路線重要性 | 轉乘站數 | 可人工覆寫 |
