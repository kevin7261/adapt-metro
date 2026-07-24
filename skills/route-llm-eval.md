---
name: route-llm-eval
description: LLM 評價（RWD Maps「AI 評路網佈局」）——不用 API key，由 Claude Code 的模型直接當評審：export 讀縮減網格佈局的幾何脈絡（逐線段方向統計、彎折數、頂點鏈）→ 模型寫評價（哪些線可以更直/更水平、更方正、彎太多…）＋把建議轉成具體 moves → apply 過硬規則把調整後佈局存進結果檔（data/metro/llmevals），網頁「LLM評價」tab 載入顯示、「執行調整」按鈕不跑 LLM 直接切換 套用⇄恢復 比較前後。評價不修改佈局本身。當使用者要求跑/重跑某城市的 LLM 評價、產生 llmeval、或問 LLM評價 tab 為何顯示「尚未產生」時使用。畫線規則見 [[route-rwd-draw]]、同架構的調整功能見 [[route-llm-grid]]。
---

# LLM 評價：AI 評路網佈局 (route-llm-eval)

RWD Maps 的評審功能：使用者按「開始 LLM 評價」，由 LLM（執行本 skill 的模型，
也就是你）閱讀目前縮減網格佈局的幾何，回傳**對這個路網的評價**——例如哪一帶的
線可以調整讓水平/垂直線更多、整體可以更方正、哪條線彎折太多可以更直。
瀏覽器端沒有 API key，所以結果**離線產生、存檔、網頁只載入**。

> 硬性分工：**你**只寫評語與建議（總評、面向評分、逐線評語、調整建議）；
> **系統**一個座標都不會動——這是唯讀的評審，與 [[route-llm-align]]（會動座標）
> 和 [[route-llm-grid]]（會改欄寬列高）不同。建議只是文字，不執行。

## 架構

```
scripts/llmEval.mjs export <cityId> <orig|rot> [hc|rect|align|ilp|llm]
  ← 印出佈局幾何（JSON）：全網統計＋逐線報告＋頂點鏈
  → 你閱讀後寫評價（scratchpad 寫 eval.json）
scripts/llmEval.mjs apply <cityId> <orig|rot> [compact] <eval.json>
  → 驗證（summary 必填、model 選填**預設 Fable 5**、score 夾 0–10）、存 data/metro/rwd-llmeval/<cityId>.<variant>.<compact>.json
```

- `cityId`／`variant`／`compact` 與 [[route-llm-grid]] 同義（結果檔名同三段）。
- **佈局來源與網頁嚴格一致（全城市通用）**：export/apply 的縮減網格佈局
  1. **第一優先＝持久檔** `data/metro/straighten-cells/<city>.<variant>[-shape.shapelike].json`
     的 `loops[compact]`（bakeHcCells 預烤＋網頁 persistHcCells 寫回、網頁「開分頁只讀檔」
     的同一份）——收/拒條件與網頁同一套（`HC_CELLS_ALGO_READ`＋`dataFingerprint:rg` 指紋），
     保證 cols/rows 與網頁一致，演算法漂移也不分岔；
  2. 無檔/被拒（網頁也會重算的情況）→ 退回與網頁相同的現場重算管線。
- **成方餵 HC**（scripts/_shapeFeed.mjs，與 [[route-llm-grid]] 共用）：城市成方
  （square===true）且套用中時，網頁下游鏈吃成方佈局＋凍結成方頂點——腳本亦同
  （選 `-shape.shapelike` 持久檔／重算時以成方佈局起算＋setFrozen）。網頁按鈕把當下
  成方狀態隨 run 傳入（`LLM_SHAPE_FEED` env：1 開/0 關；手動 CLI 未設＝自動偵測，
  同網頁預設）。漏掉這步該城市的評價**一產生就 stale、重跑也治不好**。
- 結果檔含 `fingerprint`（verts/segs/cols/rows/compact），分**兩層有效性**（重要）：
  - **骨架層 `verts`／`segs`（＝站與拓撲，圖面本身）** 決定**評語**是否有效。
    骨架相同時評語永遠可讀（網頁「以圖面為主」照顯示總評/分數/逐線/建議，不因網格
    重壓縮而失效）；export 偵測到骨架相同會把舊評語當 `current` 脈絡餵回，重跑時沿用。
  - **網格層 `cols`／`rows`／`compact`（＝壓縮後的整數格佈局）** 決定**執行調整**
    （`exec.cells`）是否有效。`exec.cells` 是「評價當時那張壓縮底圖＋微調」的**絕對格
    座標快照**——壓縮演算法一改（網格尺寸變），快照就對不上新底圖，套用會把整個路網
    搬回舊底圖（連結順序/方向/相對位置全變，**不是只讓路網更方正**）。所以網頁在網格
    變動時**停用「執行調整」**、要**重跑**才會在新底圖上重算出有效的 exec；評語不受影響。
  - `export` 回報 **`gridChanged`**：骨架相同但網格已重排時為 `true`——代表評語可沿用/
    微調，但 **`moves` 必須照目前 `stats.cols`×`rows` 重寫、`exec` 會在新底圖重算**。
    看到 `gridChanged:true` 就是「重跑補上新網格的執行調整」的情境。
  - 骨架也變（重抓資料改了站/拓撲）時整份視為不存在，網頁顯示「與目前資料不符」，
    `reset` 後從頭重評即可。
