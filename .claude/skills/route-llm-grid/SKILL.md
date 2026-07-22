---
name: route-llm-grid
description: LLM 互動（RWD Maps「AI 改網格長寬」）——不用 API key，由 Claude Code 的模型直接依使用者的一句話（例「把市中心那幾欄拉開」）推理路網網格每個 X 欄／Y 列區間的顯示權重：export 讀欄列脈絡 → 推理權重 → apply 驗證並存到 data/metro/llmgrids，網頁的「LLM互動」tab 載入結果、按「執行調整」才在新像素座標重畫 H/V/45°（跟 route-llm-eval 的執行調整同一套 toggle，跑完不自動套用）。當使用者要求跑/重跑某城市的 LLM 互動、用自然語言改網格大小、產生 llmgrid、或問 LLM互動 tab 為何顯示「尚未產生」時使用。畫線規則見 [[route-rwd-draw]]、同架構的評價功能見 [[route-llm-eval]]。
---

# LLM 互動：AI 改網格長寬 (route-llm-grid)

RWD Maps 的第二種「權重＝大小」比例來源（第一種是流量 weight，見
[[route-rwd-draw]] 的權重驅動版面簡化）：使用者說一句話（「把市中心那幾欄拉開」
「中間幾列拉高」），由 LLM（執行本 skill 的模型，也就是你）推理**每個 X 欄區間、
每個 Y 列區間在畫面上該佔多大（顯示權重）**——不搬任何站的整數格座標，只改
顯示上的欄寬列高。瀏覽器端沒有 API key，所以結果**離線預算、存檔、網頁只載入**。

> 硬性分工：**你**只決定每個 X／Y 區間的 weight（意圖與強度、漸近形狀）；
> **系統**負責正規化外框（總寬總高不變）、分段映射、在新像素空間重畫
> H／V／45° 折線（buildRwdMap）與黑點騎線。你不可能弄壞拓撲，
> 只可能比例不好看。

## 權重語義

- 相鄰兩條 X 刻度之間 = 一個 **X 區間（欄）**；相鄰兩條 Y 刻度之間 = 一個
  **Y 區間（列）**。每個區間一個正數 weight：
  - `1` = 維持原本相對寬高；`>1` = 顯示上放大；`0 < w < 1` = 顯示上壓縮。
- 全部權重被前端 `intervalAxes`（src/stores/rwdWeight.js）**正規化到同一
  繪圖外框**：總寬總高不變，只是內部怎麼切改變。核心放大時外圍自然相對
  變窄——空間才夠「讓」給核心。apply 會把權重夾在 [0.05, 8]。

## 架構

```
scripts/llmGrid.mjs export <cityId> <orig|rot> [hc|rect|align|ilp|llm]
  ← 印出欄列區間＋各欄列的站名脈絡（JSON）
  → 你依使用者的一句話推理 colW/rowW（scratchpad 寫 weights.json）
scripts/llmGrid.mjs apply <cityId> <orig|rot> [compact] <weights.json>
  → 驗證（全區間、正數、夾範圍）、存 data/metro/rwd-llmgrid/<cityId>.<variant>.<compact>.json
```

- `cityId` = geojson 檔名去副檔名（例 `as-twn-taipei`）；variant = 來源 HC
  圖層的 原始/旋轉；compact = RWD 圖層建立時選的縮減網格變體
  （`layer.compact`：'hc' 預設／'rect'／'align'／'ilp'／'llm'）。
- 結果檔含 `fingerprint`（verts/segs/cols/rows/compact）；資料重抓後不符時
  網頁會顯示「與目前資料不符」，用 `reset` 後重跑即可。
- 網頁端：RWD 視圖右側面板的「**LLM互動**」tab（「權重」旁、「LLM評價」前）
  ——不再是獨立的左側視圖。跟 [[route-llm-eval]] 完全同一套 UX：跑完**不自動
  套用**，畫布照畫 RWD 路網、回傳文字即時串流在面板內。
