# Metro data verification report

對照 **Wikipedia List of metro systems**（站數）＋ urbanrail.net 參考連結。

| 指標 | 值 |
|---|---|
| Wikipedia 系統數 | 233 |
| 本資料系統數 | 223 |
| 站數相符 (ok) | 206 |
| 標記待查 | 27（missing 2／no_line 0／order 0／zero 0／low 3／high 22） |
| 額外（不在 wiki 清單） | 10 |

## 不變式（invariants，違反＝資料一定有錯，必須驗證修正）

1. **wiki 有列的城市不可能沒資料**：違反數 **2**（severity `missing`）
2. **車站不可能沒有路線**：**0** 個系統、共 **0** 站的 `lines` 為空（severity `no_line`）
3. **線必有站、折點/端點必為車站**（幾何＝車站點依站序連線）：違反系統數 **0**（severity `vertex`）
4. **站序必須正確**：**0** 個系統有站序可疑的線（severity `order`）——一律以該線 **Wikipedia 條目**的車站列表與 **urbanrail.net** 的線路站序人工確認

## 待查系統（fetch⇄verify 迴圈的回饋清單）

| 嚴重度 | 城市 | 國家 | 本站數 | wiki站數 | 比值 | 說明 | 參考 |
|---|---|---|---|---|---|---|---|
| missing | Taoyuan | Taiwan | — | 22 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Taoyuan_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Taoyuan) |
| missing | New Taipei | Taiwan | — | 12 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/New_Taipei_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20Taipei) |
| low | Chennai | India | 20 | 42 | 0.48 | 站數偏少（20 vs wiki 42） | [wiki](https://en.wikipedia.org/wiki/Chennai_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chennai) |
| low | Lagos | Nigeria | 5 | 13 | 0.38 | 站數偏少（5 vs wiki 13） | [wiki](https://en.wikipedia.org/wiki/Lagos_Rail_Mass_Transit[Nb_72]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lagos) |
| low | Samara | Russia | 2 | 10 | 0.2 | 站數偏少（2 vs wiki 10） | [wiki](https://en.wikipedia.org/wiki/Samara_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Samara) |
| high | Berlin | Germany | 310 | 175 | 1.77 | 站數偏多（310 vs wiki 175），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Berlin_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Berlin) |
| high | Taipei | Taiwan | 197 | 119 | 1.66 | 站數偏多（197 vs wiki 119），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Taipei_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Taipei) |
| high | Tokyo | Japan | 212 | 99 | 2.14 | 站數偏多（212 vs wiki 99），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Toei_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Munich | Germany | 235 | 96 | 2.45 | 站數偏多（235 vs wiki 96），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Munich_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Munich) |
| high | Hamburg | Germany | 154 | 93 | 1.66 | 站數偏多（154 vs wiki 93），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Hamburg_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Hamburg) |
| high | Bangkok | Thailand | 104 | 64 | 1.63 | 站數偏多（104 vs wiki 64），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/BTS_Skytrain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bangkok) |
| high | Nuremberg | Germany | 135 | 49 | 2.76 | 站數偏多（135 vs wiki 49），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Nuremberg_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nuremberg) |
| high | London | United Kingdom | 267 | 45 | 5.93 | 站數偏多（267 vs wiki 45），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Docklands_Light_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20London) |
| high | Kaohsiung | Taiwan | 71 | 38 | 1.87 | 站數偏多（71 vs wiki 38），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kaohsiung_Rapid_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kaohsiung) |
| high | Montreal | Canada | 68 | 23 | 2.96 | 站數偏多（68 vs wiki 23），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Réseau_express_métropolitain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Montreal) |
| high | Sydney | Australia | 176 | 21 | 8.38 | 站數偏多（176 vs wiki 21），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Sydney_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sydney) |
| high | New York City | United States | 439 | 21 | 20.9 | 站數偏多（439 vs wiki 21），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Staten_Island_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | Tokyo | Japan | 212 | 16 | 13.25 | 站數偏多（212 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Yurikamome) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Seoul | South Korea | 426 | 16 | 26.63 | 站數偏多（426 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Shinbundang_Line[Nb_62]_(Neo_Trans)) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Seoul) |
| high | Yokohama | Japan | 45 | 14 | 3.21 | 站數偏多（45 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kanazawa_Seaside_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| high | Philadelphia | United States | 63 | 14 | 4.5 | 站數偏多（63 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATCO_Speedline) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Philadelphia) |
| high | Tokyo | Japan | 212 | 13 | 16.31 | 站數偏多（212 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Nippori-Toneri_Liner) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Manila | Philippines | 50 | 13 | 3.85 | 站數偏多（50 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Manila_Metro_Rail_Transit_System) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Manila) |
| high | New York City | United States | 439 | 13 | 33.77 | 站數偏多（439 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATH) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | Tokyo | Japan | 212 | 8 | 26.5 | 站數偏多（212 vs wiki 8），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Rinkai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Jakarta | Indonesia | 13 | 6 | 2.17 | 站數偏多（13 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Jakarta_LRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| high | Yokohama | Japan | 45 | 6 | 7.5 | 站數偏多（45 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Minatomirai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |

## 額外系統（本資料有、Wikipedia 清單無）

多為 OSM 標為 subway 但非 Wikipedia 定義的地鐵、或城市名變體/切分。

| 檔案 | 城市 | 國家 | 站 | 線 |
|---|---|---|---|---|
| systems/europe/germany/eu-ger-frankfurt.geojson | Frankfurt | Germany | 190 | 21 |
| systems/europe/germany/eu-ger-dusseldorf.geojson | Dusseldorf | Germany | 136 | 9 |
| systems/europe/spain/eu-esp-xirivella.geojson | Xirivella | Spain | 96 | 6 |
| systems/europe/germany/eu-ger-bielefeld.geojson | Bielefeld | Germany | 59 | 4 |
| systems/europe/germany/eu-ger-essen.geojson | Essen | Germany | 30 | 2 |
| systems/europe/germany/eu-ger-ratingen.geojson | Ratingen | Germany | 71 | 2 |
| systems/europe/germany/eu-ger-bochum.geojson | Bochum | Germany | 22 | 1 |
| systems/europe/spain/eu-esp-seville.geojson | Seville | Spain | 18 | 1 |
| systems/europe/austria/eu-aut-bezirk-landeck.geojson | Bezirk Landeck | Austria | 4 | 1 |
| systems/asia/china/as-chn-chuzhou.geojson | Chuzhou | China | 10 | 1 |
