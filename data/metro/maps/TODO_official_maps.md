# 官方路線圖策展 — 待辦（2026-07）

## 政策（使用者裁決）

1. **只要真正官方**（營運商/運輸局自己發行的路網圖），社群/維基自製圖**只在沒有官方版時**才保留，並在 `maps_index.json` 的 `license` 標「Official operator map」vs 一般 CC 授權區分。
2. **官方圖若是半地理圖也可接受**（如台中捷運綠線圖、薩爾瓦多 Metrô Mapa das Linhas）——只要是營運商正式發行、淺底、清楚的彩色路網圖，不強求嚴格 H/V/45° 示意圖。
3. **純地理/衛星/GIS 圖、照片、純規劃圖、黑底圖**——一律不用。
4. **連社群示意圖都沒有的城市 → 留白**（`map_file: null`），不要湊地理圖佔位。
5. 圖一律**下載存成本地檔**（`data/metro/maps/**.png`），不用外連 URL。PDF/SVG 用 macOS `qlmanage -t -s 2400 -o <dir> <file>` 轉 png（PDF 只轉第 1 頁，多頁文件內頁抓不到）；jpg/gif/webp 用 `sips -s format png`。
6. 覆蓋同路徑圖檔後，記得 bump `maps_index.json` 頂層 `_rev`（時間戳）——前端用它做 `?v=` 破除瀏覽器快取，不然使用者會一直看到舊圖。

## 現況（2026-07-21 更新）

- ✅ 官方營運商圖：**113**
- 🟡 社群/Commons 示意圖（無官方版或官網此環境抓不到）：85
- ⬜ 留白：**26**

> ### 2026-07-21 平行 agent 收官（16 城新增官方圖）
> 額度重置後派 6 個平行 agent 掃 41 留白城，逐城「找官方圖→下載→**agent 自行讀圖驗證**
> →存 PNG」，agent **不碰 maps_index.json**（避免並行寫入互相蓋掉），回報後由主 session
> 逐張抽查再寫 index。命中率被「官網 WAF/地區封鎖」與「官方圖本身是地理/規劃圖」兩個
> 因素卡住，屬正常。
>
> **新增官方圖（16）**：廣島（電車路線図，本輪稍早）、Lille、貝洛奧里藏特、巴西利亞、
> 雷西非、巴拿馬城、邁阿密、Hyderabad、Pune、Mumbai、Wuhan、Isfahan、Shiraz、Bursa、
> Bilbao、Brescia、Düsseldorf。（Düsseldorf 推翻先前「無官方圖」判定——Rheinbahn 官方
> Netzplan 2026-03 從 CDN 取得。）
>
> **26 城維持留白（分兩類）**：
> - *官網此環境抓不到*（region-block/WAF/DNS）：多數中國城（大連/合肥/蘭州/溫州/台州/
>   洛陽/南通/滁州）、加爾各答、胡志明市、Karaj、Lahore、Adana、Algiers、Rennes…
> - *找得到但依政策判退*（地理圖/衛星/規劃圖/深底）：Indore(GIS 規劃)、Tabriz(全線畫實線
>   的規劃圖)、Baku(深底地理)、Jakarta(Google Maps 截圖)、Hanoi(規劃圖)、Gwangju(規劃圖)、
>   埼玉(觀光導覽圖)、Genoa(地理街圖)、Cochabamba(只有社群圖)、Panama Nueva Red Maestra(規劃圖，已改用 L1+L2 營運圖)。
> - *無地鐵*：Bezirk Landeck（只有纜車＋區域巴士）。
>
> ⚠️ **Astana 懸而未決**：agent 抓到一張單綠線圖，但來源是新聞站鏡像、圖上**無任何營運商
> 標題/logo/圖例**，無法確認是官方圖還是媒體製圖 → 主 session 判退、**未寫入 index**（維持
> 留白）。但該 PNG 已被 workflow 連同其他圖一起 commit 進 `data/metro/maps/asia/kazakhstan/
> as-kaz-astana.png`，成為**未被 index 引用的孤兒檔**。待使用者裁決：要嘛找到有品牌的官方
> 版寫入、要嘛 `git rm` 該檔。

