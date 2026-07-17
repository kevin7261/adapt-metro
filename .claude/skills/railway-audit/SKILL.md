---
name: railway-audit
description: 驗證 data/railway 資料的正確性與完整性——逐系統結構 audit（車站有線、線壓車站、無假長線、degree 分佈、相鄰同名未併）＋逐線對照當地語 Wikipedia infobox 站數（跨社聚合後比全線）。當使用者要求驗證國家鐵路資料、檢查正確性、比對 wiki 站數、跑 railway:verify / railway:wikilines、或問某國/某社/某條鐵路線資料對不對時使用。與 [[railway-osm-fetch]] 互為 fetch⇄audit 迴圈（同 [[metro-audit]] 對 [[metro-osm-fetch]]、[[highway-audit]] 對 [[highway-osm-fetch]] 的關係）。
---

# 國家鐵路資料驗證規則 (railway-audit)

此 skill 是 `data/railway/` 資料**正確性驗證**的權威依據，是 [[metro-audit]]／[[highway-audit]]
的**國家鐵路對應版**（第三條並列 audit 管線）。與 [[railway-osm-fetch]]（取得）互為
**fetch⇄audit 迴圈**：本 skill 驗證發現的缺漏/異常回饋到 fetch，據以調整查詢、定向重抓
relations、或落 `_overrides`，再驗證，直到收斂。**改判準/欄位時兩份 skill 一起更新。**

```
railway-osm-fetch ──取得──▶ data/railway
      ▲                       │
      │ 重抓 relations/覆寫     ▼ 逐系統 + 逐線
      └──── railway-audit ◀──驗證(結構不變式 + Wikipedia infobox)
```

實作兩支腳本，**執行期零 LLM／零 token**、皆可中斷續跑：
```bash
npm run railway:wikilines   # scripts/wikiRailwayLines.mjs：逐線抓當地語 wiki infobox 站數
npm run railway:verify      # scripts/verifyRailways.mjs：結構不變式 + 疊加 wiki 站數層
node scripts/verifyRailways.mjs jpn   # 只驗檔名含子字串的系統
```
`railway:all`（fetch→build→**wikilines→verify**）末段自動跑完驗證。建議先 `wikilines` 再
`verify`（verify 讀 wikilines 產出的 `line_check_report.json` 疊 wiki 層；沒跑 wikilines 就只做結構檢查）。

## 驗證層級（誠實聲明，同 metro）

| 層級 | 自動？ | 依據 |
|---|---|---|
| 結構不變式 | ✅ 全自動 | geojson 自身幾何/拓撲（見下表） |
| **線級站數** | ✅ 自動抓、⚠ 需人工判讀 | 當地語 wiki 線路條目 infobox 站數（跨社聚合比全線） |
| 站名級（逐站核對 wiki 站單） | ❌ 不自動 | 只對被 flag 的線，由人工/agent 依該線 wiki 條目核對 |

> **終態要求（使用者規則）：所有鐵路車站要用 wiki 驗證。** `railway:wikilines` 把每條線
> 對照當地語 wiki 條目 infobox 的站數（嚴格相等，不算比值）。未通過的兩個出口（同 metro）：
> - **我們 > wiki（error）** → 開該線 wiki 條目逐站核對：我們錯（誤併/多抓/上游髒資料）→ 修資料
>   或走 [[railway-osm-fetch]] 的 `_overrides` 排除；wiki infobox 過期/計法不同 → 寫
>   `_overrides/wiki_adjudications.json`（綁 `country+line+ours`，任一變動即失效重 flag，note 必填依據）。
> - **我們 < wiki（warn）** → 多為 OSM `route=railway` 關聯停站不全（覆蓋率上限，見 [[railway-osm-fetch]]
>   §3/§3b）：定向重抓該線 relations（`railway:fetch {cc} --force`）補齊；OSM 本身就缺則落
>   adjudication 記錄。**不允許為了通過而編造資料。**

## 結構驗證項目（`verifyRailways.mjs`；error 擋、warn 提示）

逐系統跑、結果寫進該 geojson 的 `railway_system.audit`（`passed`/`checks`/`audited_at`；
一併鏡射到 `metro_system.audit` 供前端 Info 面板讀），並印逐系統報告。

| id | level | 檢查（對應 [[railway-osm-fetch]] 不變式） |
|---|---|---|
| `has_lines` / `has_stations` | error | 有路線、有車站 |
| `stations_have_lines` | error | **每車站 ≥1 條所屬線**（不變式①：不可能有車站沒有線） |
| `lines_have_stations` | error | **每條線 ≥2 站**（不變式②：不可能有路段沒有車站） |
| `vertices_on_stations` | error | **每個折點都是車站點**（線壓車站；斷口不算折點） |
| `no_fake_long_segment` | error | **無超過 per-class cap 的線段**——一般 30km／高鐵 70km（＝build 的 `capFor`）。畫直線只連軌道上真正相鄰的兩站，超過＝排序退化跳到並行線／缺口硬接 |
| `degree_distribution` | warn | degree 分佈以 2 為主（不變式④）；出現 10+ 度＝逐線排序退化成 mesh |
| `no_adjacent_dup_names` | error | 一條線序列裡相鄰兩站同名未併（>150m 沒合成一點） |
| `line_wiki_stations_over` | error | **該系統有線的站數 > wiki**（誤併/多抓）——來自 `line_check_report.json` |
| `line_wiki_stations_under` | warn | 該系統有線的站數 < wiki（OSM 關聯不全？）——同上，warn 級 |

