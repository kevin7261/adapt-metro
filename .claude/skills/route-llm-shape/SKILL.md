---
name: route-llm-shape
description: LLM 成方（⑨ Shape-Guided 的 LLM 版）——不用 API key，由 Claude Code 的模型直接當最佳化器把「規定路段」收成四邊直線正方：export 目前佈局（規定路段環站＋建議正方目標格） → LLM 讀圖提出短距離移動 → apply 經與演算法本體 buildShapeAlign 完全相同的拓撲鐵律（topoSafeTowardTargets：每步 makeMover.validMove ＝交叉不增／無撞格／環繞序不變）落地並存到 data/metro/llmshapes。輸入同 Shape-Guided＝格網化後（grid.cellOf，不是 HC 結果）；只自動、只對規定表三城（山手線／新加坡環狀線／大江戶線環形段）。網頁在直線化左選單 ⑨ 區的「LLM 成方（僅比較）」view＋右側「LLM成方」tab，跟 route-llm-align 同一套唯讀 UX：跑完直接顯示、重跑清舊資料。當使用者要求跑/重跑某城市的 LLM 成方、把路線變方形、產生 llmshape、或問 LLM 成方 tab 為何顯示「尚未產生」時使用。演算法本體見 [[route-shape-align]]、共用機構見 [[route-hillclimb]]。
---

# LLM 成方 (route-llm-shape)

⑨ **Shape-Guided（[[route-shape-align]]）的 LLM 版**：演算法本體用 §5 LS 平滑＋
§6 Octi 織形把「規定路段」收成方；本 skill 改由 **LLM（執行本 skill 的模型，也就
是你）**直接讀整數格佈局、提出環站的短距離移動，目標是把規定路段收成**四邊直線
正方**（`isFourLineSquare`：外接正方、環站都在方邊上、相鄰連線皆 H/V）。

> 提案「動哪些點」是你的判斷；**合法性不是**——每輪提案都經
> `applyShapeLlmTargets`（src/stores/paper/shape.js）的 `topoSafeTowardTargets`
> 逐步套用，每一步都過 `makeMover.validMove`（**與演算法本體完全相同的拓撲鐵
> 律**：交叉不增／無撞格／360° 環繞序不變）。你不可能弄壞佈局，只可能提案沒效果
> （被鐵律擋下＝該點停在半路，export 的 rejected 會告訴你卡在哪）。

**與 route-llm-align 的差別**：對齊是純最大化 H/V（`countHVD`）；成方是把**特定一條
規定路段**收成正方（成方是硬目標，非 H/V 計數）。輸入也不同——**成方吃「格網化後」
（`grid.cellOf`）**，與 Shape-Guided 本體相同（對齊吃 HC 結果）。瀏覽器端沒有 API
key 不能即時推論，所以結果**離線算好、存檔、網頁只載入**。

## 只對規定表三城

規定表（`src/stores/paper/shapePresets.js`）目前只開三處，其餘城市 export 回
`skipped`（前端整組 disable）：

- `as-jpn-tokyo-jr` 山手線（整條閉合環）
- `as-sgp-singapore` 環狀線閉合主線
- `as-jpn-tokyo` 大江戶線環形路段（首站重複處切斷）

## 架構

```
scripts/llmShape.mjs export <cityId> <orig|rot>
  → 你讀 ring／suggest／square／rejected、決定 moves（scratchpad 寫 moves.json）
scripts/llmShape.mjs apply <cityId> <orig|rot> <moves.json>
  → 經拓撲鐵律逐步套用、存 data/metro/llmshapes/<cityId>.<variant>.json
  → 印出 square（是否成方）、crosses、rejected 清單 → 你據此再提下一輪 → 成方即停
scripts/llmShape.mjs reset <cityId> <orig|rot>   # 想從頭來
```

- `cityId` = geojson 檔名去副檔名（例 `as-sgp-singapore`）；variant = HC 圖層的
  原始（orig）／旋轉（rot）。佈局格子是排名制 → node 端重建的鏈與 D3Tab 完全一致。
- 結果檔含 `fingerprint`（verts/segs/cols/rows）；資料重抓後不符時網頁顯示「與目前
  資料不符」，`reset` 後重跑即可。
- 起點＝目前 outFile（若符合本資料）或格網化後。重跑（想再改善）直接繼續 apply；
  想從頭先 `reset`。

## 執行迴圈（你要做的事）

