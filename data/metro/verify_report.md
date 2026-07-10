# Metro data verification report

對照 **Wikipedia List of metro systems**（站數）＋ urbanrail.net 參考連結。

| 指標 | 值 |
|---|---|
| Wikipedia 系統數 | 233 |
| 本資料系統數 | 225 |
| 站數相符 (ok) | 211 |
| 標記待查 | 23（missing 1／no_line 0／order 1／zero 0／low 2／high 19） |
| 額外（不在 wiki 清單） | 11 |

## 不變式（invariants，違反＝資料一定有錯，必須驗證修正）

1. **wiki 有列的城市不可能沒資料**：違反數 **1**（severity `missing`）
2. **車站不可能沒有路線**：**0** 個系統、共 **0** 站的 `lines` 為空（severity `no_line`）
3. **線必有站、折點/端點必為車站**（幾何＝車站點依站序連線）：違反系統數 **0**（severity `vertex`）
4. **站序必須正確**：**1** 個系統有站序可疑的線（severity `order`）——一律以該線 **Wikipedia 條目**的車站列表與 **urbanrail.net** 的線路站序人工確認

## 待查系統（fetch⇄verify 迴圈的回饋清單）

| 嚴重度 | 城市 | 國家 | 本站數 | wiki站數 | 比值 | 說明 | 參考 |
|---|---|---|---|---|---|---|---|
| missing | Taoyuan | Taiwan | — | 22 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Taoyuan_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Taoyuan) |
| order | Rome | Italy | 115 | — | — | 1 條線站序可疑（路徑長 > 1.6× MST）：Metro D 1.77×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Rome) |
| low | Lagos | Nigeria | 5 | 13 | 0.38 | 站數偏少（5 vs wiki 13） | [wiki](https://en.wikipedia.org/wiki/Lagos_Rail_Mass_Transit[Nb_72]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lagos) |
| low | Samara | Russia | 3 | 10 | 0.3 | 站數偏少（3 vs wiki 10） | [wiki](https://en.wikipedia.org/wiki/Samara_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Samara) |
| high | Tokyo | Japan | 230 | 142 | 1.62 | 站數偏多（230 vs wiki 142），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Tokyo_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Tokyo | Japan | 230 | 99 | 2.32 | 站數偏多（230 vs wiki 99），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Toei_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Bangkok | Thailand | 112 | 64 | 1.75 | 站數偏多（112 vs wiki 64），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/BTS_Skytrain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bangkok) |
| high | San Francisco (Bay Area) | United States | 163 | 47 | 3.47 | 站數偏多（163 vs wiki 47），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/BART[Nb_102]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20San%20Francisco%20(Bay%20Area)) |
| high | London | United Kingdom | 291 | 45 | 6.47 | 站數偏多（291 vs wiki 45），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Docklands_Light_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20London) |
| high | Kaohsiung | Taiwan | 75 | 38 | 1.97 | 站數偏多（75 vs wiki 38），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kaohsiung_Rapid_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kaohsiung) |
| high | Montreal | Canada | 69 | 23 | 3 | 站數偏多（69 vs wiki 23），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Réseau_express_métropolitain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Montreal) |
| high | New York City | United States | 448 | 21 | 21.33 | 站數偏多（448 vs wiki 21），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Staten_Island_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | Tokyo | Japan | 230 | 16 | 14.38 | 站數偏多（230 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Yurikamome) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Seoul | South Korea | 470 | 16 | 29.38 | 站數偏多（470 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Shinbundang_Line[Nb_62]_(Neo_Trans)) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Seoul) |
| high | Yokohama | Japan | 40 | 14 | 2.86 | 站數偏多（40 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kanazawa_Seaside_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| high | Philadelphia | United States | 71 | 14 | 5.07 | 站數偏多（71 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATCO_Speedline) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Philadelphia) |
| high | Tokyo | Japan | 230 | 13 | 17.69 | 站數偏多（230 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Nippori-Toneri_Liner) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Manila | Philippines | 53 | 13 | 4.08 | 站數偏多（53 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Manila_Metro_Rail_Transit_System) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Manila) |
| high | New York City | United States | 448 | 13 | 34.46 | 站數偏多（448 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATH) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | New Taipei | Taiwan | 27 | 12 | 2.25 | 站數偏多（27 vs wiki 12），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/New_Taipei_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20Taipei) |
| high | Tokyo | Japan | 230 | 8 | 28.75 | 站數偏多（230 vs wiki 8），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Rinkai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Jakarta | Indonesia | 14 | 6 | 2.33 | 站數偏多（14 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Jakarta_LRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| high | Yokohama | Japan | 40 | 6 | 6.67 | 站數偏多（40 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Minatomirai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |

## 額外系統（本資料有、Wikipedia 清單無）

多為 OSM 標為 subway 但非 Wikipedia 定義的地鐵、或城市名變體/切分。

| 檔案 | 城市 | 國家 | 站 | 線 |
|---|---|---|---|---|
| systems/europe/germany/europe-germany-dusseldorf.geojson | Dusseldorf | Germany | 105 | 9 |
| systems/europe/spain/europe-spain-xirivella.geojson | Xirivella | Spain | 98 | 6 |
| systems/europe/germany/europe-germany-bielefeld.geojson | Bielefeld | Germany | 60 | 4 |
| systems/europe/germany/europe-germany-ratingen.geojson | Ratingen | Germany | 72 | 2 |
| systems/europe/germany/europe-germany-essen.geojson | Essen | Germany | 18 | 2 |
| systems/europe/germany/europe-germany-bochum.geojson | Bochum | Germany | 23 | 1 |
| systems/unknown/unknown/unknown.geojson | — | — | 3 | 1 |
| systems/europe/spain/europe-spain-seville.geojson | Seville | Spain | 20 | 1 |
| systems/europe/austria/europe-austria-bezirk-landeck.geojson | Bezirk Landeck | Austria | 4 | 1 |
| systems/asia/china/asia-china-chuzhou.geojson | Chuzhou | China | 10 | 1 |
| systems/asia/turkey/asia-turkey-derince.geojson | Derince | Turkey | 11 | 1 |
