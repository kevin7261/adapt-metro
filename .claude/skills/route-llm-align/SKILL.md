---
name: route-llm-align
description: LLM 對齊（第四種 H/V 最大化後處理）——不用 API key，由 Claude Code 的模型直接當最佳化器：export 目前佈局 → LLM 讀圖提出短距離移動 → apply 經與其他三種相同的硬規則套用並存到 data/metro/llmviews，網頁的「LLM 對齊」tab 只載入結果（按鈕顯示 輪數＋模型名）。當使用者要求跑/重跑/更新某城市的 LLM 對齊、產生 llmview、或問 LLM 對齊 tab 為何顯示「尚未產生」時使用。演算法背景見 [[route-hillclimb]]。
---

# LLM 對齊 (route-llm-align)

[[route-hillclimb]] 三種演算法後處理之外的**第四種**：由 LLM（執行本 skill 的模型，
也就是你）直接讀整數格佈局、提出彩色頂點的短距離移動，目標與其他三種相同——
**水平/垂直段最多**（一段是 H/V ⇔ 兩端恰有一個座標相同）。瀏覽器端沒有 API key
不能即時推論，所以結果**離線預算、存檔、網頁只載入**。

> 提案「動哪些點」是你的判斷；**合法性不是**——每輪提案都經
> `applyLlmTargets`（src/stores/hillClimb.js）套用，與其他三種完全相同的
> 4 條硬規則＋淨 H/V 變差整批退回。你不可能弄壞佈局，只可能提案沒效果。

## 架構

```
scripts/llmAlign.mjs export <cityId> <orig|rot>   ← 印出目前佈局（JSON）
  → 你讀 offSegs、決定 moves（scratchpad 寫 moves.json）
scripts/llmAlign.mjs apply <cityId> <orig|rot> <moves.json>
  → 經硬規則套用、存 data/metro/llmviews/<cityId>.<variant>.json
  → 印出新 HV、rejected 清單 → 你據此再提下一輪 → 收斂即停
```

- `cityId` = geojson 檔名去副檔名（例 `as-twn-taipei`）；variant = HC 圖層的
  原始/旋轉。佈局格子是排名制 → node 端重建的鏈與 D3Tab **完全一致**。
- 結果檔含 `fingerprint`（verts/segs/cols/rows/hvStart）；資料重抓後不符時
  網頁會顯示「與目前資料不符」，用 `reset` 後重跑即可。
- 網頁端：D3Tab 的「LLM 對齊」＋「LLM 對齊縮減」tab；**按鈕 badge 顯示
  「n輪 · 模型名」**，工具列顯示 水平垂直 before → after／段數、輪數、模型。
- **按鈕觸發（不自動開始）**：切到 tab 只載入既有結果；沒有結果時畫面上有
  「開始 LLM 對齊」鈕（有結果時是「重跑」）——按下去 POST `/llm-align/run`，
  vite dev plugin（vite.config.js `llmAlignTrigger`）spawn **headless
  `claude -p`** 跑本 skill，頁面輪詢 `/llm-align/status`、每輪 apply 落檔後
  畫面即時更新。GH Pages 沒有 dev server → 按鈕會回報需要本機 `npm run dev`。
  測試替身：`LLM_ALIGN_CMD` 環境變數可換掉 `claude` 指令。
- **右側面板「LLM對齊」tab**（Object 後面，StylePanel）：顯示 模型／輪數／
  prompt／逐輪 note／headless run 的最終輸出。資料來源＝結果檔的
  `prompt`、`transcript`、`finalOutput`（trigger plugin 在 run 結束時併入）。

## 執行迴圈（你要做的事）

1. `node scripts/llmAlign.mjs export <cityId> <variant>`。輸出：
   `cols/rows`、`hv`（目前 H/V 段數）、`segsTotal`、`verts[{i,c,r}]`
   （i = 依 id 排序的穩定索引）、`offSegs[{a,b,dx,dy}]`（尚未 H/V 的段，
   dx/dy = b 端減 a 端的格差）、`hvSegs[{a,b,dir}]`（**已對齊、不要弄斷**——
   先由 hvSegs 建每個頂點的鎖定方向表：出現在 V 段的點 col 被鎖、H 段的點
   row 被鎖；同時被鎖 col 和 row 的樞紐點不要動）。
2. 分析 offSegs、提出移動，寫 moves.json 到 scratchpad（或系統暫存）：
   `{ "model": "<你的模型名，如 Fable 5>", "moves": { "<i>": [col, row], … },
     "note": "<本輪思路摘要>", "prompt": "<第一輪附：觸發本次執行的指示>" }`
   - `model` 必填——顯示在網頁按鈕與右側面板；寫你實際的模型名。
   - `note` 每輪都要寫——顯示在右側「LLM對齊」面板的逐輪紀錄。
   - `prompt` 第一輪寫一次即可（互動 session 摘述使用者要求；headless run
     照 -p 收到的指示寫）。
   - 移動要**短距離**（±1～3 格內），座標是絕對格座標（不是位移）。
   - 策略提示：|dy|<|dx| 的段把兩端 row 對齊（改 dy→0 成水平）、反之對齊 col；
     整條鏈（多段相連）對到同一 row/col 收益最大；別動已經對齊的鏈的
     公共座標，除非整群一起搬；一格只能一個頂點，撞格的提案會被拒。
   - `moves` 留空 = 純記錄 note/prompt（不計輪、佈局不動）。
3. `node scripts/llmAlign.mjs apply <cityId> <variant> <moves.json>`。
   讀輸出的 `hv`（有沒有進步）、`reverted`（整批被退回＝這輪淨值變差）、
   `rejected`（哪些點沒到位：want vs got）。
4. 重複 1–3（每輪 export 反映最新狀態），直到你判斷 HV 不再有進步空間，
   **上限 10 輪**。rounds 會累計存進結果檔。
5. 收尾回報：最終 水平垂直 before → after／總段數、輪數；提醒使用者
   重新整理網頁（或重開 tab）就能在「LLM 對齊」看到。

## 規則

- **絕不手改** `data/metro/llmviews/` 的檔案——一律經 `apply`（硬規則）。
- 重跑（資料沒變、想再改善）直接繼續 apply 即可；想從頭來先
  `node scripts/llmAlign.mjs reset <cityId> <variant>`。
- 與其他三種的比較基準相同：輸入都是 Hill Climbing 的 cellAfter；
  縮減 tab 用同一個 compactGrid。
- 改了 [[route-hillclimb]] 的硬規則或 applyTargets 行為，本 skill 的結果檔
  可能全部要重產（fingerprint 擋不住規則變動——必要時全城 reset 重跑）。