- 網頁端：RWD 視圖右側面板的「**LLM評價**」tab（「LLM調整」旁）——按鈕 POST
  `/llm-eval/run`（vite dev plugin spawn headless `claude -p` 跑本 skill）、輪詢
  `/llm-eval/status` 即時串流回傳文字，跑完自動載入顯示。GH Pages 沒有 dev
  server → 按鈕會回報需要本機 `npm run dev`。測試替身：`LLM_EVAL_CMD` 環境變數。
- **執行調整（不用 LLM）＋恢復**：評價時你就要把建議轉成具體 `moves`（見下），
  apply 會經 `applyLlmTargets`（與 [[route-llm-align]] 完全相同的硬規則）套用在
  縮減網格佈局上、把調整後佈局（`exec.cells`）、H/V 前後數字與被拒提案
  （`exec.rejected`）一併存進結果檔。網頁的「執行調整」按鈕**只是切換顯示**
  （套用 exec.cells ⇄ 恢復原佈局，網格尺寸不變、可對齊比較）——即時、離線、
  不再 spawn 任何 LLM。舊結果檔沒有 exec 時面板會提示重新評價補上。

## export 給你的脈絡

- `stats`：cols/rows（縮減網格大小）、segs（段總數）、h/v/hv（水平/垂直段數）、
  d45（45° 段）、`other`（**畫出來一定有折彎**的段——RWD 畫線的單折/雙折候選）、
  **`acute`（全網銳角總數——最優先消除的目標）**。
- `lines[]`：逐線 `{ name, color, segs, H, V, D45, other, bends, acute, acuteAt, chains }`——
  `bends`＝這條線方向改變的內部頂點數（彎折）；**`acute`＝其中「進出兩段夾角＜90°」的
  銳角尖折數、`acuteAt`＝這些銳角在哪些站**（該優先改成 90° L 形直角或 180° 直通）；
  `chains`＝有序頂點鏈「站名(c,r)」（×＝幾何交叉點），c 向東遞增、r 向南遞增。
  > 銳角判準：頂點 B 的內角由 `(A−B)·(C−B)` 決定——>0＝銳角（含 45° 尖折與 180° 回折
  > hairpin，**要消除**）；=0＝90° 直角（L 形，OK）；<0＝鈍角（含 45° 過渡的 135° 與直通，OK）。
- `verts[]`：`{ i, name, c, r }`——**moves 的索引來源**（依 id 排序、每次執行
  順序一致），`moves["<i>"] = [目標c, 目標r]`。
- `current`：既有評價的 summary（重跑時可對照）。

## 執行流程（你要做的事）

