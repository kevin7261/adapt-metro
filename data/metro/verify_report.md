# Metro data verification report

對照 **Wikipedia List of metro systems**（站數）＋ urbanrail.net 參考連結。

| 指標 | 值 |
|---|---|
| Wikipedia 系統數 | 233 |
| 本資料系統數 | 265 |
| 站數相符 (ok) | 202 |
| 標記待查 | 32（missing 2／no_line 0／order 1／zero 0／low 2／high 27） |
| 額外（不在 wiki 清單） | 52 |

## 不變式（invariants，違反＝資料一定有錯，必須驗證修正）

1. **wiki 有列的城市不可能沒資料**：違反數 **2**（severity `missing`）
2. **車站不可能沒有路線**：**0** 個系統、共 **0** 站的 `lines` 為空（severity `no_line`）
3. **線必有站、折點/端點必為車站**（幾何＝車站點依站序連線）：違反系統數 **0**（severity `vertex`）
4. **站序必須正確**：**1** 個系統有站序可疑的線（severity `order`）——一律以該線 **Wikipedia 條目**的車站列表與 **urbanrail.net** 的線路站序人工確認

## 待查系統（fetch⇄verify 迴圈的回饋清單）

| 嚴重度 | 城市 | 國家 | 本站數 | wiki站數 | 比值 | 說明 | 參考 |
|---|---|---|---|---|---|---|---|
| missing | Taoyuan | Taiwan | — | 22 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Taoyuan_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Taoyuan) |
| missing | New Taipei | Taiwan | — | 12 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/New_Taipei_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20Taipei) |
| order | Wellington | New Zealand | 31 | — | — | 1 條線站序可疑（路徑長 > 1.6× MST）：Kapiti line 1.62×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Wellington) |
| low | Lagos | Nigeria | 5 | 13 | 0.38 | 站數偏少（5 vs wiki 13） | [wiki](https://en.wikipedia.org/wiki/Lagos_Rail_Mass_Transit[Nb_72]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lagos) |
| low | Samara | Russia | 2 | 10 | 0.2 | 站數偏少（2 vs wiki 10） | [wiki](https://en.wikipedia.org/wiki/Samara_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Samara) |
| high | Berlin | Germany | 309 | 175 | 1.77 | 站數偏多（309 vs wiki 175），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Berlin_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Berlin) |
| high | Taipei | Taiwan | 197 | 119 | 1.66 | 站數偏多（197 vs wiki 119），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Taipei_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Taipei) |
| high | Tokyo | Japan | 202 | 99 | 2.04 | 站數偏多（202 vs wiki 99），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Toei_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Munich | Germany | 235 | 96 | 2.45 | 站數偏多（235 vs wiki 96），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Munich_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Munich) |
| high | Hamburg | Germany | 154 | 93 | 1.66 | 站數偏多（154 vs wiki 93），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Hamburg_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Hamburg) |
| high | Bangkok | Thailand | 104 | 64 | 1.63 | 站數偏多（104 vs wiki 64），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/BTS_Skytrain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bangkok) |
| high | Boston | United States | 120 | 52 | 2.31 | 站數偏多（120 vs wiki 52），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/MBTA_subway[Nb_92]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Boston) |
| high | Nuremberg | Germany | 135 | 49 | 2.76 | 站數偏多（135 vs wiki 49），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Nuremberg_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nuremberg) |
| high | London | United Kingdom | 262 | 45 | 5.82 | 站數偏多（262 vs wiki 45），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Docklands_Light_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20London) |
| high | Kaohsiung | Taiwan | 71 | 38 | 1.87 | 站數偏多（71 vs wiki 38），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kaohsiung_Rapid_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kaohsiung) |
| high | Guadalajara | Mexico | 54 | 28 | 1.93 | 站數偏多（54 vs wiki 28），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/SITEUR[Nb_65]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Guadalajara) |
| high | Montreal | Canada | 68 | 23 | 2.96 | 站數偏多（68 vs wiki 23），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Réseau_express_métropolitain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Montreal) |
| high | Hiroshima | Japan | 98 | 22 | 4.45 | 站數偏多（98 vs wiki 22），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Astram_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Hiroshima) |
| high | Sydney | Australia | 176 | 21 | 8.38 | 站數偏多（176 vs wiki 21），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Sydney_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sydney) |
| high | New York City | United States | 444 | 21 | 21.14 | 站數偏多（444 vs wiki 21），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Staten_Island_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | Algiers | Algeria | 56 | 19 | 2.95 | 站數偏多（56 vs wiki 19），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Algiers_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Algiers) |
| high | Los Angeles | United States | 110 | 19 | 5.79 | 站數偏多（110 vs wiki 19），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Metro_Rail[Nb_96]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Los%20Angeles) |
| high | Tokyo | Japan | 202 | 16 | 12.63 | 站數偏多（202 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Yurikamome) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Seoul | South Korea | 426 | 16 | 26.63 | 站數偏多（426 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Shinbundang_Line[Nb_62]_(Neo_Trans)) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Seoul) |
| high | Yokohama | Japan | 45 | 14 | 3.21 | 站數偏多（45 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kanazawa_Seaside_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| high | Philadelphia | United States | 63 | 14 | 4.5 | 站數偏多（63 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATCO_Speedline) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Philadelphia) |
| high | Tokyo | Japan | 202 | 13 | 15.54 | 站數偏多（202 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Nippori-Toneri_Liner) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Manila | Philippines | 50 | 13 | 3.85 | 站數偏多（50 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Manila_Metro_Rail_Transit_System) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Manila) |
| high | New York City | United States | 444 | 13 | 34.15 | 站數偏多（444 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATH) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | Tokyo | Japan | 202 | 8 | 25.25 | 站數偏多（202 vs wiki 8），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Rinkai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Jakarta | Indonesia | 13 | 6 | 2.17 | 站數偏多（13 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Jakarta_LRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| high | Yokohama | Japan | 45 | 6 | 7.5 | 站數偏多（45 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Minatomirai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |

