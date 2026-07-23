---
name: route-llm-align
description: LLM 對齊（直線演算法第九條鏈——論文①〜⑧之外的 LLM 鏈）——不用 API key，由 Claude Code 的模型直接當最佳化器：export 目前佈局 → LLM 讀圖提出短距離移動 → apply 經與其他論文鏈相同的硬規則套用並存到 data/metro/llmviews。分兩種獨立結果檔：自動對齊（<city>.<variant>.json，純最大化 H/V）與指定對齊（加 --prompt 旗標寫 .prompt.json，依使用者一句話）。兩者都以「主視圖目前顯示的佈局」為起點（由 vite plugin 在 spawn 前 seed 進 outFile），下游各鏈跟著目前顯示的佈局重算；RWD 'llm' 版面固定以自動對齊為基準。網頁分「LLM自動對齊」「LLM指定對齊」兩 tab，跟 route-llm-eval/route-llm-grid 同一套：跑完不自動套用、按「執行調整」才套用、重跑清舊資料。當使用者要求跑/重跑/更新某城市的 LLM 對齊（自動或指定）、產生 llmview、或問 LLM 對齊 tab 為何顯示「尚未產生」時使用。演算法背景見 [[route-hillclimb]]。
---

# LLM 對齊 (route-llm-align)

直線演算法（論文①〜⑧＋LLM，見 [[route-paper-align]]）中唯一非論文的**第九條鏈**：由 LLM（執行本 skill 的模型，
也就是你）直接讀整數格佈局、提出彩色頂點的短距離移動。目標是
**「H/V 或格對角 45°」對齊段最多**（`countHVD`）——一段對齊 ⇔ 兩端恰有一個座標相同
（H/V），**或** `|dc|===|dr|` 非零（格對角 45°）。**與其他三種不同**：rect/align/ilp
純粹最大化 H/V（`countHV`），本 skill 加入對角（使用者規則：對角走向用 45°、不要把它
硬拉成 H/V 直角樓梯）。這是**格座標** 45°；版面非正方時 RWD 把它畫成 45°＋軸向的斜線
（見 [[route-rwd-draw]]），仍避免直角樓梯。瀏覽器端沒有 API key 不能即時推論，所以
結果**離線預算、存檔、網頁只載入**。

> 提案「動哪些點」是你的判斷；**合法性不是**——每輪提案都經
> `applyLlmTargets`（src/stores/hillClimb.js）套用，與其他三種完全相同的
> 4 條硬規則＋淨 H/V 變差整批退回。你不可能弄壞佈局，只可能提案沒效果。

## 架構

```
scripts/llmAlign.mjs export <cityId> <orig|rot> [--prompt]
  → 你讀 offSegs、決定 moves（scratchpad 寫 moves.json）
scripts/llmAlign.mjs apply <cityId> <orig|rot> <moves.json> [--prompt]
  → 經硬規則套用、存 data/metro/straighten-llm/<cityId>.<variant>[.prompt].json
  → 印出新 HV、rejected 清單 → 你據此再提下一輪 → 收斂即停
```

export 一律以「目前 outFile 內容」為起點（沒有內容才用 **格網化後**，與①〜⑧同
base；**不吃 HC**）。**起點不是你的責任**——vite plugin 在 spawn 你之前，已把
「主視圖目前顯示的佈局」seed 進 outFile（顯示自動→複製 .json、顯示指定→複製
.prompt.json、顯示原佈局→清空從格網化後起）。你只要正常 export→apply 迭代，
**不要自己重設起點、也別去讀別的檔**。

**兩種對齊（結果檔完全獨立、互不覆蓋）**——網頁分成兩個 tab：
- **自動對齊**（`LLM自動對齊` tab）：不加 `--prompt`，寫 `<cityId>.<variant>.json`。
  純粹最大化 H/V，不看使用者指示。
- **指定對齊**（`LLM指定對齊` tab）：export／apply **一律加 `--prompt`**，寫
  `<cityId>.<variant>.prompt.json`。依使用者的一句話決定移動哪些點。只在「LLM 對齊」
  主視圖比較用。
