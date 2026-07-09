# Metro data verification report

對照 **Wikipedia List of metro systems**（站數）＋ urbanrail.net 參考連結。

| 指標 | 值 |
|---|---|
| Wikipedia 系統數 | 233 |
| 本資料系統數 | 242 |
| 站數相符 (ok) | 164 |
| 標記待查 | 181（missing 37／no_line 112／zero 0／low 5／high 27） |
| 額外（不在 wiki 清單） | 63 |

## 不變式（invariants，違反＝資料一定有錯）

1. **wiki 有列的城市不可能沒資料**：違反數 **37**（severity `missing`）
2. **車站不可能沒有路線**：**112** 個系統、共 **1119** 站的 `lines` 為空（severity `no_line`）

## 待查系統（fetch⇄verify 迴圈的回饋清單）

| 嚴重度 | 城市 | 國家 | 本站數 | wiki站數 | 比值 | 說明 | 參考 |
|---|---|---|---|---|---|---|---|
| missing | Ningbo | China | — | 156 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Ningbo_Rail_Transit[127]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Ningbo) |
| missing | Jinan | China | — | 103 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Jinan_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jinan) |
| missing | Stockholm | Sweden | — | 100 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Stockholm_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Stockholm) |
| missing | Guiyang | China | — | 82 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Guiyang_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Guiyang) |
| missing | Harbin | China | — | 78 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Harbin_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Harbin) |
| missing | Xiamen | China | — | 70 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Xiamen_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Xiamen) |
| missing | Incheon | South Korea | — | 68 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Incheon_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Incheon) |
| missing | Lille | France | — | 60 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Lille_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lille) |
| missing | Vancouver | Canada | — | 54 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/SkyTrain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Vancouver) |
| missing | Nuremberg | Germany | — | 49 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Nuremberg_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nuremberg) |
| missing | Sapporo | Japan | — | 46 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Sapporo_Municipal_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sapporo) |
| missing | Copenhagen | Denmark | — | 44 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Copenhagen_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Copenhagen) |
| missing | Nantong | China | — | 43 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Nantong_Rail_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nantong) |
| missing | Mashhad | Iran | — | 40 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Mashhad_Urban_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Mashhad) |
| missing | Wuhu | China | — | 36 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Wuhu_Rail_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Wuhu) |
| missing | Fukuoka | Japan | — | 36 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Fukuoka_City_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Fukuoka) |
| missing | Sendai | Japan | — | 29 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Sendai_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sendai) |
| missing | Brasília | Brazil | — | 27 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Federal_District_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bras%C3%ADlia) |
| missing | Lanzhou | China | — | 27 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Lanzhou_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lanzhou) |
| missing | Ürümqi | China | — | 23 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Ürümqi_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20%C3%9Cr%C3%BCmqi) |
| missing | Porto Alegre | Brazil | — | 22 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Porto_Alegre_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Porto%20Alegre) |
| missing | Taoyuan | Taiwan | — | 22 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Taoyuan_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Taoyuan) |
| missing | Belo Horizonte | Brazil | — | 20 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Belo_Horizonte_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Belo%20Horizonte) |
| missing | Isfahan | Iran | — | 20 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Isfahan_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Isfahan) |
| missing | Los Angeles | United States | — | 19 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Metro_Rail[Nb_96]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Los%20Angeles) |
| missing | Tabriz | Iran | — | 18 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Tabriz_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tabriz) |
| missing | Astana | Kazakhstan | — | 18 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Astana_Light_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Astana) |
| missing | San Juan | United States | — | 16 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Tren_Urbano) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20San%20Juan) |
| missing | Macau | China | — | 15 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Macau_Light_Rapid_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Macau) |
| missing | Nizhny Novgorod | Russia | — | 15 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Nizhny_Novgorod_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nizhny%20Novgorod) |
| missing | Palembang | Indonesia | — | 13 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Palembang_LRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Palembang) |
| missing | Saitama Prefecture | Japan | — | 13 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/New_Shuttle) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Saitama%20Prefecture) |
| missing | Gimpo | South Korea | — | 10 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Gimpo_Goldline) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Gimpo) |
| missing | Chiba Prefecture | Japan | — | 9 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Tōyō_Rapid_Railway_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chiba%20Prefecture) |
| missing | Mecca | Saudi Arabia | — | 9 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Mecca_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Mecca) |
| missing | Saitama Prefecture | Japan | — | 8 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Saitama_Rapid_Railway_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Saitama%20Prefecture) |
| missing | Maracaibo | Venezuela | — | 6 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Maracaibo_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Maracaibo) |
| no_line | Beijing | China | 482 | — | — | 10/482 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Beijing) |
| no_line | Tokyo | Japan | 316 | — | — | 8/316 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| no_line | Shanghai | China | 587 | — | — | 45/587 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Shanghai) |
| no_line | Guangzhou | China | 362 | — | — | 5/362 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Guangzhou) |
| no_line | Chengdu | China | 548 | — | — | 12/548 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chengdu) |
| no_line | Shenzhen | China | 403 | — | — | 1/403 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Shenzhen) |
| no_line | Moscow | Russia | 276 | — | — | 3/276 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Moscow) |
| no_line | Nanjing | China | 305 | — | — | 3/305 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nanjing) |
| no_line | Dusseldorf | Germany | 219 | — | — | 11/219 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Dusseldorf) |
| no_line | Tianjin | China | 330 | — | — | 45/330 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tianjin) |
| no_line | Hangzhou | China | 382 | — | — | 72/382 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Hangzhou) |
| no_line | Zhengzhou | China | 248 | — | — | 2/248 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Zhengzhou) |
| no_line | Mexico City | Mexico | 212 | — | — | 4/212 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Mexico%20City) |
| no_line | Seoul | South Korea | 526 | — | — | 9/526 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Seoul) |
| no_line | London | United Kingdom | 280 | — | — | 5/280 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20London) |
| no_line | Chongqing | China | 319 | — | — | 3/319 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chongqing) |
| no_line | Istanbul | Turkey | 243 | — | — | 5/243 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Istanbul) |
| no_line | Frankfurt | Germany | 87 | — | — | 1/87 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Frankfurt) |
| no_line | Osaka | Japan | 128 | — | — | 1/128 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Osaka) |
| no_line | Berlin | Germany | 180 | — | — | 5/180 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Berlin) |
| no_line | Suzhou | China | 280 | — | — | 7/280 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Suzhou) |
| no_line | Munich | Germany | 101 | — | — | 1/101 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Munich) |
| no_line | Yinzhou District | China | 188 | — | — | 7/188 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yinzhou%20District) |
| no_line | Qingdao | China | 265 | — | — | 79/265 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Qingdao) |
| no_line | Hefei | China | 218 | — | — | 20/218 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Hefei) |
| no_line | Stockholm Municipality | Sweden | 101 | — | — | 1/101 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Stockholm%20Municipality) |
| no_line | Washington, D.C. | United States | 109 | — | — | 5/109 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Washington%2C%20D.C.) |
| no_line | Saint Petersburg | Russia | 75 | — | — | 2/75 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Saint%20Petersburg) |
| no_line | Tehran | Iran | 143 | — | — | 2/143 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tehran) |
| no_line | Singapore | Singapore | 235 | — | — | 25/235 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Singapore) |
| no_line | Dalian | China | 153 | — | — | 12/153 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Dalian) |
| no_line | Mumbai | India | 83 | — | — | 3/83 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Mumbai) |
| no_line | Kunming | China | 195 | — | — | 2/195 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kunming) |
| no_line | Shenyang | China | 141 | — | — | 1/141 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Shenyang) |
| no_line | Fuzhou | China | 128 | — | — | 10/128 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Fuzhou) |
| no_line | Licheng District | China | 110 | — | — | 2/110 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Licheng%20District) |
| no_line | Vienna | Austria | 121 | — | — | 7/121 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Vienna) |
| no_line | São Paulo | Brazil | 97 | — | — | 9/97 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20S%C3%A3o%20Paulo) |
| no_line | Oslo | Norway | 91 | — | — | 6/91 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Oslo) |
| no_line | Bangkok | Thailand | 159 | — | — | 45/159 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bangkok) |
| no_line | Rotterdam | Netherlands | 81 | — | — | 1/81 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Rotterdam) |
| no_line | Wuxi | China | 93 | — | — | 1/93 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Wuxi) |
| no_line | Nanning | China | 118 | — | — | 17/118 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nanning) |
| no_line | Kolkata | India | 62 | — | — | 2/62 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kolkata) |
| no_line | Brussels | Belgium | 72 | — | — | 6/72 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Brussels) |
| no_line | Montreal | Canada | 88 | — | — | 8/88 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Montreal) |
| no_line | Rome | Italy | 139 | — | — | 35/139 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Rome) |
| no_line | null | null | 117 | — | — | 70/117 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Nanchang | China | 143 | — | — | 10/143 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nanchang) |
| no_line | Xuzhou | China | 149 | — | — | 63/149 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Xuzhou) |
| no_line | Prague | Czechia | 61 | — | — | 2/61 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Prague) |
| no_line | Toronto | Canada | 85 | — | — | 12/85 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Toronto) |
| no_line | Burnaby | Canada | 56 | — | — | 1/56 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Burnaby) |
| no_line | Naples | Italy | 36 | — | — | 3/36 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Naples) |
| no_line | Boston | United States | 46 | — | — | 5/46 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Boston) |
| no_line | Busan | South Korea | 103 | — | — | 4/103 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Busan) |
| no_line | null | null | 78 | — | — | 3/78 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Chennai | India | 86 | — | — | 11/86 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chennai) |
| no_line | Changchun | China | 104 | — | — | 32/104 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Changchun) |
| no_line | null | null | 84 | — | — | 14/84 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Dubai | United Arab Emirates | 71 | — | — | 15/71 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Dubai) |
| no_line | Águas Claras | Brazil | 75 | — | — | 1/75 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20%C3%81guas%20Claras) |
| no_line | Santo Domingo | Dominican Republic | 51 | — | — | 3/51 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Santo%20Domingo) |
| no_line | Medellín | Colombia | 29 | — | — | 1/29 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Medell%C3%ADn) |
| no_line | Maywood | United States | 32 | — | — | 8/32 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Maywood) |
| no_line | Kaohsiung | Taiwan | 47 | — | — | 8/47 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kaohsiung) |
| no_line | null | null | 25 | — | — | 6/25 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Kuala Lumpur | Malaysia | 69 | — | — | 5/69 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kuala%20Lumpur) |
| no_line | null | null | 29 | — | — | 1/29 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | null | null | 24 | — | — | 1/24 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Dongguan | China | 46 | — | — | 1/46 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Dongguan) |
| no_line | Daegu | South Korea | 70 | — | — | 4/70 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Daegu) |
| no_line | Bursa | Turkey | 43 | — | — | 1/43 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bursa) |
| no_line | Nagpur | India | 38 | — | — | 1/38 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Nagpur) |
| no_line | Changzhou | China | 123 | — | — | 41/123 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Changzhou) |
| no_line | Jinhua | China | 51 | — | — | 5/51 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jinhua) |
| no_line | Taiyuan | China | 53 | — | — | 3/53 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Taiyuan) |
| no_line | Shaoxing | China | 56 | — | — | 14/56 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Shaoxing) |
| no_line | Foshan | China | 52 | — | — | 1/52 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Foshan) |
| no_line | Pune | India | 41 | — | — | 2/41 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Pune) |
| no_line | Chongchuan District | China | 54 | — | — | 1/54 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chongchuan%20District) |
| no_line | Manila | Philippines | 39 | — | — | 25/39 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Manila) |
| no_line | Samara | Russia | 10 | — | — | 8/10 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Samara) |
| no_line | Seville | Spain | 22 | — | — | 3/22 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Seville) |
| no_line | Algiers | Algeria | 39 | — | — | 16/39 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Algiers) |
| no_line | null | null | 22 | — | — | 1/22 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Makkah Region | Saudi Arabia | 12 | — | — | 3/12 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Makkah%20Region) |
| no_line | Meaux | France | 9 | — | — | 3/9 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Meaux) |
| no_line | null | null | 53 | — | — | 26/53 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Karaj | Iran | 7 | — | — | 3/7 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Karaj) |
| no_line | null | null | 25 | — | — | 3/25 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Shiraz | Iran | 9 | — | — | 3/9 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Shiraz) |
| no_line | null | null | 20 | — | — | 1/20 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| no_line | Sydney | Australia | 32 | — | — | 10/32 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sydney) |
| no_line | Noida | India | 20 | — | — | 1/20 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Noida) |
| no_line | Jakarta | Indonesia | 20 | — | — | 7/20 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| no_line | Guadalajara | Mexico | 26 | — | — | 7/26 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Guadalajara) |
| no_line | Chuzhou | China | 15 | — | — | 5/15 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chuzhou) |
| no_line | Patna | India | 5 | — | — | 2/5 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Patna) |
| no_line | Jincheon-eup | South Korea | 2 | — | — | 2/2 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jincheon-eup) |
| no_line | Perth | Australia | 2 | — | — | 2/2 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Perth) |
| no_line | Piracuruca | Brazil | 15 | — | — | 15/15 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Piracuruca) |
| no_line | Antwerp | Belgium | 12 | — | — | 12/12 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Antwerp) |
| no_line | Kanazawa | Japan | 1 | — | — | 1/1 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kanazawa) |
| no_line | Amroli | India | 13 | — | — | 13/13 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Amroli) |
| no_line | Majura Taluka | India | 17 | — | — | 17/17 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Majura%20Taluka) |
| no_line | Sachin | India | 2 | — | — | 2/2 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sachin) |
| no_line | Chenghua District | China | 1 | — | — | 1/1 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chenghua%20District) |
| no_line | Guayaquil | Ecuador | 2 | — | — | 2/2 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Guayaquil) |
| no_line | Valencia | Venezuela | 4 | — | — | 4/4 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Valencia) |
| no_line | Ramat Gan | Israel | 1 | — | — | 1/1 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Ramat%20Gan) |
| no_line | Blue Area | Pakistan | 1 | — | — | 1/1 站不屬於任何路線（違反不變式：車站必有路線） | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Blue%20Area) |
| low | New York City | United States | 28 | 424 | 0.07 | 站數偏少（28 vs wiki 424） | [wiki](https://en.wikipedia.org/wiki/New_York_City_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| low | Kuala Lumpur | Malaysia | 69 | 156 | 0.44 | 站數偏少（69 vs wiki 156） | [wiki](https://en.wikipedia.org/wiki/Rapid_KL[Nb_63]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kuala%20Lumpur) |
| low | Shiraz | Iran | 9 | 24 | 0.38 | 站數偏少（9 vs wiki 24） | [wiki](https://en.wikipedia.org/wiki/Shiraz_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Shiraz) |
| low | Lagos | Nigeria | 5 | 13 | 0.38 | 站數偏少（5 vs wiki 13） | [wiki](https://en.wikipedia.org/wiki/Lagos_Rail_Mass_Transit[Nb_72]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lagos) |
| low | Valencia | Venezuela | 4 | 9 | 0.44 | 站數偏少（4 vs wiki 9） | [wiki](https://en.wikipedia.org/wiki/Metro_Valencia) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Valencia) |
| high | Singapore | Singapore | 235 | 143 | 1.64 | 站數偏多（235 vs wiki 143），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Mass_Rapid_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Singapore) |
| high | Tokyo | Japan | 316 | 142 | 2.23 | 站數偏多（316 vs wiki 142），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Tokyo_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Kunming | China | 195 | 103 | 1.89 | 站數偏多（195 vs wiki 103），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kunming_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kunming) |
| high | Tokyo | Japan | 316 | 99 | 3.19 | 站數偏多（316 vs wiki 99），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Toei_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Rome | Italy | 139 | 74 | 1.88 | 站數偏多（139 vs wiki 74），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Rome_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Rome) |
| high | Xuzhou | China | 149 | 67 | 2.22 | 站數偏多（149 vs wiki 67），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Xuzhou_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Xuzhou) |
| high | Bangkok | Thailand | 159 | 64 | 2.48 | 站數偏多（159 vs wiki 64），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/BTS_Skytrain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bangkok) |
| high | London | United Kingdom | 280 | 45 | 6.22 | 站數偏多（280 vs wiki 45），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Docklands_Light_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20London) |
| high | Changzhou | China | 123 | 43 | 2.86 | 站數偏多（123 vs wiki 43），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Changzhou_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Changzhou) |
| high | Chennai | India | 86 | 42 | 2.05 | 站數偏多（86 vs wiki 42），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Chennai_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Chennai) |
| high | Monterrey | Mexico | 63 | 38 | 1.66 | 站數偏多（63 vs wiki 38），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Metrorrey) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Monterrey) |
| high | Toulouse | France | 69 | 37 | 1.86 | 站數偏多（69 vs wiki 37），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Toulouse_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Toulouse) |
| high | Marseille | France | 128 | 29 | 4.41 | 站數偏多（128 vs wiki 29），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Marseille_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Marseille) |
| high | Montreal | Canada | 88 | 23 | 3.83 | 站數偏多（88 vs wiki 23），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Réseau_express_métropolitain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Montreal) |
| high | Algiers | Algeria | 39 | 19 | 2.05 | 站數偏多（39 vs wiki 19），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Algiers_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Algiers) |
| high | Tokyo | Japan | 316 | 16 | 19.75 | 站數偏多（316 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Yurikamome) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Seoul | South Korea | 526 | 16 | 32.88 | 站數偏多（526 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Shinbundang_Line[Nb_62]_(Neo_Trans)) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Seoul) |
| high | Yokohama | Japan | 49 | 14 | 3.5 | 站數偏多（49 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kanazawa_Seaside_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| high | Philadelphia | United States | 67 | 14 | 4.79 | 站數偏多（67 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATCO_Speedline) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Philadelphia) |
| high | Tokyo | Japan | 316 | 13 | 24.31 | 站數偏多（316 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Nippori-Toneri_Liner) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Manila | Philippines | 39 | 13 | 3 | 站數偏多（39 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Manila_Metro_Rail_Transit_System) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Manila) |
| high | New York City | United States | 28 | 13 | 2.15 | 站數偏多（28 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATH) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | New Taipei | Taiwan | 23 | 12 | 1.92 | 站數偏多（23 vs wiki 12），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/New_Taipei_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20Taipei) |
| high | Tokyo | Japan | 316 | 8 | 39.5 | 站數偏多（316 vs wiki 8），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Rinkai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Jakarta | Indonesia | 20 | 6 | 3.33 | 站數偏多（20 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Jakarta_LRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| high | Yokohama | Japan | 49 | 6 | 8.17 | 站數偏多（49 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Minatomirai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| high | Karaj | Iran | 7 | 4 | 1.75 | 站數偏多（7 vs wiki 4），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Karaj_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Karaj) |

