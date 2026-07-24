# 論文改善建議

> 目標等級：IEEE TVCG／IEEE VIS full paper・2026 年 7 月
> 本文件依 2024–2026 文獻掃描結果撰寫，與 `paper.md`（論文本文）搭配閱讀；各節建議均標明對應的論文章節與具體改法。

---

## 0　等級分流：博士論文必要 vs TVCG 加分

本文件多數建議以 TVCG 為標尺；若目標先設定在**通過博士論文口試**，優先序如下。原則：口試委員抓的是「RQ 有沒有回答、論文有沒有完整」，不是「有沒有打贏 Bast & Brosi」。

### 博論必要（沒有就過不了口試）

| # | 項目 | 現況 | 差距 |
|---|---|---|---|
| 1 | **使用者實驗（RQ2）** | 只有設計與假設，無數據 | 三個 RQ 缺一個實證答案，口委必抓。二選一：執行 5.5 節實驗（30 人可縮到 20–24 人先做）；或正式改寫 RQ 結構把 RQ2 降為探索性——但計畫書已承諾，降級需在口試前與指導教授確認 |
| 2 | **圖表** | ✅ 已有 5 張（2026-07-25 自離線縮圖產出：管線四階段、旋轉變體、九鏈並列、RWD 前後、爬山改善率分佈，`slides/thesis/figs/`＋`scratchpad genfigs.py`） | 尚缺：版面響應序列（同城 4 種 artboard，需 rwd gallery 全量重算後產）、movewise 單步 before/after、LLM 迭代示意、Stage 4 權重／魚眼截圖——見產圖腳本待辦註記 |
| 3 | **章節厚度** | 約 1.4 萬字（濃縮完整版） | 中文博論典型 6–10 萬字。現稿當骨架逐章擴寫：第二章逐篇深入（現每篇僅一兩句）、第三章補虛擬碼與逐步圖例、第四章補架構圖與 schema 細節、第五章補完整指標表 |
| 4 | **文獻回顧厚度＋地理學定位** | 52 筆，CS 味重 | 博論文獻常需百筆上下；補回無 AI 版計畫書引過的（Hoffswell、Horak、Wu 2012 ViSizer、van Dijk 2013、Li 2018、Gruget 等——引用前逐筆驗證）＋2024–2026 NL2VIS 新文獻。地理系口委會問製圖學／空間認知定位：概括化理論、心智地圖、認知負荷的理論根基要加厚，不能只有演算法敘事 |

### 博論加分、TVCG 必要（口試沒有也能過）

- 與 LOOM／Bast 管線的定量對比（第 5 節第 2 項）
- LLM 消融＋跨模型重測（第 3 節）——口試被問到 3.7.2 時有數據更漂亮，沒有可答「投稿版補」
- 與最佳解差距（optimality gap）
- Benchmark 正式發布（DOI／datasheet）——博論寫「規劃中」即可

### 兩邊都受用、成本低（建議直接做）

- ✅ 2.6 畫界節——已寫入 paper.md（Brosi & Bast 2024 已驗證入引用清單；LLM 評測系與 responsive 系以描述方式帶過，正式引用待補書目）
- ✅ 失敗案例分析——已寫入 paper.md 5.4 節
- ✅ 資料管線重新定位（方案 A＋B）——貢獻 4 已改寫為 MetroBench-234、5.3 節資料品質收斂已寫入
- ✅ 術語定義——1.1 已加「示意圖」統一定義句（全文逐句換詞的完整清掃仍待擴寫時做）
- 審稿人／口委四發攻擊的預備答案（第 2 節）——口試前做成 Q&A 卡

---

## 1　相似論文與畫界策略

掃描結論：**沒有任何一篇同時做到「示意圖佈局 × 響應式版面 × 屬性概括化 × LLM-in-the-loop」的組合**，但每個維度都有強鄰居。Related work 不能只是列出他們，必須替每一篇寫好「畫界句」——審稿人第一輪一定會拿這些來挑戰。