- **起點＝目前顯示的佈局**：兩種對齊都以「LLM 對齊主視圖目前顯示的佈局」為起點。
  這由 vite plugin 在 spawn 前 seed 進 outFile（顯示自動→複製 .json、顯示指定→複製
  .prompt.json、顯示原佈局→清空從格網化後）——你只要正常 export→apply，起點已備好。
- **下游跟著顯示走**：主視圖顯示哪一份（格網化後／自動／指定，由「執行調整」toggle
  決定），下游的「LLM對齊端點移動…」等鏈就以它為輸入、顯示一變就重算（前端負責）；
  RWD 'llm' 版面固定以自動對齊為基準。
- 觸發時照 vite plugin 的 prompt 指明的旗標做，**絕不把指定對齊寫進 `.json`、也不要
  動另一個檔**。

- `cityId` = geojson 檔名去副檔名（例 `as-twn-taipei`）；variant = HC 圖層的
  原始/旋轉。佈局格子是排名制 → node 端重建的鏈與 D3Tab **完全一致**。
- 結果檔含 `fingerprint`（verts/segs/cols/rows/hvStart）；資料重抓後不符時
  網頁會顯示「與目前資料不符」，用 `reset` 後重跑即可。
- 網頁端：跟 [[route-llm-eval]]／[[route-llm-grid]] 同一套唯讀＋切換 UX——右側
  面板「LLM 對齊」視圖（左邊「直線演算法」的 hc-llm）有兩個 tab：**自動對齊**
  與**指定對齊**（介面比照 LLM互動/評價：模型下拉＋執行鈕＋即時串流＋結果＋
  「執行調整」toggle）。
- **跑完不自動套用**：執行時畫布照畫（不留白），回傳文字即時串流在面板內
  （`claude -p --output-format stream-json --verbose` → plugin 解析 → status 的
  `text`）。跑完載入結果但**不套用**——按「執行調整」才用對齊後座標重畫「LLM 對齊」
  主視圖、「恢復原佈局」切回對齊前的格網化後佈局。自動與指定兩個 toggle
  **互斥**（同一個主視圖只能顯示一種）。**重新跑會先清掉舊的串流與結果**。
- **下游跟著顯示走**：各鏈（hc-llm-*）以「主視圖目前顯示的佈局」為輸入——顯示自動
  就用自動、顯示指定就用指定、都沒套用就用格網化後，toggle 一變就重算。RWD 'llm'
  版面（另一個 layer、沒有 toggle）固定以**自動對齊**為基準。
- POST `/llm-align/run`（vite dev plugin `llmAlignTrigger`）帶 `kind`（auto/prompt）
  決定寫哪個檔；指定對齊另帶 `userPrompt`。輪詢 `/llm-align/status`。GH Pages 沒有
  dev server → 按鈕回報需要本機 `npm run dev`。測試替身：`LLM_ALIGN_CMD`。

## 全球批次（最初結果、消畫廊空白）

Straighten／RWD 畫廊的「原始／旋轉・LLM 對齊」縮圖依賴
`data/metro/straighten-llm/<city>.{orig,rot}.json`。缺檔＝「尚未預算」。

一次性為全球城市各算 orig＋rot（**啟發式**短距 H/V／對角，`model: batch-hvd`，
經同一套 `applyLlmTargets` 硬規則；**不是**網頁「開始 LLM 自動對齊」的 headless
Claude）。已有 fingerprint 相符的檔會跳過。結果含 `elapsedMs`（面板執行時間）。
**不含**形狀變體（`orig-shape`／`rot-shape`／成方後 base）——形狀層要另用網頁按鈕
或擴充批次。

```
node scripts/llmAlignBatch.mjs          # 缺檔才算
node scripts/llmAlignBatch.mjs --force  # 全部重算
```

