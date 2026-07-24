---
name: metro-audit
description: 驗證 data/metro 資料的正確性與完整性——逐城市 audit⇄修補迴圈＋對照 Wikipedia/urbanrail.net 的全量驗證報告。當使用者要求驗證、檢查正確性、比對 Wikipedia/urbanrail、跑 metro:audit / metro:verify、收斂覆蓋率、或問某城市資料對不對/為何未通過時使用。修補動作一律走 [[metro-osm-fetch]] 的規則，兩者互為 fetch⇄audit 迴圈。
---

# 地鐵資料驗證與收斂 (metro-audit)

此 skill 是 `data/metro/` **正確性**的唯一權威依據，涵蓋兩個互補的工具
（[[metro-osm-fetch]] 負責「取得」；本 skill 負責「驗證與收斂」）。**城市／地區專屬的
驗證例外與逐城裁決索引**（各城 `_overrides/` 裁決、未通車例外、機場排除等）見
[[metro-cities]]——先查該城有無專屬規則，通用判準仍以本檔為準：

```bash
npm run metro:audit      # 逐城市 audit⇄修補到收斂（scripts/auditLoop.mjs，自動）
npm run metro:wikilines  # 逐線 wiki 站數對照（scripts/wikiLineCheck.mjs，建議 audit 前先跑）
npm run metro:verify     # 全量驗證報告（scripts/verifyMetro.mjs，人看的總表）
```

> **驗證層級（誠實聲明）**：系統級（站數比值 0.6–1.6）與**線級**（wiki 線路條目 infobox
> 站數）為自動；**站名級**（逐站核對 wiki 站單）不自動——只對被 flag 的線執行，
> 由人工或 agent 依該線 wiki 條目＋urbanrail 核對，裁決落地為 `_overrides/` 或上游修正。

> **終態要求（使用者規則）：全部城市一定要通過資料驗證。** 未通過的城市先自動重抓
> （`metro:refetchfailed`，見策略階梯），仍未通過的逐項人工/agent 裁決落地，兩個出口：
> - **無名站** → 開 wiki 查得站名寫入 `_overrides/station_names.json`（build 套用）；
>   wiki 也查不到的：`pruneDeletedStations` 驗上游是否已刪，真無名者人工判定剔除。
> - **線站數 ≠ wiki** → 開該線 wiki 條目逐站核對：我們錯 → 修資料（刷新/補正/墓碑）；
>   wiki infobox 過期或計法不同 → 寫入 `_overrides/wiki_adjudications.json`
>   （綁 city+wiki+ours，資料再變動即失效重 flag；note 必填依據）。
> 不允許為了通過而編造資料——裁決必須有 wiki/官方來源依據。

`metro:verify` 需先跑完 `metro:build`（直接讀 `index.json`）；`metro:audit` 在缺 `index` 時
會自行 rebuild 起步、不必手動先 build。檢查判準一致，但門檻常數（`0.6`／`1.6`／order `1.6×`）
在 `verifyMetro.mjs`／`auditLoop.mjs`／`buildGeojson.mjs` 三檔**各自定義（非共用 import）**，
改一處必須同步其餘兩處。**執行期零 LLM/零 token**，皆可中斷續跑。

## fetch ⇄ audit 迴圈（核心概念）

```
metro-osm-fetch ──取得──▶ data/metro
      ▲                      │
      │ 策略階梯補抓/綁定      ▼ 逐城市
      └──── metro-audit ◀──驗證(Wikipedia/urbanrail)
```

## 架構：一次抓全球底料，再逐城市 audit

全球底料由 [[metro-osm-fetch]] **一次批抓**（單一全球查詢對 Overpass 負擔最小；
底料本身不產生任何判定）。所有「對不對」的結論、以及**逐城市的定向補抓**，
都發生在下面的逐城迴圈——需要才抓、抓完立刻驗。

## 逐城市迴圈（`metro:audit`，每城獨立走完，不是全部抓完才總體檢）

```
for 每個城市（Wikipedia 基準城市優先，其餘 OSM 系統殿後）:
    audit(城市)                      # 立即驗證
    while 未通過 且 還有沒試過的策略:
        套用下一招（補抓/綁定，寫入 _cache 與 _overrides）
        rebuild → 重新 audit(城市)   # 每招之後立刻重驗
    記錄最終判定 → _cache/audit_state.json
最後 rebuild 一次，把所有判定嵌入 metro_system.audit
```