## 額外系統（本資料有、Wikipedia 清單無）

多為 OSM 標為 subway 但非 Wikipedia 定義的地鐵、或城市名變體/切分。

| 檔案 | 城市 | 國家 | 站 | 線 |
|---|---|---|---|---|
| systems/north-america/united-states/north-america-united-states-new-york.geojson | New York | United States | 486 | 28 |
| systems/europe/germany/europe-germany-dusseldorf.geojson | Dusseldorf | Germany | 219 | 14 |
| systems/europe/germany/europe-germany-frankfurt.geojson | Frankfurt | Germany | 87 | 9 |
| systems/asia/china/asia-china-yinzhou-district.geojson | Yinzhou District | China | 188 | 8 |
| systems/europe/sweden/europe-sweden-stockholm-municipality.geojson | Stockholm Municipality | Sweden | 101 | 7 |
| systems/europe/spain/europe-spain-paterna.geojson | Paterna | Spain | 100 | 6 |
| systems/asia/china/asia-china-licheng-district.geojson | Licheng District | China | 110 | 6 |
| systems/europe/germany/europe-germany-bielefeld.geojson | Bielefeld | Germany | 0 | 4 |
| systems/europe/denmark/europe-denmark-sundbyerne.geojson | Sundbyerne | Denmark | 46 | 4 |
| systems/unknown/unknown/unknown.geojson | — | — | 117 | 4 |
| systems/north-america/canada/north-america-canada-burnaby.geojson | Burnaby | Canada | 56 | 3 |
| systems/europe/germany/europe-germany-furth.geojson | Fürth | Germany | 49 | 3 |
| systems/unknown/unknown/sapporo-municipal-subway.geojson | — | — | 51 | 3 |
| systems/unknown/unknown/fukuoka-city-subway.geojson | — | — | 73 | 3 |
| systems/unknown/unknown/harbin-metro.geojson | — | — | 78 | 3 |
| systems/unknown/unknown/xiamen-metro.geojson | — | — | 84 | 3 |
| systems/unknown/unknown/guiyang-metro.geojson | — | — | 65 | 3 |
| systems/asia/japan/asia-japan-kawasaki.geojson | Kawasaki | Japan | 0 | 3 |
| systems/asia/turkey/asia-turkey-gebze.geojson | Gebze | Turkey | 11 | 3 |
| systems/europe/france/europe-france-marcq-en-bar-ul.geojson | Marcq-en-Barœul | France | 65 | 2 |
| systems/europe/russia/europe-russia.geojson | Ленинский район | Russia | 15 | 2 |
| systems/south-america/brazil/south-america-brazil-canoas.geojson | Canoas | Brazil | 23 | 2 |
| systems/south-america/brazil/south-america-brazil-aguas-claras.geojson | Águas Claras | Brazil | 75 | 2 |
| systems/north-america/united-states/north-america-united-states-maywood.geojson | Maywood | United States | 32 | 2 |
| systems/unknown/unknown/mashhad-urban-railway.geojson | — | — | 25 | 2 |
| systems/unknown/unknown/sendai-subway.geojson | — | — | 30 | 2 |
| systems/unknown/unknown/lanzhou-metro.geojson | — | — | 29 | 2 |
| systems/unknown/unknown/urumqi-metro.geojson | — | — | 24 | 2 |
| systems/asia/japan/asia-japan-nerima.geojson | Nerima | Japan | 0 | 2 |
| systems/asia/china/asia-china-chongchuan-district.geojson | Chongchuan District | China | 54 | 2 |
| systems/asia/india/asia-india-fafrana.geojson | fafrana | India | 7 | 2 |
| systems/europe/spain/europe-spain-seville.geojson | Seville | Spain | 22 | 1 |
| systems/unknown/unknown/metro-de-belo-horizonte.geojson | — | — | 22 | 1 |
| systems/asia/saudi-arabia/asia-saudi-arabia-makkah-region.geojson | Makkah Region | Saudi Arabia | 12 | 1 |
| systems/north-america/united-states/north-america-united-states-puerto-nuevo.geojson | Puerto Nuevo | United States | 16 | 1 |
| systems/europe/austria/europe-austria-bezirk-landeck.geojson | Bezirk Landeck | Austria | 9 | 1 |
| systems/europe/france/europe-france-meaux.geojson | Meaux | France | 9 | 1 |
| systems/asia/japan/asia-japan-ichikawa.geojson | Ichikawa | Japan | 0 | 1 |
| systems/south-america/venezuela/south-america-venezuela-las-lomitas.geojson | Las Lomitas | Venezuela | 7 | 1 |
| systems/unknown/unknown/system.geojson | — | — | 53 | 1 |
| systems/unknown/unknown/shiraz-metro.geojson | — | — | 25 | 1 |
| systems/unknown/unknown/tabriz-metro.geojson | — | — | 20 | 1 |
| systems/asia/japan/asia-japan-yachiyo.geojson | Yachiyo | Japan | 8 | 1 |
| systems/asia/japan/asia-japan-kawaguchi.geojson | Kawaguchi | Japan | 8 | 1 |
| systems/asia/japan/asia-japan-setagaya.geojson | Setagaya | Japan | 0 | 1 |
| systems/asia/japan/asia-japan-matsudo.geojson | Matsudo | Japan | 0 | 1 |
| systems/asia/japan/asia-japan-suginami.geojson | Suginami | Japan | 0 | 1 |
| systems/asia/japan/asia-japan-tokorozawa.geojson | Tokorozawa | Japan | 0 | 1 |
| systems/asia/china/asia-china-chuzhou.geojson | Chuzhou | China | 15 | 1 |
| systems/asia/india/asia-india-mumbai-zone-2.geojson | Mumbai Zone 2 | India | 0 | 1 |
| systems/south-america/colombia/south-america-colombia-bogota.geojson | Bogota | Colombia | 0 | 1 |
| systems/asia/south-korea/asia-south-korea-jincheon-eup.geojson | Jincheon-eup | South Korea | 2 | 0 |
| systems/oceania/australia/oceania-australia-perth.geojson | Perth | Australia | 2 | 0 |
| systems/south-america/brazil/south-america-brazil-piracuruca.geojson | Piracuruca | Brazil | 15 | 0 |
| systems/europe/belgium/europe-belgium-antwerp.geojson | Antwerp | Belgium | 12 | 0 |
| systems/asia/japan/asia-japan-kanazawa.geojson | Kanazawa | Japan | 1 | 0 |
| systems/asia/india/asia-india-amroli.geojson | Amroli | India | 13 | 0 |
| systems/asia/india/asia-india-majura-taluka.geojson | Majura Taluka | India | 17 | 0 |
| systems/asia/india/asia-india-sachin.geojson | Sachin | India | 2 | 0 |
| systems/asia/china/asia-china-chenghua-district.geojson | Chenghua District | China | 1 | 0 |
| systems/south-america/ecuador/south-america-ecuador-guayaquil.geojson | Guayaquil | Ecuador | 2 | 0 |
| systems/asia/israel/asia-israel-ramat-gan.geojson | Ramat Gan | Israel | 1 | 0 |
| systems/asia/pakistan/asia-pakistan-blue-area.geojson | Blue Area | Pakistan | 1 | 0 |
