---
name: route-shape-align
description: Shape-Guided（Batik et al. 2022 精神）——只掛在 Straighten 形狀圖層（原始-形狀／旋轉-形狀；規定表城市才有，目前東京／新加坡）。規定路段成「四條直線邊」正方，只留 LLM 成方一種入口；成方後餵直線演算法，下游可動方形頂點但不得破方。當使用者要求修改 Shape-Guided、問為何交叉／不成方、或問形狀圖層行為時使用。
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
| `layout-shape-llm` | LLM 成方（見 [[route-llm-shape]]） |

**已刪除（2026-07，使用者裁決「已用不到」）**：演算法本體 `layout-shape`（格網→貼形，
`buildShapeAlign`＋§4/§5/§6 徑向成方＋`runRadialSquareGrid`／`ensurePaperDelivery`／
`shapeOcti.js` 全套）與更早的 `layout-shape-delaunay`。`shape.js` 現只留 LLM 成方支援
機構（`shapeLlmContext`／`applyShapeLlmTargets`／`applyShapeGreens`＋選路／成方判準／
共用幾何）。**⑨ 唯一入口＝LLM 成方**。

## 與直線演算法的銜接

```
格網化後
  →（僅形狀圖層）⑨ LLM 成方
  → 直線演算法①〜⑧＋LLM 對齊（輸入＝成方，不吃 HC）→ …
```

- **原始／旋轉**：永不餵成方、無成方護欄。
- **形狀圖層＋成方**：直線演算法／循環／RWD 吃成方；ring＋綠折經 `setFrozen({ ringIds, members })`
  只准剛體平移（禁單點／單邊啃方）；RWD 對灰白 highlight 成方邊 `shapeLock` 強制 S→T
  （絕對不可改彎／繞行；不要求像素 H/V）。
  成方邊用**灰白邊襯底**標出（不畫超大外框 `guideBoxPx`）。
- **重新計算圖層**：清空形狀圖層的成方套用，需再開 ⑨ tab 重算。

成方判準／護欄機制見 [[route-llm-shape]]（唯一入口）與 [[route-hillclimb]]（`setFrozen` 護欄）。