| 相似論文 | 重疊維度 | 建議畫界句（寫進 2.6／related work） |
|---|---|---|
| Bast & Brosi，*Large-scale Generation of Transit Maps from OpenStreetMap Data*（Cartographic J. 2024）⚠️ 最強鄰居 | OSM → 全球規模自動示意圖 | 「該工作以求解器離線生成全球轉乘圖，輸出為固定版面的靜態地圖；本研究的目標相反——版面是輸入變數，每次顯示都在新像素座標重新求解，且以屬性重要性驅動概括化。」 |
| Ti, Li & Xu（2015） | 「adaptive to display sizes」命題的原提出者 | 「其方法離線單次生成、只縮放線段而不處理車站分佈，亦無互動；本研究把同一命題推進到互動即時、多位置縮放、拓撲守恆的層級。」 |
| *How well will LLMs perform for graph layout tasks?*（Visual Informatics 2025）、*Graph Drawing for LLMs*（arXiv 2025）、PlanarBench（arXiv 2026） | LLM × 圖佈局 | 「既有工作為評測型——問 LLM『能不能』排版；本研究提出生產型架構——讓 LLM 在確定性 harness 內『安全地』參與排版，並系統化其工程方法。」 |
| Proteus（arXiv 2026）、*Automated Responsive Thematic Mapping*（arXiv 2026） | responsive visualization 自動化 | 「對象為統計圖表與主題地圖；網絡示意圖因拓撲約束與線路連續性，其響應式重排是質上不同的問題。」 |
| MetroGNN、RL transit network design（2024–2025） | 學習方法 × 捷運網絡 | 「該系列處理網絡設計（線路規劃），本研究處理既有網絡的佈局繪製，兩者輸入輸出均不同。」 |

**行動**：在 `paper.md` 2.6 節（研究空缺總結）前新增一小節「2.6 近期相關工作與本研究之區隔」，收錄上表五句畫界；第一章動機末段補一句「LLM × 圖佈局的評測研究正快速出現，但生產性架構仍缺席」以強化時效性。

---

## 2　原創性評估

**整體判定：中高。** 「示意圖佈局 × 響應式版面 × 屬性概括化 × LLM-in-the-loop」的組合無人做過，但組合式原創需要每個組件都站得住——逐維度評估如下：

| 維度 | 原創性 | 依據 | 風險 |
|---|---|---|---|
| movewise 三步鏈（可稽核壓縮 local search） | **高** | 「每種移動守單調不變式＋每步後全域壓縮＋每個單一移動可重播」——未找到相近工作；可稽核性當一級設計目標是 VIS 社群會買單的角度 | 需補與最佳解差距的量化，否則「為何不用求解器」難擋 |
| LLM-in-the-loop 確定性把關架構 | **高（時效性最強）** | LLM × graph layout 目前只有評測型論文（能不能排版），沒有生產型架構（怎麼安全參與排版）；五層工程論述是首個系統化 | 窗口約 1–2 年，晚了會被搶；需消融實驗撐論述 |
| 八篇經典同約束並列重實作＋234 城全量 | **中高** | 統一輸入、統一硬規則下的全量比較無前例，比較研究本身可發表 | Bast & Brosi 2024 已佔「planet-scale from OSM」名分，畫界句必須到位 |
| 響應式屬性示意圖（版面即輸入、像素座標重解） | **中高** | Ti 2015 之後此命題幾乎無人推進；responsive vis 自動化 2026 熱題但無人做網絡示意圖 | 「有助理解」的主張必須有使用者實驗數據 |
| 資料管線 | **中（不宜獨立當貢獻）** | 見第 4 節重新定位方案 | 直接當貢獻會被打 "engineering effort" |

**審稿人最可能的四發攻擊與預備答案**：（1）「與 Bast/Brosi 差在哪」→ 版面是輸入變數＋屬性概括化＋可稽核，佐以定量對比；（2）「LLM 部份是不是 gimmick」→ 消融實驗顯示 harness／context 各自貢獻；（3）「adaptive 有沒有用」→ 使用者實驗 H1–H3；（4）「**模型一直在進步，這篇會不會很快過時**」→ 這是 LLM 應用論文的標準殺招，本論文有構造性答案（paper.md 3.7.2 節）：貢獻是分工介面的設計而非模型能力快照——正確性下界由純演算法保證、harness 使模型參與只能單調向上、五層工程與模型解耦；每一代新模型是同一 harness 下的免費重測，跨代曲線本身就是實證數據。前三者在第 5 節必補清單內，第四者需配跨模型重測實驗（見第 3 節）。

