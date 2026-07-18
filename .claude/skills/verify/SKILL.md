---
name: verify
description: 驗證前端改動（尤其 D3Tab / stores 演算法）沒有改變功能與畫面——啟動 dev server、用 Playwright 驅動真實 UI（匯入台北 → Map Adjust → Straighten → RWD 逐視圖截圖）、收集 console error；重構驗證再開一個 git worktree baseline 跑同一流程做像素比對。當改動 src/ 需要確認「介面功能完全一樣」或跑 runtime 驗證時使用。
---

# 驗證流程（runtime，非測試）

本專案沒有測試套件；驗證＝把 app 跑起來、走到改動的程式碼、觀察畫面與 console。

## 啟動

```bash
npx vite --port 5273 --strictPort   # dev server（背景跑）
```

Playwright 用 anaconda 的 python（系統 python 沒裝）：`/opt/anaconda3/bin/python3`，
chromium 已在 `~/Library/Caches/ms-playwright`。

## 驅動 UI（關鍵選擇器）

1. 匯入城市：`button[title="加入地鐵／鐵路／高速公路"]` → `.import-menu .menu-item`
   第 0 項（城市）→ 快速鍵 `button:has(.quick-zh)` 文字如「台北 · 台灣」。
2. 圈層面板：`.layer-panel .layer-row`——第 0 列 Raw Maps、第 1 列 Map Adjust；
   Straighten / RWD 子群組**預設展開**（點 `.subgroup-header` 會收合，別點），
   巢狀列 `.layer-row.nested`（Straighten 2 列在前、RWD 8 列在後）。單擊即開 tab。
3. D3 視圖左選單：分組 `.view-nav-group`（`aria-expanded`）、項目
   `.view-nav-item:text-is("…")`（如 原始骨架化 / Hill Climbing / 直角爬山 / RWD 路網）。
4. 截圖前等 `.ma-hint`（載入中…／爬山最佳化中…）消失；hover tooltip 先把滑鼠移到 (5,5)。
5. console error 用 `page.on('console'/'pageerror')` 收集，應為 0。

## 重構的像素比對

```bash
git worktree add <scratch>/baseline HEAD
ln -s $PWD/node_modules <scratch>/baseline/node_modules   # 共用依賴
# baseline 用另一個 port（如 5274），兩邊跑同一支驅動腳本、PIL ImageChops 比對
```

D3 畫布是決定性的（同資料同視窗＝同像素）；允許 ≤7/255 的抗鋸齒雜訊。
MapLibre Raw Maps tab（磚圖底圖）載入時序不定，**不要拿來比像素**。
比完 `git worktree remove --force` 清掉。

## 陷阱

- localStorage 有爬山快取（`d3tab-hc-cache-v*`）與 session 持久化——Playwright
  用全新 context 即乾淨；手動測試改了演算法要記得清。
- 台北匯入後 HC 計算約數秒，busy 提示會蓋畫布，等它消失再截圖。
