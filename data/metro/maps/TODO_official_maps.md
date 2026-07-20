# 官方路線圖策展 — 待辦（2026-07）

## 政策（使用者裁決）

1. **只要真正官方**（營運商/運輸局自己發行的路網圖），社群/維基自製圖**只在沒有官方版時**才保留，並在 `maps_index.json` 的 `license` 標「Official operator map」vs 一般 CC 授權區分。
2. **官方圖若是半地理圖也可接受**（如台中捷運綠線圖、薩爾瓦多 Metrô Mapa das Linhas）——只要是營運商正式發行、淺底、清楚的彩色路網圖，不強求嚴格 H/V/45° 示意圖。
3. **純地理/衛星/GIS 圖、照片、純規劃圖、黑底圖**——一律不用。
4. **連社群示意圖都沒有的城市 → 留白**（`map_file: null`），不要湊地理圖佔位。
5. 圖一律**下載存成本地檔**（`data/metro/maps/**.png`），不用外連 URL。PDF/SVG 用 macOS `qlmanage -t -s 2400 -o <dir> <file>` 轉 png（PDF 只轉第 1 頁，多頁文件內頁抓不到）；jpg/gif/webp 用 `sips -s format png`。
6. 覆蓋同路徑圖檔後，記得 bump `maps_index.json` 頂層 `_rev`（時間戳）——前端用它做 `?v=` 破除瀏覽器快取，不然使用者會一直看到舊圖。

## 現況（2026-07-21 更新）

- ✅ 官方營運商圖：**95**（+5）
- 🟡 社群/Commons 示意圖（無官方版或官網此環境抓不到）：86
- ⬜ 留白：**42**（-5）

> `maps_index.json` 共 224 筆，但 `metro:build` 後系統數已達 **235**——科恰班巴
> （新增，見 [[metro-city-guadalajara]]）、東京 JR、大阪 JR 與地標變體等 **11 個系統
> 在地圖索引裡沒有對應條目**，需另行補齊。

### 2026-07-21 這輪的結果

派 10 個 agent，**9 個在 session 額度耗盡時陣亡**（僅 China B 完成）。死前下載的 89 個檔案
已保全在 `_staging_2026-07-21/`（gitignored），額度回來後可直接驗證、不必重抓。

**新增 5 張（全部經人工目視驗證）**：金華、雅典、杜林、京都、橫濱。

**驗證後剔除**：河內（衛星空拍圖疊線）、巴庫（深色底地理圖）、洛陽（官方版本身就是
地形底圖）、南通（只有遠期規劃圖）、台州（營運商無官網）、滁州（南京官方圖不含寧滁線）。

**⚠️ provenance 缺口**：雅典/杜林/京都/橫濱這 4 張的 `source_url` 為 `null`——agent 在回報前
被砍，來源網址遺失，PDF 內嵌中繼資料也只有 Adobe XMP 命名空間、挖不出下載來源。
**不得憑印象補寫**，需重新到營運商官網確認後補上（圖檔本身已驗證合格，可照常使用）。

**已移出的殘留錯誤檔**（`_staging_2026-07-21/_rejected_leftovers/`）：洛陽/滁州/南通/台州
四城路徑下的舊檔——其中 `as-chn-chuzhou.png` 其實是**舊版南京地鐵圖**，留著會誤導。
留白城市路徑下若還有 png/svg，**不代表已抓到**，多為歷次策展判退的殘留。

## 待辦 A：47 個留白城市——找官方圖

用平行 agent（**這週 Agent 額度已用完，需等 2026-07-22 14:00 Asia/Taipei 重置**），比照台中/薩爾瓦多的做法：**用 WebFetch 直接讀營運商官網頁面**（curl 常被 Cloudflare/WAF 擋，WebFetch 有時能穿透）找出實際圖檔 URL，再 curl 下載＋驗證＋套用。

47 城清單（slug｜城市｜國家）：