> 數字請以實際重數為準（下方待辦 A 的 47 城表已過時）：
> ```
> python3 -c "import json;d=json.load(open('data/metro/maps/maps_index.json'));m={k:v for k,v in d.items() if isinstance(v,dict)};o=[s for s,v in m.items() if v.get('map_file') and 'Official operator map' in (v.get('license') or '')];print('official',len(o),'blank',len([s for s,v in m.items() if not v.get('map_file')]))"
> ```

> **✅ 索引缺口已補齊（2026-07-21）**：先前 `metro:build` 後系統數 235、maps_index
> 只有 224 筆。實際比對後缺 12 個（非 11），已處理：
> - **科恰班巴**（獨立系統）→ 補 `map_file:null` 條目，暫留白（無官方示意圖；找圖屬留白城市工作）。
> - **東京 JR / 大阪 JR**（JR 合併系統）與 **`-lm` 地標變體**：使用者最終裁決（2026-07-21）
>   ——這些變體的官方圖**一律跟母城東京/大阪顯示同一張**，不給獨立 JR 圖。做法＝
>   maps_index **不放** `-jr`/`-lm` 條目，靠 `metroCatalog.js` 的 `mapsKeyBase()` 去尾綴
>   fallback 到母城。⚠️ 注意：**不可**放 `map_file:null` 條目——那會讓 tile 顯示「無圖」
>   而非 fallback（`rec = index[key] || index[base]`，key 存在但 null 就中斷 fallback）。
>   （曾一度照前一個選擇給 tokyo-jr/osaka-jr 各自的 JR East/West 官方圖，後依此裁決撤回。）
>
> ⚠️ 注意：這些手工策展的官方圖（含本次 JR、NYC/London/Tokyo 等）都是本地營運商檔、
> 不在 Commons，**無法用 `_overrides/map_overrides.json` 釘選**（該機制只吃 Commons 檔名
> 或 no-map 釘選）。故一旦跑 `downloadMaps.mjs` 全量重建會被清成 null 並刪 png——
> 目前策展流程是手改 `maps_index.json`，**不要再跑 downloadMaps 全量重建**（只可 `--only`）。

### 2026-07-21 這輪的結果

派 10 個 agent，**9 個在 session 額度耗盡時陣亡**（僅 China B 完成）。死前下載的 89 個檔案
已保全在 `_staging_2026-07-21/`（gitignored），額度回來後可直接驗證、不必重抓。

**新增 5 張（全部經人工目視驗證）**：金華、雅典、杜林、京都、橫濱。

**驗證後剔除**：河內（衛星空拍圖疊線）、巴庫（深色底地理圖）、洛陽（官方版本身就是
地形底圖）、南通（只有遠期規劃圖）、台州（營運商無官網）、滁州（南京官方圖不含寧滁線）。

**✅ provenance 缺口已補齊（2026-07-21）**：雅典/杜林/京都/橫濱這 4 張原本 `source_url` 為
`null`（agent 在回報前被砍）。已重新到官網逐一查回並**用「下載→同法重新轉檔→MD5 比對」
驗證確認就是同一份檔案**（非憑印象填寫）：

| 城市 | source_url | 驗證方式 |
|---|---|---|
| 京都 | `https://www.city.kyoto.lg.jp/kotsu/cmsfiles/contents/0000008/8995/nihongo_240529.pdf` | `qlmanage -s 2400` 渲染後 MD5 相同 |
| 雅典 | `https://stasy.gr/wp-content/uploads/2022/10/MAP_STASY_2022.pdf` | 同上（stasy.gr 有 Cloudflare，需經 Wayback `id_` 取檔） |
| 杜林 | `https://www.gtt.to.it/cms/risorse/urbana/img/metrotorino3.jpg` | `sips -s format png` 轉檔後 MD5 相同 |
| 橫濱 | `https://navi.hamabus.city.yokohama.lg.jp/blt-storage/pc/img/koutuu/railmap-pc.png` | 原生 PNG，MD5 直接相同 |

排除的錯誤候選（供日後省事）：雅典 `stasy.gr/wp-content/uploads/2021/12/Stasy_Map.pdf` 是
2021 舊版（3 號線尚未通到比雷埃夫斯、底圖較深）；杜林 `.../avvisi/img/grafo_metro_bengasi.jpg`
其實是 350×166 的手機翻拍照。橫濱官方 `/kotsu/sub/` 底下只有互動式路線圖，靜態 PNG 藏在
`navi.hamabus…` 這個路線查詢子站。

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