---

## 3　三個核心主張的強化

| 主張 | 現況 | 強化建議 |
|---|---|---|
| movewise 三步鏈 | 有收斂論證與全量數據 | 把「可稽核性（auditability）作為演算法設計的一級目標」明確立為主張；補「與最佳解差距」的定量實驗（小網格窮舉最佳解 vs 三步鏈結果）讓 local search 的犧牲可量化 |
| LLM-in-the-loop | 有架構與五層工程論述＋模型無關性論證（3.7.2） | 補**消融實驗**（有無 harness、有無精煉脈絡、小步多輪 vs 大步單批的合法率／淨改善量對比）＋**跨模型重測實驗**：同一 harness 換多個模型與版本（如 Fable／Opus／Sonnet／Haiku），實測「下界不變、上界隨模型單調提升」——把「模型會進步」從審稿風險翻轉成論文的實驗優勢，也是模型無關性主張的直接證據 |
| 八篇經典並列比較 | 有 234 城結果 | 定義統一指標組（彎折數、H/V 比、面積、平均邊長變異、執行時間），產出逐城指標表與統計檢定；「依城市特性擇鏈」從觀察升級為可檢驗的分類結論 |

---

## 4　資料管線的重新定位（回答「不好當貢獻要怎麼改」）

**問題診斷**：「我們建了一條資料管線」是工程敘述，不是研究主張——它沒有研究問題、沒有可否證的結果，而且 Bast & Brosi（2024）已佔「planet-scale transit maps from OSM」的名分。直接當貢獻，審稿人一句 *"engineering effort, not a research contribution"* 就能打掉。但管線本身價值很高，問題只在**包裝的類型錯了**。四個重新定位方案，可並用：

### 方案 A（主推）：改包裝成公開 Benchmark

把「管線」改成「**第一個全球尺度示意圖佈局基準資料集**」：234 城統一 schema、附驗證報告與逐城指標、附八條鏈的基準結果。Benchmark 是視覺化社群認可的貢獻類型——貢獻主張從「我們建了管線」改成「**我們使公平比較成為可能**」：

> 修改前（第七章貢獻 4）：「開放可重現的資料管線：全球路網資料的 fetch ⇄ audit 閉環……」
> 修改後：「**MetroBench-234（暫名）：全球尺度示意圖佈局基準**——234 個城市系統的統一 schema 資料集、資料品質不變式與驗證報告、八種經典演算法的基準結果與統一指標，使示意圖佈局演算法首次能在同一輸入與同一約束下全量比較。」

配套動作：資料集掛 DOI（Zenodo／OSF）、寫 datasheet、在第五章加「基準使用範例」小節。這同時解決第 3 節「並列比較」主張的落地問題——比較實驗就是 benchmark 的示範應用。

### 方案 B：提煉成可量化的方法論結果

如果要保留「管線」的敘述，就必須讓它有**結果**而不只有流程。fetch ⇄ audit 閉環其實是「資料品質收斂程序」，可以量化：

- audit 迭代輪數與 error 數下降曲線（逐城）；
- 對 Wikipedia 基準的覆蓋率（如 233/234）與逐線站數準確率；
- 人工裁決（override）的數量、類型分佈、重放成功率——「人工判斷可重放」是可檢驗的性質。

把這些畫成圖表放第五章，管線就從工程敘述變成「資料品質收斂的實證研究」。

### 方案 C：重新定位為「圖工程層」（graph engineering for LLM）

呼應 3.7.1 節：LLM 能參與佈局的前提是圖已被工程化（拓撲收縮、座標整數化、不變式明文化）。把資料管線納入這個論述——**管線不是獨立貢獻，而是 LLM-in-the-loop 架構的必要組件**（graph engineering 層的實作）。這樣它依附在主張 3 之下，不需要獨立辯護。