- **有通過也要記**：`passed: true` ＋ 通過的檢查明細；**沒通過更要記**：每條失敗原因。
  前端 Info 面板照實顯示（綠=通過、紅=未過+原因、琥珀=警告）。
- 已通過的城市重跑會跳過（`audit_state.json` 即進度）。

## 不變式與檢查項（違反 error ＝ 資料一定有錯，必須修到 0）

驗證一律以 **Wikipedia**（List of metro systems：清單＋站數）與 **urbanrail.net**
（逐城市線路與站序的第二來源）為對照。報告附的 urbanrail「連結」實為
Google `site:urbanrail.net <城市>` 搜尋 URL（urbanrail 無乾淨 API），供人工點開確認。

| 檢查 | 等級 | 規則（不變式） |
|---|---|---|
| `system_exists` | error | **wiki 清單城市不可能沒資料**（verify severity `missing`） |
| `has_lines` / `has_stations` | error | ≥1 線、≥1 站（**audit 專屬**：`has_lines` 只在 `auditLoop` 檢查；`verify` 的 `zero` 只看 `station_count === 0`（且限 wiki 清單城市），不查線數） |
| `line_wiki_stations` | **error** | **逐線站數以 wiki 為準（使用者規則：不算比值、以「當地語言」wiki 為主），但「只畫有通車的」不變式優先**——wiki 線路條目 infobox 常寫**全線規劃站數**（含未通車段：環狀線寫 42、我們只畫已通車 14），故為**三段式判定**（`npm run metro:wikilines`，來源優先序：OSM `wikipedia` 標籤→`wikidata` sitelinks 當地語條目→en；快取 `_cache/wiki_line_stations_v2.json`（存 `{total, operational}`）、報告 `line_check_report.json` 各 flag 帶 `severity`/`wiki_basis`）：① infobox 解析得到「營運中/已啟用/in operation」數字 → 必須完全相等（error）；② 只有全線總數且 `ours > wikiN` → error（多站無法用未通車解釋——誤併/多抓）；③ 只有全線總數且 `ours < wikiN` → 見下列 `line_wiki_planned` |
| `line_wiki_planned` | warn | 只有全線總數且 `ours < total`——**可能是 wiki 計入未通車段**，不算失敗但**必須人工開該線 wiki 條目確認**：若差額確為未通車段→通過（可寫入裁決）；若實為漏站→查上游 tagging／補站源 |
| `line_wiki_coverage` | warn | 無法對照 wiki 的線（缺 `wikipedia`/`wikidata` 標籤或條目無 infobox 站數）——列出供補齊上游標籤 |
| `station_count_info` | warn(資訊) | 系統級站數**不做比值判定**（wiki List 計法含轉乘重複、與共站合併天然不同）——僅顯示參考數字；站數的硬判定在 `line_wiki_stations` |
| `stations_named` | **error** | **全部車站必須有名稱（100%）**——合成名（`n123`）＝資料錯誤，需補上游名稱或剔除 |
| `stations_have_lines` | error | **不可能有車站沒有路線**——每站 `lines` ≥1（verify `no_line`） |
| `line_geometry_stations` | error | **不可能有路線沒有車站；折點/端點必為車站**——路段幾何＝車站點依站序連線，每段 ≥2 站、每個頂點都等於某車站座標（verify `vertex`） |
| `station_order` | warn | **站序必須正確**——build 在路段化前逐 route 以「路徑長 ≤1.6× 站點 MST」檢查（僅對 ≥4 站的序列、且 MST ≥ ~1 km 的網路判定，過短者略過），可疑者記在該 route meta 的 `order_suspect`；audit/verify 讀取此欄位（verify `order`）。被標者必須逐線以該線 Wikipedia 條目＋urbanrail.net 站序人工確認（快線/環線變體會誤報） |
| `route_stations_match_geometry` | error | **route 的車站列表必須與圖面一致**——每條 route 的 `stations` 列表（站 id 集合）必須等於「所有含該 route 的路段之頂點站」集合。列表跟圖不同是不可能狀態，出現即 build 有 bug |
| `interchange_rule` | error | **interchange ⇔ degree>2 或 端點站停靠 ≥2 線 或 端點站被 pass 路線穿過（degree≥2）**——與 `buildGeojson.mjs` 的 `isIx` 同式（該處為權威、[[metro-osm-fetch]] station_role 節為規則全文；改一處必同步）。分歧/交會（濱海沙崙／七張 degree=3）、terminus-interchange（Zaragoza）、**終點站被穿過**（東涌：TCL 終點＋AEL pass 續走，degree=2 但非端點，2026-07-16 裁決）皆紅；共軌重疊段中間站（degree=2、非端點）不算。前端站點紅色用此 `is_interchange` 欄位 |

