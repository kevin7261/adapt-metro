---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022 精神）——只掛在 Straighten 形狀圖層（原始-形狀／旋轉-形狀；規定表城市才有，目前東京／新加坡）。規定路段成「四條直線邊」正方；成方後餵直線演算法，下游可動方形頂點但不得破方。當使用者要求修改 Shape-Guided、問為何交叉／不成方、或問形狀圖層行為時使用。
---

# Shape-Guided (route-shape-align)

論文：`data/thesis/9_Shape-Guided Mixed Metro Map Layout.pdf`；實作說明：`data/thesis/9_shape-guided_演算法說明.md`。

## Straighten 圖層

| 變體 | 何時有 | Shape-Guided |
|---|---|---|
| `orig`／`rot`（原始／旋轉） | **每個城市一定有** | 無——不成方管線 |
| `orig-shape`／`rot-shape`（原始-形狀／旋轉-形狀） | 僅 `shapePresets` 城市（東京 JR／東京／新加坡） | 有 ⑨ |

**入口**（僅形狀圖層左選單 ⑨）：

| mode | 說明 |
|---|---|
| `layout-shape` | 格網→貼形；**成方後往後執行** |
| `layout-shape-llm` | LLM 成方（見 [[route-llm-shape]]） |

已刪除：`layout-shape-delaunay`。

## 與直線演算法的銜接

```
格網化後
  →（僅形狀圖層）⑨ 成方
  → HC（背後算）→ 直線演算法①〜⑧＋LLM 對齊 → …
```

- **原始／旋轉**：永不餵成方、無成方護欄。
- **形狀圖層＋成方**：HC／直線演算法／循環／RWD 吃成方；ring＋綠折經 `setFrozen({ ringIds, members })`
  只准剛體平移（禁單點／單邊啃方）；RWD 對成方 H/V 邊 `shapeLock` 強制直線。
  成方邊用**灰白邊襯底**標出（不畫超大外框 `guideBoxPx`）。
- **重新計算圖層**：清空形狀圖層的成方套用，需再開 ⑨ tab 重算。

## 格網→貼形

1. **§4 選路**：`shapePresets` 規定 W  
2. **§5 變形**：平滑／混合 LS；`cross > cross0` → 退回上一輪  
3. **§6**：`runRadialSquareGrid`  
4. **必交**：`ensurePaperDelivery`  
5. `stats.square` → 自動餵直線演算法  

**手動執行**：按「執行」才跑。`HC_LS_KEY` v61+（成方軟護欄）。