### 方案 D：降級為可重現性聲明

最保守：正文 4.2 節壓縮成半頁，細節全部移到 supplementary material 與開源 repo，貢獻列表刪去第 4 條、改為三個貢獻。版面讓給演算法與評估。TVCG 頁數緊時這是務實選擇。

**建議組合**：博士論文用 A＋B（benchmark 當貢獻 4、量化結果進第五章）；TVCG 主論文用 C＋D（管線半頁帶過、benchmark 另投 dataset/short paper track）。

---

## 5　TVCG 必補清單（依優先序）

1. **使用者實驗執行**（最高優先）：5.3 節目前只有設計。TVCG 對「adaptive/responsive 有助理解」的主張幾乎必然要求實證；30 人 × 3 地圖 × 3 裝置的設計已足，需 IRB、預註冊假設、效果量與檢定。
2. **與 LOOM／Bast 管線的定量對比**：同一城市集合上比較輸出品質（彎折、H/V、面積、拓撲錯誤）與時間。沒有這個對比，「為什麼不用現成求解器」會是每一輪審查的必問題。
3. **LLM 消融**（見第 3 節）：harness／context／loop 策略各自的貢獻度。
4. **與最佳解的差距**：小規模網格上窮舉或 ILP 求最佳，量化三步鏈的 optimality gap。
5. **失敗案例分析**：殘留 forced 衝突的城市、LLM 反覆退回的案例——誠實的失敗分析在 VIS 社群是加分項。

---

## 6　建議論文題目（IEEE VIS／TVCG 等級）

### 主論文（系統＋演算法，投 TVCG 或 VIS full paper）

**主推：**

> **Re-solving on Every Screen: Auditable Movewise Compaction for Responsive Attribute-Aware Metro Maps**
> （每次版面都重新求解：可稽核的 movewise 壓縮與響應式屬性地鐵圖）

備選同軌：
- *Adapt-Metro: Deterministic and Stepwise-Auditable Layout of Responsive Schematic Transit Maps at Global Scale*
- *From Geography to Any Display: A Compaction-First Pipeline for Responsive Schematic Network Maps*

### LLM 論文（時效最高，建議先投）

> **Proposals from the Model, Legality from the Rules: LLM-in-the-Loop Layout for Schematic Maps**

備選：
- *Prompt, Context, Harness, Loop, Graph: Engineering LLMs into a Deterministic Metro Map Pipeline*

### 比較研究／Benchmark（投 CGF／EuroVis／PacificVis 也適合）

> **Eight Classics on One Grid: A Unified Re-implementation and 234-City Comparison of Octilinear Metro Map Algorithms**

命名原則（供自行調整時參考）：主標語式短句放記憶點（re-solving／auditable／proposals from the model）、副標放可檢索關鍵字（responsive、schematic/metro map、LLM-in-the-loop、compaction）；避免「A Study of / Towards」開頭的弱框架；博士論文題目《自適應版面的地理空間網絡資料視覺化》維持不變，三篇即三個貢獻章的發表版。

---

## 7　投稿拆篇策略

| 篇 | 內容 | 目標 | 時機 |
|---|---|---|---|
| 主論文 | movewise 三步鏈＋響應式管線＋使用者實驗 | TVCG／IEEE VIS | 使用者實驗完成後 |
| LLM 論文 | 提案-把關架構＋五層工程＋消融 | VIS／EuroVis（或 CHI，若偏互動） | **最優先**——LLM×layout 目前只有評測論文，窗口約 1–2 年 |
| Benchmark | MetroBench-234 資料集＋八鏈基準結果 | VIS short／dataset track、PacificVis | 可與 LLM 論文並行 |

拆篇後博士論文結構不變——三篇即三個貢獻章的發表版。

---

## 8　寫作面改善