> **共站（可轉乘）待查流程**：合併判準見 [[metro-osm-fetch]]（stop_area 權威＋同名近距輔助）。
> 模糊案例——鄰近異名疑似轉乘、同名遠距疑似同站、站數比值異常暗示併錯/漏併——
> 以該線 **Wikipedia 條目**與 **urbanrail.net** 查證（仍不確定再查其他網路來源），
> 裁決寫入 `data/metro/_overrides/interchanges.json`（`{"merge": [["n123","n456"], …]}`），
> 重跑 `metro:build` 即生效。
>
> **車站分類（`station_role`：`interchange`／`terminus`／`normal`）**由 build 依「服務線數 ≥2」
> 與「是否為某線端點（環線除外）」自最終幾何推導，定義即 wiki/urbanrail 慣例（交會優先於端點）。
> 其正確性繫於**共站合併是否正確**（漏併→交會被拆成兩個 normal）與**線/站/站序是否正確**——
> 故毋須額外檢查，修好上述不變式即隨之正確；若人工比對 wiki/urbanrail 發現分類不符，
> 病因在共站合併或路線資料，循該處流程修正。

**error 全過才算通過**；warn 不擋通過但一定列出。

## 策略階梯（每輪換招；全部是預先寫死的程式邏輯）

**缺系統（`system_exists` 失敗）**——依序：
1. **S1 綁定既有快取**：掃 `_cache` 內 relation 重心落在該城 30 km 內者——已屬別的 wiki
   正名城市 → 記 `covered_by`（同都會區，視為通過並註記）；散落非正名桶 → 寫 `_overrides` 綁進本城。
2. **S2 定向補抓（40 km）**：`relation[route~"^(subway|light_rail)$"](around)`，名稱/network 與
   wiki 系統名 token 相符者才收；tags＋幾何＋車站存 `gap_*` 快取＋`_overrides` 綁定。
3. **S3 定向補抓（80 km）**：同 S2 放寬半徑。
4. **S4 單軌例外（僅 wiki 基準城市）**：該城的 metro 在 OSM 標為 `route=monorail`（如蕪湖）時，
   以 monorail 對**該城**定向補抓。這是唯一允許的判準放寬，全域判準不變。
5. 用盡 → `passed: false`＋原因。

**站數不足（`has_stations`／`line_wiki_stations` 低於 wiki）**——依序：
- **Z0 併入鄰城**（僅非基準、0 站碎片）：線路重心 25 km 內同國 wiki 城市 → 併入。
- **Z1 定向補站**：以系統範圍＋8 km（`min(60, ceil(maxKm+8))`，上限 60 km）補抓車站
  （只收 subway/light_rail 口味；monorail 口味僅 S2/S4 的補抓查詢有，Z1 沒有）。
- **Z2 由 stop 衍生**：route 成員節點補抓 tags，**有名稱**的 stop_position 衍生為車站。
- **Z3 定向刷新**：wiki 說已通車/延伸段我們沒有、但該線 relation 早已在快取——
  幾何快取只認 id 集合，**上游成員更新不會自己變新**（例：新加坡環狀線閉合段）。
  `node scripts/refreshRelations.mjs <slug> <rid...>` 重抓該批 relation → `gap_*_refresh_*`
  快取（build 端後載者勝）→ 重 build。詳見 [[metro-osm-fetch]]。

**未通過城市自動重抓（使用者規則：資料驗證未通過的城市應該要重抓、重 audit）**：
audit 全城跑完後，對每個 `passed: false` 的城市跑
`npm run metro:refetchfailed`（`scripts/refetchFailedCities.mjs`，token-free）——
1. **relation 全量刷新**：該城系統檔內所有 `osm_route_ids` 上游重抓（tags＋成員＋
   具名節點）→ `gap_*_refresh_{city}` 快取（治舊成員/舊 tags）；