- **執行調整／恢復原佈局（不用 LLM）**：有結果後面板出現「執行調整」鈕——按下
  才用本結果的區間權重（`intervalAxes`）重畫 RWD 的欄寬列高，再按「恢復原佈局」
  切回原本的均勻/流量網格。只是切換顯示、即時、離線、不再 spawn 任何 LLM，可
  來回對齊比較（外框固定、拓撲不變）。
- **按鈕觸發（不自動開始）**：沒有結果時面板有輸入框＋「開始 LLM 互動」鈕——按
  下去 POST `/llm-grid/run`（vite dev plugin spawn **headless `claude -p`** 跑本
  skill），頁面輪詢 `/llm-grid/status`、即時串流回傳文字，跑完自動載入結果（但
  不套用）。GH Pages 沒有 dev server → 按鈕會回報需要本機 `npm run dev`。
  測試替身：`LLM_GRID_CMD` 環境變數可換掉 `claude` 指令。

## 執行流程（你要做的事）

1. `node scripts/llmGrid.mjs export <cityId> <variant> [compact]`。輸出：
   `cols/rows`（區間數）、`columns[{i,stations}]`／`rowsInfo[{i,stations}]`
   （每欄／列上的站名，＊=轉乘站——用來把「市中心」「東側」「紅線那帶」
   落到具體區間；欄 0 最西、列 0 最北）、`current`（既有結果，可作微調基準）。
2. 依使用者的一句話決定目標區間，寫 weights.json 到 scratchpad：
   `{ "model": "<你的模型名，如 Fable 5>", "colW": […], "rowW": […],
     "note": "<本次思路摘要>", "userPrompt": "<使用者的一句話>" }`
   - **輸出完整性**：必須給**全部** X 區間與**全部** Y 區間的 weight（正數），
     不能只回有改的幾格；**只能**回區間 weight——不可回單點座標、也不可
     直接給新軸座標列表（軸位由系統依權重換算）。
   - **縮放要明顯**：核心目標區間 **3–5 倍**（必要時到 6）；至少一組核心
     區間 weight **≥ 3**——若最大值 < 3 通常代表意圖沒做完，加大再推
     （apply 會對 max < 3 印警告）。使用者信任模型推理得出的大幅變化，
     不要保守微調。（純壓縮類意圖例外：核心壓到 0.3–0.5、其餘接近 1。）
   - **漸近而不是單格尖峰**：核心區間最大；緊鄰至少一層同方向略放大當
     緩衝；再外層逐步回到 1 或壓到 0.5–0.9 把空間讓給核心。不可只把某一欄
     突然拉很大、左右完全不動。
   - 未點名、僅維持的區間保持接近 1。
   - 方向解讀：「拉開／放大某帶」通常 X、Y 都要動（那一帶的欄**和**列一起
     放大）；「拉寬」只動欄、「拉高」只動列。
3. `node scripts/llmGrid.mjs apply <cityId> <variant> [compact] <weights.json>`。
   讀輸出確認存檔與 maxW。一次到位即可（不像 LLM 對齊要多輪迭代）；
   若使用者要求微調，以 export 的 `current` 為基準再推一版。
4. 收尾回報：放大了哪幾欄／列（用站名描述）、最大倍率；提醒使用者重新整理
   網頁後在「LLM互動」tab 看到結果，按「執行調整」才會套用到 RWD 路網。

## 規則

- **絕不手改** `data/metro/rwd-llmgrid/` 的檔案——一律經 `apply`（驗證＋夾範圍）。
- 想從頭來：`node scripts/llmGrid.mjs reset <cityId> <variant> [compact]`。
- 與流量權重（[[route-rwd-draw]]）共用「權重＝大小」原語與末端變形
  （intervalAxes 的正規化邏輯 = weightedAxes 的 axis 換算；重畫都走
  buildRwdMap）；差別只在權重由誰填入——兩者不是兩套幾何引擎。
- 改了 compactGrid／buildHillClimb 的行為，結果檔可能全部要重產
  （fingerprint 擋維度變動，擋不住規則變動）。