## 逐線 wiki 站數（`wikiRailwayLines.mjs`）

- **對照單位＝線名**：railway 的 route **沒有 wikipedia 標籤**（build 給 null），但**線名本身就是
  當地語 wiki 條目標題**（高崎線→`ja:高崎線`、山陰本線→`ja:山陰本線`、京广高速线→`zh:京广高速线`）。
  故直接用 `{lang}:{route_name}` 當條目；`lang` 由國家對照（日 ja／台中 zh／韓 ko／法 fr…）。
- **跨社聚合比全線**：日本一般國鐵一線拆多社（東海道本線 分在 JR東/海/西 三檔），但 wiki 條目涵蓋
  **全線**。故先**跨同一國家所有系統檔、依線名把車站去重聚合**，再比 wiki（否則每社只有片段、必假性短少）。
- **嚴格相等**（使用者規則，不算比值）。護欄：`wikiN > max(120, ours×3)` ⇒ 疑似系統/幹線總表條目，
  列 uncovered 不比對。類別標籤線（`一般鐵路`/`高速鐵路`＝無名 connector 群）跳過。
- 快取 `_cache/wiki_line_stations.json`（wiki API 批次 50/請求、必帶 UA、可續跑）；報告
  `data/railway/line_check_report.json`（`flags`／`uncovered_lines`／`adjudicated_lines`，flag 帶
  `files`＝該線落在哪些系統檔，供 verify 分派到系統）。

## 與 metro-audit 的差異／對應

- **對照單位不同**：metro 用 route 的 `wikipedia`/`wikidata` 標籤找條目；railway 的 route 無此標籤，
  改用**線名直接當條目標題**（JR/國鐵線名即 wiki 標題，比 metro 乾淨），且**跨社聚合**後比全線。
- **無「逐系統策略階梯自動補抓迴圈」**（metro `auditLoop.mjs`）：railway 目前是 `wikilines`＋`verify`
  兩支，補抓靠人工判讀 flag 後定向 `railway:fetch {cc} --force`。要全自動收斂再擴 auditLoop 對應版。
- **warn 為主是常態**：多數 flag 是「我們 < wiki」＝OSM `route=railway` 關聯停站不全（[[railway-osm-fetch]]
  的已知覆蓋上限），非誤抓。真正要優先修的是 **error 級（我們 > wiki）** 與結構 error。
- **degree 只 warn**：鐵路真交會站（八堵/竹南/米原…）degree 3–6 合法，只有 10+ 才旗標。

## 已知待收斂（首次全量 wiki 驗證的發現，v1）

- **中國高鐵假長線＋多抓**：`as-chn-hsr` 有 22 段 >70km（各高鐵線 OSM 常不互連，fallback NN 串接
  硬接遠站）＋成贵/武九/衡柳等 +7~+11 站——CN 只抓 highspeed、跨線靠各關聯獨立成線，長段與多抓
  是此策略的固有副作用（見 [[railway-osm-fetch]] CN 覆寫）。
- **日本一般國鐵大量 warn（我們 < wiki）**：山陰本線 58/161、日豊本線 41/113、奥羽本線 41/103…＝OSM
  該線 `route=railway` 關聯停站遠不全，非拆社造成（拆社前同底料同覆蓋）。定向重抓 relations 可部分補齊。
- **日本拆 JR 六社的邊界退化**（本次拆分引入，見 [[railway-osm-fetch]] 日本節）：琵琶湖線 7/23（京都端
  被分到 JR東海、線名破碎）、少數邊界站分社偏差、雁ヶ沢/吾妻峡八ッ場 兩站於分社分群時掉出——屬分社
  演算法在公司交界的假影，需以本 audit 為準繩迭代修正 `splitJapanByCompany` 的邊界判準。
- **error 級 +1~+2 多為量測邊界**：wiki infobox 有時不計貨物支線端點/信號場、或線界站計法差一站；逐線開
  wiki 核對後，我們對就落 `wiki_adjudications.json`、wiki 對就修資料。

## 授權與標註

- 幾何/屬性：© OpenStreetMap contributors，ODbL。
- 驗證基準：各線當地語 Wikipedia 條目 infobox（站數），CC BY-SA。

## 修改此管線時

任何判準/欄位/門檻變動**都要同步更新此 SKILL.md 與 [[railway-osm-fetch]]**；與 metro/highway
對映的部分若一起改，也要更新 [[metro-audit]]／[[highway-audit]]，維持「概念一一對應」。
