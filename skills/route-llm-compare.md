---
name: route-llm-compare
description: RWD Maps 全結果 LLM 比較——一次比較原始與旋轉變體的論文①〜⑧八條鏈（①筆畫法/②直角爬山/③MILP規劃/④力導向/⑤最小平方/⑥八向格網/⑦路徑簡化/⑧SAT規劃）與可用的 LLM 對齊（最多 18 個），選出全體最佳、原始最佳與旋轉最佳，並逐一說明優缺點。當使用者要求比較 RWD Maps 結果、選最佳演算法、LLM全部評價、或問原始/旋轉哪個後處理最好時使用。
---

# RWD Maps LLM 全部評價

這是唯讀評審，不移動座標、不覆寫候選。每個城市一份結果（`data/metro/rwd-compare/<city>.json`）。網頁 RWD Maps 右側「比較」tab 一次跑完。

## 全球批次

一次為全球城市各選出全部／原始／旋轉最佳（啟發式指標排序，寫
`data/metro/rwd-compare/<city>.json`；fingerprint 相符則跳過）：

```
node scripts/llmCompareBatch.mjs          # 缺檔／過期才算
node scripts/llmCompareBatch.mjs --force  # 全部重算
```

結果會出現在 RWD 路網視圖右上角（該視圖若中選）與右側「比較」tab。
單城要 LLM 文字評審時仍用本 skill 的 export→apply（或網頁按鈕）覆寫。

## 流程

1. 執行 `node scripts/llmCompare.mjs export <cityId>`（輸出最多 18 個候選——每變體：論文①〜⑧的 stroke/rect/milp/force/lsq/octi/path/sat＋若存在的 llm；`id`＝`orig.rect`／`rot.milp`／`orig.stroke`…）。
2. 比較所有 candidates：
   - **方正／直線**：`straightness` 越高越好；`straight` 多、`singleBend`／`doubleBend`／`multiBend` 少越好。
   - **轉折**：`bends` 越少越好。
   - **平衡**：`balance` 越高越好；避免路網偏在畫布一側或只有單向拉長。
   - **硬失敗**：`forced`、`fallback` 最優先避免；同分時 `colinear` 少者較乾淨。
3. 寫入暫存 JSON 後執行 `node scripts/llmCompare.mjs apply <cityId> <result.json>`。

`result.json` 必須是（優缺點、結論一律用**字串陣列**條列，每點一句短話）：

```json
{
  "model": "Opus 4.8",
  "summary": ["總結重點一", "總結重點二"],
  "winner": "orig.rect",
  "winnerOrig": "orig.rect",
  "winnerRot": "rot.ilp",
  "winnerReason": ["全體最佳原因"],
  "winnerOrigReason": ["原始組最佳原因"],
  "winnerRotReason": ["旋轉組最佳原因"],
  "analyses": [
    { "id": "orig.rect", "strengths": ["優點一"], "weaknesses": ["缺點一"] },
    { "id": "orig.align", "strengths": ["優點一"], "weaknesses": ["缺點一"] },
    { "id": "orig.ilp", "strengths": ["優點一"], "weaknesses": ["缺點一"] },
    { "id": "orig.llm", "strengths": ["優點一"], "weaknesses": ["缺點一"] },
    { "id": "rot.rect", "strengths": ["優點一"], "weaknesses": ["缺點一"] },
    { "id": "rot.align", "strengths": ["優點一"], "weaknesses": ["缺點一"] },
    { "id": "rot.ilp", "strengths": ["優點一"], "weaknesses": ["缺點一"] },
    { "id": "rot.llm", "strengths": ["優點一"], "weaknesses": ["缺點一"] }
  ]
}
```

規則：

- 只列 export 中實際存在的候選；某變體沒有 LLM 對齊時不會出現 `*.llm`，不得猜測或硬選。
- `analyses` 要涵蓋 export 的**全部**候選（範例只示意部分鏈；實際共最多 18 個）。
- `winner`＝實際存在者中的全體最佳；`winnerOrig` 必須是 `orig.*`；`winnerRot` 必須是 `rot.*`。
- `winner` 可以等於 `winnerOrig` 或 `winnerRot`。
- 每條 strengths／weaknesses 至少一點。
