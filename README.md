# Adapt-Metro GIS — UI 原型

模仿 [GeoLibre](./GeoLibre-main) 介面的 Vue 3 + Vite UI/UX 原型。只有介面，大部分功能為假（點擊會顯示「尚未實作」提示），供之後開發 GIS 系統時作為外殼。

## 啟動

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 產出 dist/
```

## 版面結構（對應 GeoLibre）

- **頂部選單列** — Project / Edit / View / Add Data / Processing / Controls / Plugins / Settings / Help，右側有深淺色切換與專案名稱
- **左側 Layers 面板** — 圖層樹（含群組）、顯示/隱藏、選取、每層動作選單，可拖曳調寬、可收合成 rail，底部有地點搜尋
- **中間地圖** — 真實 MapLibre GL（OpenFreeMap Liberty 底圖，台北捷運假資料），右鍵有 context menu，站點 hover 有 popup
- **右側 Style 面板** — Symbology 模式、顏色/線寬/透明度（真的會改地圖樣式）、縮放範圍、標註
- **底部屬性表** — 可開關（圖層選單或 ⌘K）、排序、過濾、zoom to feature、可拖曳調高
- **狀態列** — 即時座標 / Zoom / Bearing / Pitch / BBox
- **指令面板** — `⌘K`；快捷鍵表 — `?`
- **Settings 對話框** — 深淺色、accent 主題色（藍/紫/綠/玫瑰/橘）、面板開關

## 主要檔案

- `src/stores/mapStore.js` — Pinia store，所有資料（UI 狀態、圖層清單、假 GeoJSON demoData）都放這裡，之後接真資料從這裡改
- `src/stores/mapHandle.js` — 存放真實 MapLibre 實例的非響應式 handle（刻意不放進 Pinia，避免 proxy 弄壞 MapLibre 內部狀態）
- `src/components/MapView.vue` — MapLibre 初始化，讀寫 `useMapStore()` 同步圖層
- `src/style.css` — 設計 token（複製自 GeoLibre 的 shadcn HSL 變數）

## 狀態管理

全域狀態集中在 Pinia（`useMapStore()`），元件內用 `const store = useMapStore()` 取用：

- `state` — `ui`、`layers`、`groups`、`map`（游標座標/zoom/bearing/pitch/bbox）、`demoData`（假 GeoJSON）等
- `getters` — `selectedLayer`、`allLayersVisible`、`layersInGroup(id)`
- `actions` — `toast(msg)`、`fake(name)`（顯示「尚未實作」提示）