跑完再 `npm run metro:views`（buildViews 會把相符的 llmviews 編進
`hcviews` 的 `loop-llm-*` 與 `rwdviews` 的 `rwd-llm-*`／`compact-llm-*`）。
頭城要細調品質時仍用本 skill 的 export→apply 迴圈（或網頁按鈕）覆寫該城。

## 執行迴圈（你要做的事）

1. `node scripts/llmAlign.mjs export <cityId> <variant>`。輸出：
   `cols/rows`、`hv`（目前 H/V 段數）、`segsTotal`、`verts[{i,c,r}]`
   （i = 依 id 排序的穩定索引）、`offSegs[{a,b,dx,dy}]`（**尚未對齊**＝既非 H/V
   也非格對角的段，dx/dy = b 端減 a 端的格差）、`hvSegs[{a,b,dir}]`（**已對齊、
   不要弄斷**——`dir` = `H`/`V`/**`D`（格對角 45°，`|dc|===|dr|`）**；先由它建每個
   頂點的鎖定表：V 段鎖 col、H 段鎖 row、**D 段鎖對角（兩端相對 col−row 或 col+row
   固定）**，同時被鎖的樞紐點不要動）。
2. 分析 offSegs、提出移動，寫 moves.json 到 scratchpad（或系統暫存）：
   `{ "model": "<你的模型名，如 Fable 5>", "moves": { "<i>": [col, row], … },
     "note": "<本輪思路摘要>", "prompt": "<第一輪附：觸發本次執行的指示>" }`
   - `model` 選填，**預設 Fable 5**（省略時 apply 自動填 `Fable 5`）——顯示在網頁按鈕與右側面板；寫你實際的模型名。
   - `note` 每輪都要寫——顯示在右側「LLM對齊」面板的逐輪紀錄。
   - `prompt` 第一輪寫一次即可（互動 session 摘述使用者要求；headless run
     照 -p 收到的指示寫）。
   - 移動要**短距離**（±1～3 格內），座標是絕對格座標（不是位移）。
   - 策略提示（H/V/對角三選一，取移動最短的）：
     **`|dx|≈|dy|`（對角走向）→ 對到格對角 45°**（把較長軸縮到 `t=min(|dx|,|dy|)`、
     兩端成 `|dc|===|dr|`）——**不要**把對角走向硬拉成 H/V（那會變直角樓梯）；
     `|dy|≪|dx|` → 對齊 row 成水平；`|dx|≪|dy|` → 對齊 col 成垂直。整條鏈（多段
     相連）對到同一 row/col **或同一條對角**收益最大；別動已對齊鏈的公共座標，除非
     整群一起搬；一格只能一個頂點，撞格的提案會被拒。
   - `moves` 留空 = 純記錄 note/prompt（不計輪、佈局不動）。
3. `node scripts/llmAlign.mjs apply <cityId> <variant> <moves.json>`。
   讀輸出的 `hv`（有沒有進步）、`reverted`（整批被退回＝這輪淨值變差）、
   `rejected`（哪些點沒到位：want vs got）。
4. 重複 1–3（每輪 export 反映最新狀態），直到你判斷 HV 不再有進步空間，
   **上限 10 輪**。rounds 會累計存進結果檔。
5. 收尾回報：最終 水平垂直 before → after／總段數、輪數；提醒使用者
   重新整理網頁（或重開 tab）就能在「LLM 對齊」看到。

## 規則

- **絕不手改** `data/metro/straighten-llm/` 的檔案——一律經 `apply`（硬規則）。
- 重跑（資料沒變、想再改善）直接繼續 apply 即可；想從頭來先
  `node scripts/llmAlign.mjs reset <cityId> <variant>`。
- 與①〜⑧的比較基準相同：輸入都是格網化後的 cellOf；
  縮減 tab 用同一個 compactGrid。
- 改了 [[route-hillclimb]] 的硬規則或 applyTargets 行為，本 skill 的結果檔
  可能全部要重產（fingerprint 擋不住規則變動——必要時全城 reset 重跑）。