1. `node scripts/llmShape.mjs export <cityId> <variant>`。輸出：
   - `route`（規定路線名）、`cols/rows`、`cross0`（輸入交叉數）、`square`（目前是否
     已成四邊方）、`quality`（ar／onEdge／sides）、`box`（W 目前外接正方框）。
   - `ring`：規定路段環站，`[{i,c,r},…]`，**依站序**——`ring[k]` 相鄰 `ring[k+1]`，
     末尾接回首站（閉合環）。`i` = 穩定索引（依 id 排序）。
   - `suggest`：把 ring 均分到四邊（底→右→頂→左）的**建議正方目標格**，`{ "<i>":
     [col,row] }`。可照抄、也可自行微調。
   - `verts`：全部頂點 `[{i,c,r},…]`——**任何點都可移**（不限環站），必要時把擋路
     的非環站先讓開，替方框騰出空間（演算法本體也是整網一起動）。
   - `edges`：邊表 `[[i,j],…]`（索引對，連通性）——**用它把「整條線／整個分支」
     當一組**：沿 edges 走訪連通的一串點，整組一起平移（整組移動的依據）。
2. 分析、提出移動，寫 moves.json 到 scratchpad：
   `{ "model": "<你的模型名，如 Opus 4.8>", "moves": { "<i>": [col, row], … },
     "greens": [ { "a": <i>, "b": <j>, "cell": [col, row] }, … ],
     "note": "<本輪思路摘要>", "prompt": "<第一輪附：觸發本次執行的指示>" }`
   - `model` 選填，**預設 Opus 4.8**（省略時 apply 自動填）——顯示在網頁面板。
   - `note` 每輪都要寫——顯示在右側「LLM成方」面板的逐輪紀錄。
   - `prompt` 第一輪寫一次即可。
   - 座標是**絕對格座標**（不是位移）。一格只能一個頂點。
   - **任何點都可移**（不限環站或它旁邊的點）——被推擠到的點、擋路的內部線，都可
     再移動，只要最終不破論文 D1（交叉不增／無撞格）。但**移動越小越好**。

   ### 綠折點：用最少移動成方（**強烈建議**）
   `greens`（≤4）＝在**相鄰環站 a、b 之間的段上**插入一個轉折控制點，擺在方框角格
   `cell`。這跟演算法本體 `applyShapeGreens`/`splitSegAt` 是同一套：
   - **為什麼要用**：正方要四個直角。若不插綠點，四個角就得是環站本身——那兩側的
     站得被拉到角上、移動很大。**插綠折點當角**後，環站只要**滑到最近的邊上**（很小
     的移動），四個 90° 轉折由綠點負責，network 幾乎不動。成方判準 `isFourLineSquare`
     會走綠折點的 L 形連線，四角綠折仍算「四邊直線正方」。
   - **怎麼放**：選方框四角；每個角找「跨過該角的那一對相鄰環站 a、b」（沿環走時
     從一條邊轉到另一條邊的那一段），把綠點 `cell` 設成該角格。`a`、`b` 用 export
     `ring` 裡的穩定索引 `i`，且必須是 export `edges` 裡真的相鄰（有直接段）的一對。
   - 綠點插好後就凍結在角格（不進 `moves`）。環站的 `moves` 只要把它們對齊到**最近
     的邊**（同 col 或同 row）即可——不必精準落在角上。
   - **綠折點不限四角**：`a`、`b` 是任一對相鄰環站即可。要讓某個「直線邊上的環站」
     留在更靠近原位的地方，就在它兩側補綠折點——邊會走綠折點的 L 形（仍是 H/V），
     成方判準照樣通過。這樣 network 移動更小。

   ### 收方後自動回歸（apply 幫你做，你不用管）
   apply 在成方（未退回）後會自動跑一輪**回歸**：把被推開的站逐步拉回原相對位置，
   只要不破論文 D1；**直線上的環站也會沿方邊/經綠折點微調回歸**（守成方）。回報在
   `settled`（被拉回的站數）。所以你只要把方形收出來，network 形狀的回復交給 apply——
   你要做的是「用綠折點讓四角/邊成形、且一次批到位（via=batch）」。

   ### 核心策略：整組移動、追求 `via=batch`（**最重要**）

   apply 有兩條路徑（回報在 `via`）：
   - **`batch`（整批到位）**＝你提的所有目標「一次擺好」，只檢查**最終狀態**的拓撲
     鐵律（不看逐點中間態）。**這是成方的唯一實際路徑**——四邊直線正方要一次成形。
   - **`greedy`（逐點貪心）**＝batch 沒過關時的退回，逐點朝目標挪、每步都要不破鐵
     律。**收不成完整正方**（環站互相擋、被鐵律卡在半路，rejected 一堆）——看到
     `via=greedy` 就代表你的提案「分批太細」或「漏了擋路的點」，要改成整組提案。

   **為什麼逐點會卡**：環站要收到方框邊上，環**內**那些跨出去的路線（山手線圍住
   中央各線就是這樣）會被壓到、產生交叉；逐點挪時這些交叉是「中間態」，一步一步
   都被鐵律擋。但**若在同一個 moves.json 裡把環站到方形、＋把那些擋路的線/站整組
   一起搬開**，最終狀態沒有交叉 → `batch` 一次過關 → 真的成方。

   **所以每一輪要這樣提**（不是「一輪推幾點」）：
   1. **整條環站**一次給四邊直線正方的目標（四角就位、每邊的站沿邊等距排開，
      對齊 `suggest` 但方向要跟現況環繞序一致——見下方「反轉」注意）。
   2. **同時**把「環站收進方框後會被壓到、或會擋在環站路徑上」的**非環站整組**也
      給目標：環**內**的線往中央收、環**外**的線往外推，整條線/整個分支當一個
      剛體一起平移，別只挪一頭（只挪一頭會把那條線折出新交叉）。
   3. 一次 apply。看 `via`：`batch`＋`square:true` 就成了；還是 `greedy`／
      `square:false` → 讀 `rejected` 找出「還在擋路」的點，把它們也納入整組移動，
      **下一輪提更完整的一批**（愈完整愈容易 batch 過關），而不是把批拆更細。
   - **反轉注意**：`suggest` 是把 ring 均分到四邊的一種擺法；若它的環繞方向跟現況
     相反（shoelace 正負相反＝180°反轉），整組套上去會被鐵律全擋——改用與現況
     **同繞向**的四角指派（把四角落在最接近現況的自然轉角），再沿邊排開。
   - **底線**：目標是 `via=batch`。一次提不出能過 batch 的完整批就迭代**加點**
     （把更多擋路的點納進同一批），不要退回逐點試探。
