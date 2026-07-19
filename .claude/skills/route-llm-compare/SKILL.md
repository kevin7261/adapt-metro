---
name: route-llm-compare
description: RWD Maps 四結果 LLM 比較——比較原始或旋轉變體的直角爬山、軸對齊、整數規劃與可用的 LLM 對齊，選出最方正、最直、最少轉折且畫面最平衡者，並逐一說明優缺點。當使用者要求比較 RWD Maps 結果、選最佳演算法、LLM全部評價、或問原始/旋轉哪個後處理最好時使用。
---

# RWD Maps LLM 全部評價

這是唯讀評審，不移動座標、不覆寫四個候選。每個變體（`orig`／`rot`）獨立存一份結果、獨立 runner（可同時跑）。網頁 RWD Maps 右側只有一個「比較」tab，tab 內切換原始／旋轉。

## 流程

1. 執行 `node scripts/llmCompare.mjs export <cityId> <orig|rot>`。
2. 比較所有輸出的 candidates：
   - **方正／直線**：`straightness` 越高越好；`straight` 多、`singleBend`／`doubleBend`／`multiBend` 少越好。
   - **轉折**：`bends` 越少越好。
   - **平衡**：`balance` 越高越好；避免路網偏在畫布一側或只有單向拉長。
   - **硬失敗**：`forced`、`fallback` 最優先避免；同分時 `colinear` 少者較乾淨。
3. 寫入暫存 JSON 後執行 `node scripts/llmCompare.mjs apply <cityId> <orig|rot> <result.json>`。

`result.json` 必須是：

```json
{
  "model": "Opus 4.8",
  "summary": "總結比較結果。",
  "winner": "ilp",
  "winnerReason": "指出數字與視覺原因。",
  "analyses": [
    { "compact": "rect", "strengths": "優點", "weaknesses": "缺點" },
    { "compact": "align", "strengths": "優點", "weaknesses": "缺點" },
    { "compact": "ilp", "strengths": "優點", "weaknesses": "缺點" },
    { "compact": "llm", "strengths": "優點", "weaknesses": "缺點" }
  ]
}
```

只列 export 中實際存在的候選；`llm` 沒有對齊結果時不會出現，不得猜測或硬選它。