1. `node scripts/llmEval.mjs export <cityId> <variant> [compact]`。
2. 讀幾何脈絡，寫 eval.json 到 scratchpad：
   ```json
   {
     "model": "<你的模型名，如 Fable 5>",
     "summary": "<總評 3–6 句：整體水平垂直程度、方正度、最需要改的地方>",
     "scores": [
       { "aspect": "水平垂直", "score": 7, "comment": "…" },
       { "aspect": "方正度", "score": 6, "comment": "…" },
       { "aspect": "彎折少", "score": 5, "comment": "…" },
       { "aspect": "平衡與留白", "score": 7, "comment": "…" }
     ],
     "lines": [{ "name": "<線名>", "comment": "<這條線哪一段可以更直/更水平、彎在哪>" }],
     "suggestions": ["<具體可行的調整方向>", "…"],
     "moves": { "<verts 的 i>": [目標c, 目標r], "…": [c, r] },
     "userPrompt": "<使用者的關注點（有才填）>"
   }
   ```
   - **評語要落地**：用 export 的站名與數字說話（「松山新店線 10 段有 7 個彎，
     西門—中正紀念堂一帶連續轉向」），不要空泛（「可以更整齊」）。
   - **逐線評語挑重點**：彎折多（bends 高）、other 段多、或明顯可拉直的線才列，
     0 彎的支線不用逐條寫。
   - scores 面向固定用上面四個（分數 0–10）；**「方正度」與「彎折少」的分數由銳角
     主導**——`stats.acute`＞0 時這兩項不該給高分，總評（summary）第一句就先點出還有
     幾個銳角、在哪條線。suggestions 3–6 條、每條一句話、說清楚「哪裡、往哪個方向調、
     預期換到什麼」，**消除銳角的建議排最前面**。
   - **moves＝建議的具體化**：每條 suggestion 都要對應到 moves 裡的實際移動
     （用 verts 的 i 指涉、目標格在網格內、短距離為主）。移動只改顯示切換用的
     exec，不動評價對象的佈局本身。

   **moves 的四大目標**（評語與建議都圍繞這幾點，優先序由上而下，**銳角最優先**）：

   0. **先消除銳角（最高優先，使用者：要先盡量不要銳角）**：任何「進出兩段夾角＜90°」
      的尖折（`stats.acute`／逐線 `acute`／`acuteAt` 直接點名在哪些站）一律先改掉——
      **一個銳角尖角 → 一個 90° L 形直角 `-|`／`|-`，或 180° 直通**（把該頂點或其中一段
      整排移到讓夾角變 ≥90°）。寧可 L 形直角、也絕不留銳角。先掃 `acute>0` 的線、把
      `acuteAt` 的每個站排進 moves，再談下面的拉直/最短。（45° 過渡的 135° 鈍角不是銳角、不用動。）
   1. **同路線盡量直線**：把整條線拉成連續同向的直線，中間頂點排到同一
      row/col，不只逐段湊 H/V。具體要消除三種形狀——(a) 平行同向段被斜段隔開的
      「H→斜→H」/「V→斜→V」——兩端同 row/col 時把中間頂點移回該 row/col；兩段
      分屬**不同 row/col** 時，把其中一整段（連同其頂點整排）平移到另一段的
      row/col，讓斜段消失、兩段併成一條連續直線（如綠線上段水平整排下移對齊
      下段，合成一條長水平）；(b) 孤立 45°/斜段
      （兩端 c、r 都不同）、或連續小折往同方向爬升的**階梯狀**（H→斜→H→斜…），
      整段收成一個 L 形 `-|`／`|-`（把中間頂點移到同 row 或同 col，只留一個
      直角轉折）——寧可一個 90° 直角也不要一路斜著或多個小折。掃 `lines[]` 裡
      `bends`／`other`＞0 的線就是候選。
   2. **線盡量最短**：拉直/去折之後，若整條線能整體往內收（縮短總長、去掉繞路
      的多餘轉折）就一併收，不要為了對齊反而拉出更長的繞行；同樣路徑取最短。
   3. **整體直線要最多**：整組 moves 的淨效果必須讓 H/V 段數增加（apply 輸出的
      `exec` hvAfter > hvBefore），不能只是換個彎法；做不到就縮小或放棄該組提案。
   > **絕不製造新銳角**：任何一步 move 若把某個 90°/135° 頂點變成銳角，就是退步，
   > 寧可不做。目標是 `acute` 淨減、最好歸零。

   **手法與護欄**：
   - **移動對象不限單點**：單一頂點、或整條水平/垂直線上的一串頂點整排平移都
     可以（moves 裡把該排每個頂點都給同方向的目標格）。
   - **偏好小範圍調整**：能用鄰近一兩格的小移動達成的（拉直、消斜、去銳角、
     縮短），就不要為此大動整片網格；以最小位移換到最多直線/直角/最短為原則。
   - **相鄰路線可連動**：為了讓某條線變直/變短，周邊相連路線的頂點（轉乘站、
     鄰近站）可以對應一起移。
   - **拓撲不變**：以上一切前提是不改變拓撲——由 apply 的硬規則把關，違反會進
     `rejected`，照步驟 3 迭代即可。這條鐵律是**相對 apply 當下的底圖**成立的：
     exec 存的是那張底圖的絕對座標，所以底圖（網格）一換就必須重跑重算（見上「兩層
     有效性」），不能拿舊 exec 套到新底圖——那會破壞相對位置，等於改了拓撲的呈現。
3. `node scripts/llmEval.mjs apply <cityId> <variant> [compact] <eval.json>`，
   讀輸出的 `exec`：H/V 前後、`rejected`（被硬規則拒絕的提案）。**被拒的提案
   要迭代**：改目標格（或放棄該條）再 apply 一次，直到 rejected 清空或確認
   剩餘的確實不可行（apply 可重複執行、直接覆寫）。
4. 收尾回報：只輸出一句總結，**開頭先標明是哪一個模型做的**（與 eval.json 的
   `model` 一致，如「Fable 5：…」）＋總評第一句＋執行調整的 H/V 前後數字；
   提醒使用者重新整理網頁就能在「LLM評價」tab 看到全文並一鍵「執行調整」。

## 規則

- **絕不手改** `data/metro/rwd-llmeval/` 的檔案——一律經 `apply`（驗證）。
- 想從頭來：`node scripts/llmEval.mjs reset <cityId> <variant> [compact]`。
- 評的是**縮減網格的整數格佈局**（RWD 畫線的輸入）：H/V/D45 段畫成直線、
  other 段一定折彎——所以「把某段變成 H/V/45」就是「少一個彎」的同義詞。
- 演算法背景見 [[route-hillclimb]]（佈局怎麼來）、[[route-rwd-draw]]（怎麼畫）。