2. **墓碑驗證**：該城所有站點 id 上游批次查存在，**已刪節點**寫入
   `_cache/deleted_nodes.json`，build 站源拒收（治「站源殭屍被頂點吸附撿走」——
   香港觀塘綫 17→20 站案例；單城手動版：`scripts/pruneDeletedStations.mjs`）。
之後重跑 `metro:build && metro:wikilines && metro:audit`。每城刷新記錄在
`_cache/refetch_state.json`——重複執行只處理「上次刷新後仍 failed」的城市，不會無限
重抓；刷新後仍未通過的即為真正的上游資料缺陷（無名站、wiki 不符），落地人工裁決。

`stations_have_lines` 違規由 build 端規則保證（≤900 m 最近 stop 補配；仍配不上的站
視為非營運剔除）；`line_geometry_stations` 同樣由 build 保證（幾何＝車站點依站序連線）
——audit 只驗不修。

規則約束：所有補抓查詢**只允許 `subway|light_rail`**（S4 例外允許 monorail，僅限基準
城市；德國 S-Bahn 例外允許 train，僅限 [[metro-osm-fetch]] 所列五個德國 metro 城市），
永不放寬到 plain railway/tram（[[metro-osm-fetch]] 的判準是上位規則）。
LRT 範圍、城市合併（桃園→台北）、**同一城市＝同一系統**（token 黑名單＋250 km 距離
護欄，防跨城誤配如 Frankfurt→Berlin）、**快/慢車合併**、**城市網路白名單**（東京不含
私鐵）等 build 端規則見 [[metro-osm-fetch]]——被合併的 wiki 基準城市（如桃園）由 S1 以
`covered_by` 判定通過並註記；audit 發現疑似抓錯城市（站數比值異常、order 大量可疑）時，
先檢查該城檔內各 route 的 `network`/`operator` 是否屬於該城系統，再依上述規則修 build 端。

## 全量報告（`metro:verify`）

產出 `data/metro/verify_report.json`（結構化）＋ `.md`（人看的，依嚴重度排序，附
wiki／urbanrail 連結）。severity：`missing`／`no_line`／`vertex`／`broken`（路線連續不變式：
每條 route 的路段聯集必須單一連通、hover 不得斷開，union-find 檢查）／`order`／`zero`／`low`
／`high` ＋ `extras`（本資料有、wiki 無——多為 OSM 有標但非 wiki 定義的系統或城市名變體）。

**判讀注意**：wiki 數字可能過期（flag 是「請看一下」不是「一定錯」）；一城一檔天生 `high`；
不變式違規（`missing`/`no_line`/確認屬實的 `order`）**沒有可接受一說**，必須修到 0；
可裁量的只有 `low`/`high`/`extras`。

## 產出與狀態

| 檔案 | 內容 |
|---|---|
| `_cache/audit_state.json` | 每城市 `passed`/`checks[]`/`reasons[]`/`warnings[]`/`strategies_tried[]`/`covered_by?`/`audited_at` |
| `_cache/gap_routes_*`／`gap_geom_*`／`gap_stations_*` | 補抓原始資料（與主快取同格式，build 自動合併） |
| `data/metro/_overrides/*.json` | 城市綁定覆寫（機器與人工同格式，見 [[metro-osm-fetch]]） |
| `metro_system.audit`（build 嵌入） | 前端 Info 面板顯示的最終判定 |
| `verify_report.json`／`.md` | 全量總表 |

## 收斂性質與人工裁決

- 策略有限且每招只試一次 → 必然終止；未過城市留下「試過什麼、為何失敗」的完整紀錄，
  即人工裁決的工作清單（也是論文 data quality 素材）。
- 人工裁決後：補 `_overrides/*.json`（或修 OSM 上游）→ 刪該城在 `audit_state.json` 的
  紀錄 → 重跑 `metro:audit`，只會重驗該城。

## 修改此驗證時

檢查項/門檻/策略/嚴重度變動，**同步更新本 SKILL.md、[[metro-osm-fetch]]（判準與
overrides 格式）與 `data/metro/README.md`**，確保取得、驗證與實作三者一致。