3. `node scripts/llmShape.mjs apply <cityId> <variant> <moves.json>`。
   讀輸出的 `square`（有沒有成方）、`crosses`（交叉前後，必 `n→n` 不增）、
   `reverted`（整批被退回＝萬一破鐵律；理論上 per-step 已保證）、
   `rejected`（哪些點沒到位：want vs got）。
4. 重複 1–3（每輪 export 反映最新狀態），直到 `square === true` 或你判斷再無進步，
   **上限 10 輪**。rounds 累計存進結果檔。
5. 收尾回報：最終**成方與否**、交叉前後、迭代輪數、移動站數；提醒使用者重整網頁
   （或重開 tab）就能在直線化 ⑨ 區的「LLM 成方」看到。

## 規則

- **絕不手改** `data/metro/llmshapes/` 的檔案——一律經 `apply`（硬規則）。
- **成方是硬目標**：跟演算法本體一樣，破鐵律＝不交付假方（鐵律由 apply 把關，你
  提案不會破，只會沒效果）。但若環站在地理上太糾結、per-step 鐵律下真的收不成
  完整正方，就誠實回報「未完全成方＋卡在哪」——不要謊稱成方。
- 網頁端：直線化左選單 ⑨ 區「格網→貼形（僅比較）」（演算法本體）之下多一個
  「LLM 成方（僅比較）」view；右側面板多一個「LLM成方」tab（模型下拉＋執行鈕＋
  即時串流＋逐輪結果）。**跑完直接顯示**（此 view 本身即成方結果，不像對齊需要
  「執行調整」toggle）。**重新跑會先清掉舊的串流與結果**。
- POST `/llm-shape/run`（vite dev plugin `llmShapeTrigger`）觸發、輪詢
  `/llm-shape/status`。GH Pages 沒有 dev server → 按鈕回報需本機 `npm run dev`。
  測試替身：`LLM_SHAPE_CMD`。跨距上限經 `LLM_SPAN_CAP` env 傳入（與網頁一致）。
- 改了 [[route-hillclimb]] 的硬規則或 [[route-shape-align]] 的鐵律／成方判準，本
  skill 的結果檔可能要重產（fingerprint 擋不住規則變動——必要時 reset 重跑）。