- **摘要**：目前偏長（敘述四項貢獻），TVCG 版壓到 200 字內、只留一個核心主張＋最強數字（234 城、零交叉、42.9%）。
- **圖**：正文目前無圖。至少需要：管線總覽圖、movewise 三步示意（before/after）、同一城市九條鏈並列圖、版面響應序列圖（同城市在 4 種版面）、LLM 迭代示意。系統截圖品質已足，需加註記。
- **限制誠實度**：6.4 節已誠實列出六項——保持；審稿人對「承認限制＋說明為何不影響主張」的寫法評價最高。
- **一致性**：正文「路網圖／網絡圖／示意圖」混用，建議統一為「示意圖（schematic map）」並在 1.1 首次出現時定義。
- **模型無關性主張的三條措辭紅線**（3.7.2 節相關，越界就會被審稿人抓）：
  1. **單調性只對「接受準則所定義的目標函數」成立**——「LLM 參與後不劣於未參與」是就淨 H/V 等明定指標而言；不可寫成「品質必然變好」（品質是多維的，美學整體不在保證範圍）。必要時在 3.7.2 加一句限定。
  2. **模型無關的是「架構與正確性語意」，不是「實驗數據」**——合法率、收斂輪數當然隨模型而變；主張限縮在介面與保證，不可滑坡成「結果與模型無關」。
  3. **沒有跨模型重測數據前，這是論述不是證據**——投稿版必須附第 3 節的跨模型實驗，否則整節會被視為 hand-waving。
  另可考慮引 neuro-symbolic「propose-and-verify」先例（如 AlphaGeometry, Trinh et al., Nature 2024：LLM 提案＋符號引擎驗證）佐證此架構模式已被頂級期刊接受——引用前依慣例先驗證書目。

---

## 9　本文件與論文的同步

採納任一建議修改 `paper.md` 後，請同步：（1）投影片（`slides/thesis/index.html`）對應頁；（2）本文件勾銷已完成項。建議在 `paper.md` 頂部版本註記加一行修訂紀錄。

---

## 10　建議新增引用清單

依用途分類；「✅」＝書目已逐筆驗證（並已寫入 `paper.md` 正文與參考文獻），「⬜」＝推薦引用但**書目未驗證**——寫入前務必先查證卷期頁碼與作者，嚴禁直接照抄本表。

### A　已驗證、已入文稿（2026-07-25 本輪）

| 文獻 | 用在 | 為什麼要引 |
|---|---|---|
| ✅ Hoffswell, Li, & Liu (2020), *Techniques for flexible responsive visualization design*, CHI '20（Best Paper） | 2.3.1 | 響應式視覺化「編輯工具」代表作——多版面同時編輯；證明響應式設計成本高到需要工具，反襯本研究「重新求解」路線 |
| ✅ Horak, Berger, Schumann, Dachselt, & Tominski (2021), *Responsive matrix cells*, TVCG 27(2), 1644–1654 | 2.3.1 | 「局部區域依可用空間與任務改變表徵」——與本研究魚眼／權重欄列同族的 focus+context 思想 |
| ✅ Wu, Liu, Liu, & Ma (2013), *ViSizer*, TVCG 19(2), 278–290 | 2.3.1 | 「resize 即最佳化問題」的先聲（知覺模型驅動的變形能量函數）——本研究「版面一變即重解」立場的直接前驅 |
| ✅ van Dijk & Haunert (2014), *Interactive focus maps using least-squares optimization*, IJGIS 28, 2052–2075 | 2.3.2 | 即時互動的焦點放大、不裁脈絡不改地圖大小——與魚眼同目標但作用於原始道路網 |
| ✅ van Dijk, van Goethem, Haunert, Meulemans, & Speckmann (2013), *Accentuating focus maps via partial schematization*, ACM SIGSPATIAL | 2.3.2 | 「局部示意化」突顯焦點——示意化程度本身當變形手段 |
| ✅ Roberts, Newton, Lagattolla, Hughes, & Hasler (2013), *Objective versus subjective measures of Paris Metro map usability*, IJHCS 71(3), 363–386 | 5.5 | 示意圖可用性研究的方法標竿：客觀績效與主觀偏好會解離——正是本研究問卷「績效＋評價」雙軌設計的理據 |
| ✅ Trinh, Wu, Le, He, & Luong (2024), *Solving olympiad geometry without human demonstrations*, Nature 625, 476–482 | 6.3 | AlphaGeometry＝「模型提案＋符號驗證」的頂級先例，佐證本研究架構模式已被最高等級期刊接受 |
| ✅ Brosi & Bast (2024), Cartographic J. 60(4), 342–366（前輪已入） | 2.6 | 最強鄰居，畫界必引 |