## 額外系統（本資料有、Wikipedia 清單無）

多為 OSM 標為 subway 但非 Wikipedia 定義的地鐵、或城市名變體/切分。

| 檔案 | 城市 | 國家 | 站 | 線 |
|---|---|---|---|---|
| metro-maps/oceania/australia/oc-aus-melbourne.geojson | Melbourne | Australia | 1081 | 58 |
| metro-maps/europe/germany/eu-ger-frankfurt.geojson | Frankfurt | Germany | 190 | 21 |
| metro-maps/africa/south-africa/af-rsa-johannesburg.geojson | Johannesburg | South Africa | 209 | 30 |
| metro-maps/europe/germany/eu-ger-dusseldorf.geojson | Dusseldorf | Germany | 136 | 9 |
| metro-maps/africa/south-africa/af-rsa-cape-town.geojson | Cape Town | South Africa | 109 | 16 |
| metro-maps/oceania/australia/oc-aus-brisbane.geojson | Brisbane | Australia | 134 | 14 |
| metro-maps/oceania/australia/oc-aus-adelaide.geojson | Adelaide | Australia | 123 | 10 |
| metro-maps/africa/south-africa/af-rsa-durban.geojson | Durban | South Africa | 82 | 9 |
| metro-maps/europe/spain/eu-esp-xirivella.geojson | Xirivella | Spain | 96 | 6 |
| metro-maps/oceania/australia/oc-aus-perth.geojson | Perth | Australia | 86 | 8 |
| metro-maps/europe/germany/eu-ger-bielefeld.geojson | Bielefeld | Germany | 59 | 4 |
| metro-maps/africa/tunisia/af-tun-tunis.geojson | Tunis | Tunisia | 77 | 6 |
| metro-maps/oceania/new-zealand/oc-nzl-auckland.geojson | Auckland | New Zealand | 39 | 4 |
| metro-maps/oceania/new-zealand/oc-nzl-wellington.geojson | Wellington | New Zealand | 31 | 4 |
| metro-maps/africa/ethiopia/af-eth-addis-ababa.geojson | Addis Ababa | Ethiopia | 39 | 2 |
| metro-maps/americas/bolivia/am-bol-cochabamba.geojson | Cochabamba | Bolivia | 32 | 3 |
| metro-maps/africa/egypt/af-egy-alexandria.geojson | Alexandria | Egypt | 38 | 5 |
| metro-maps/africa/morocco/af-mar-rabat.geojson | Rabat | Morocco | 43 | 2 |
| metro-maps/europe/germany/eu-ger-essen.geojson | Essen | Germany | 30 | 2 |
| metro-maps/africa/morocco/af-mar-casablanca.geojson | Casablanca | Morocco | 106 | 4 |
| metro-maps/africa/algeria/af-alg-sidi-bel-abbes.geojson | Sidi Bel Abbès | Algeria | 23 | 2 |
| metro-maps/europe/germany/eu-ger-ratingen.geojson | Ratingen | Germany | 71 | 2 |
| metro-maps/africa/nigeria/af-ngr-abuja.geojson | Abuja | Nigeria | 12 | 2 |
| metro-maps/africa/mauritius/af-mri-port-louis.geojson | Port Louis | Mauritius | 21 | 2 |
| metro-maps/africa/algeria/af-alg-mostaganem.geojson | Mostaganem | Algeria | 23 | 2 |
| metro-maps/europe/germany/eu-ger-bochum.geojson | Bochum | Germany | 22 | 1 |
| metro-maps/europe/spain/eu-esp-seville.geojson | Seville | Spain | 18 | 1 |
| metro-maps/europe/austria/eu-aut-bezirk-landeck.geojson | Bezirk Landeck | Austria | 4 | 1 |
| metro-maps/oceania/australia/oc-aus-gold-coast.geojson | Gold Coast | Australia | 19 | 1 |
| metro-maps/oceania/australia/oc-aus-newcastle.geojson | Newcastle | Australia | 6 | 1 |
| metro-maps/oceania/australia/oc-aus-canberra.geojson | Canberra | Australia | 14 | 1 |
| metro-maps/asia/china/as-chn-chuzhou.geojson | Chuzhou | China | 10 | 1 |
| metro-maps/africa/algeria/af-alg-constantine.geojson | Constantine | Algeria | 15 | 1 |
| metro-maps/africa/senegal/af-sen-dakar.geojson | Dakar | Senegal | 13 | 1 |
| metro-maps/africa/algeria/af-alg-oran.geojson | Oran | Algeria | 32 | 1 |
| metro-maps/africa/algeria/af-alg-ouargla.geojson | Ouargla | Algeria | 16 | 1 |
| metro-maps/africa/algeria/af-alg-setif.geojson | Sétif | Algeria | 22 | 1 |
| metro-maps/asia/japan/as-jpn-tokyo-jr.geojson | Tokyo + Yamanote | Japan | 214 | 15 |
| metro-maps/asia/japan/as-jpn-osaka-jr.geojson | Osaka + Loop | Japan | 132 | 11 |
| metro-maps/americas/united-states/am-usa-new-york-city-lm.geojson | New York City + Landmark | United States | 444 | 11 |
| metro-maps/asia/china/as-chn-shanghai-lm.geojson | Shanghai + Landmark | China | 407 | 21 |
| metro-maps/asia/japan/as-jpn-tokyo-lm.geojson | Tokyo + Landmark | Japan | 202 | 14 |
| metro-maps/asia/south-korea/as-kor-seoul-lm.geojson | Seoul + Landmark | South Korea | 426 | 23 |
| metro-maps/asia/taiwan/as-twn-taipei-lm.geojson | Taipei + Landmark | Taiwan | 197 | 17 |
| metro-maps/europe/austria/eu-aut-vienna-lm.geojson | Vienna + Landmark | Austria | 99 | 5 |
| metro-maps/europe/france/eu-fra-paris-lm.geojson | Paris + Landmark | France | 321 | 20 |
| metro-maps/europe/germany/eu-ger-berlin-lm.geojson | Berlin + Landmark | Germany | 309 | 27 |
| metro-maps/europe/united-kingdom/eu-gbr-london-lm.geojson | London + Landmark | United Kingdom | 262 | 26 |
| metro-maps/asia/singapore/as-sgp-singapore-lrt.geojson | Singapore + LRT | Singapore | 187 | 14 |
| metro-maps/asia/south-korea/as-kor-seoul-incheon.geojson | Seoul + Incheon | South Korea | 487 | 26 |
| metro-maps/asia/taiwan/as-twn-taipei-rail.geojson | Taipei + TRA + HSR | Taiwan | 206 | 19 |
| metro-maps/asia/japan/as-jpn-tokyo-rail.geojson | Tokyo + JR + Private | Japan | 583 | 60 |