| slug | 城市 | 國家 |
|---|---|---|
| af-alg-algiers | 阿爾及爾 | Algeria |
| am-bra-belo-horizonte | 貝洛奧里藏特 | Brazil |
| am-bra-brasilia | 巴西利亞 | Brazil |
| am-bra-recife | 雷西非 | Brazil |
| am-pan-panama-city | 巴拿馬城 | Panama |
| am-usa-miami | 邁阿密 | United States |
| as-aze-baku | 巴庫 | Azerbaijan |
| as-chn-chuzhou | 滁州 | China |
| as-chn-dalian | 大連 | China |
| as-chn-hefei | 合肥 | China |
| as-chn-jinhua | 金華 | China |
| as-chn-lanzhou | 蘭州 | China |
| as-chn-luoyang | 洛陽 | China |
| as-chn-nantong | 南通 | China |
| as-chn-taizhou | 台州 | China |
| as-chn-wenzhou | 溫州 | China |
| as-chn-wuhan | 武漢 | China |
| as-ina-jakarta | 雅加達 | Indonesia |
| as-ind-hyderabad | 海得拉巴 | India |
| as-ind-indore | 印多爾 | India |
| as-ind-kolkata | 加爾各答 | India |
| as-ind-mumbai | 孟買 | India |
| as-ind-pune | 浦那 | India |
| as-iri-isfahan | 伊斯法罕 | Iran |
| as-iri-karaj | 卡拉季 | Iran |
| as-iri-mashhad | 馬什哈德 | Iran |
| as-iri-shiraz | 設拉子 | Iran |
| as-iri-tabriz | 大不里士 | Iran |
| as-jpn-kyoto | 京都 | Japan |
| as-jpn-saitama-prefecture | 埼玉縣 | Japan |
| as-jpn-yokohama | 橫濱 | Japan |
| as-kaz-astana | 阿斯塔納 | Kazakhstan |
| as-kor-gwangju | 光州 | South Korea |
| as-pak-lahore | 拉合爾 | Pakistan |
| as-tur-adana | 阿達納 | Turkey |
| as-tur-bursa | 布爾薩 | Turkey |
| as-vie-hanoi | 河內 | Vietnam |
| as-vie-ho-chi-minh-city | 胡志明市 | Vietnam |
| eu-aut-bezirk-landeck | 蘭德克縣 | Austria |
| eu-esp-bilbao | 畢爾包 | Spain |
| eu-fra-lille | 里爾 | France |
| eu-fra-rennes | 雷恩 | France |
| eu-ger-dusseldorf | 杜塞道夫 | Germany |
| eu-gre-athens | 雅典 | Greece |
| eu-ita-brescia | 布雷西亞 | Italy |
| eu-ita-genoa | 熱那亞 | Italy |
| eu-ita-turin | 杜林 | Italy |

> 巴拿馬城備註：官方示意圖只嵌在多頁 pocket-guide PDF 第 2–3 頁（`elmetrodepanama.com`），`qlmanage` 只轉得到封面頁，需要能翻頁的 PDF 轉檔工具（或找獨立單頁官方圖）。

## 待辦 B：86 個社群圖城市——官方版可能只是這次抓不到

這次（2026-07）分兩波共派 20 個 agent 找官方圖，多數城市的官網被**地區封鎖 / Cloudflare / WAF / DNS 解析失敗**擋下，agent 明確回報「官方確實有示意圖，但這個環境抓不到」的城市（值得之後從沒被擋的網路重試，**這份清單是憑對話記錄整理，未必完整**）：

- 羅馬 eu-ita-rome（ATAC 有 bot 防護）
- 莫斯科 eu-rus-moscow（mosmetro.ru 連線被拒）
- 重慶 as-chn-chongqing（cqmetro.cn 地區封鎖）
- 北京 as-chn-beijing（官方圖是互動 JS canvas，非靜態圖）
- 廣州 as-chn-guangzhou（cs.gzmtr.com 地區封鎖）
- 成都 as-chn-chengdu（cdmetro.cn 地區封鎖）
- 洛桑 eu-sui-lausanne（tl 官方確有示意圖，F5 WAF 擋直接抓取）
- 華沙 eu-pol-warsaw（Incapsula 擋）
- 哥本哈根 eu-den-copenhagen（m.dk 只有互動式線圖、無靜態檔）
- 塞維亞 eu-esp-seville（metrodesevilla.es 連線被拒）
- 里昂 eu-fra-lyon（tcl.fr Cloudflare 擋）
- 基輔 eu-ukr-kyiv（metro.kyiv.ua 403）
- 曼谷 as-tha-bangkok（BEM/BTS 都擋或只有互動地圖）
- 福塔萊薩 am-bra-fortaleza（F5 WAF + 憑證過期）
- 利雅德 as-ksa-riyadh（riyadhmetro.sa 網域不存在、rpt.sa 403）
- 塔什干 as-uzb-tashkent（uzmetro.uz 只有互動元件）
- 明斯克 eu-blr-minsk（只有互動 HTML/SVG）

其餘社群圖城市多半是「官方圖本身也是地理圖」（如聖多明哥、雅加達地鐵、阿赫馬達巴德…），這些**維持社群圖即可**，不必重試官網。

## 執行方式建議

Agent 額度重置後：
1. 待辦 A（47 城）優先，用 8–10 個平行 agent，prompt 比照本次「Fill blank city maps」那批（含 WebFetch 找靜態圖 URL、Wayback 備援、半地理官方圖可接受）。
2. 待辦 B 挑幾個大城市（北京/廣州/成都/羅馬/莫斯科優先）試試看換一個網路環境或用 Wayback 快照。
3. 每批下載後用 Playwright 產生接觸表截圖人工複驗，勿盲目套用。
4. 套用後記得 bump `maps_index.json` 的 `_rev`。