### B　推薦引用、書目待驗證（⬜ 查證後再入）

| 文獻（憑印象記錄，須查證） | 用在 | 為什麼要引 |
|---|---|---|
| ⬜ Gruget, Touya, et al.（約 2023）pan-scalar maps 概念論文 | 2.3.3 | 跨尺度地圖的概念框架（Touya et al. 2023 已引，補概念源頭） |
| ⬜ Dibia (2023), *LIDA*, ACL demo | 2.5 | LLM 生成視覺化的代表性工具（grammar-agnostic、多階段管線） |
| ⬜ Luo et al., *nvBench*（NL2VIS 基準） | 2.5 | NL2VIS 標準基準，評估脈絡必引 |
| ⬜ Wang et al., *Data Formulator*（Microsoft，TVCG 2024？） | 2.5 | AI 輔助圖表製作的近期代表 |
| ⬜ *How well will LLMs perform for graph layout tasks?*, Visual Informatics (2025)——**作者未查** | 2.6 | 目前 2.6 只描述未正式引用；投稿版必須補正式書目 |
| ⬜ *Graph Drawing for LLMs: An Empirical Evaluation*, arXiv:2505.03678——作者未查 | 2.6 | 同上 |
| ⬜ PlanarBench, arXiv:2606.02010；Proteus, arXiv:2604.23299；Responsive Thematic Mapping, arXiv:2606.12008 | 2.6 | 同上（arXiv 引用也需作者名） |
| ⬜ Nöllenburg (2014)，metro map layout 方法綜述（書章） | 2.2 | 佈局方法的系統性綜述，文獻回顧加厚用 |
| ⬜ McMaster & Shea (1992), *Generalization in Digital Cartography* | 2.4 | 概括化理論經典，補地理學理論根基 |
| ⬜ Töpfer & Pillewizer (1966), radical law | 2.4 | 概括化選取量的古典定律——版面縮小時該留多少物件的理論參照 |
| ⬜ MacEachren (1995), *How Maps Work* | 2.1／2.4 | 地圖認知與表徵理論的地理學根基（口委視角） |
| ⬜ Sweller（1988 起）認知負荷理論 | 5.5 | 使用者實驗的認知理論依據 |
| ⬜ Ware, *Information Visualization: Perception for Design* | 5.5 | 視覺感知設計原則，測驗題設計依據 |

---

## 附錄　文獻掃描來源（2026-07-25）

- Bast & Brosi (2024). *Large-scale generation of transit maps from OpenStreetMap data.* The Cartographic Journal. https://www.tandfonline.com/doi/full/10.1080/00087041.2024.2325761
- Ti, Li & Xu (2015). *Automated generation of schematic network maps adaptive to display sizes.* The Cartographic Journal. https://www.tandfonline.com/doi/full/10.1080/00087041.2015.1119464
- *How well will LLMs perform for graph layout tasks?* Visual Informatics (2025). https://www.sciencedirect.com/science/article/pii/S2468502X25000683
- *Graph Drawing for LLMs: An Empirical Evaluation.* arXiv:2505.03678. https://arxiv.org/pdf/2505.03678
- *PlanarBench: Evaluating LLM Spatial Reasoning via Planar Graph Drawing.* arXiv:2606.02010. https://arxiv.org/pdf/2606.02010
- *Proteus: Shapeshifting Desktop Visualizations for Mobile via Multi-level Intelligent Adaptation.* arXiv:2604.23299. https://arxiv.org/pdf/2604.23299
- *Automated Responsive Thematic Mapping with Layout Guides.* arXiv:2606.12008. https://arxiv.org/html/2606.12008
- *MetroGNN: Metro Network Expansion with Reinforcement Learning.* arXiv:2403.09197. https://arxiv.org/pdf/2403.09197
- *Exploring MLLMs Perception of Network Visualization Principles.* arXiv:2506.14611. https://arxiv.org/pdf/2506.14611
