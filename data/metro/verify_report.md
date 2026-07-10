# Metro data verification report

對照 **Wikipedia List of metro systems**（站數）＋ urbanrail.net 參考連結。

| 指標 | 值 |
|---|---|
| Wikipedia 系統數 | 233 |
| 本資料系統數 | 308 |
| 站數相符 (ok) | 187 |
| 標記待查 | 54（missing 1／no_line 0／order 8／zero 0／low 3／high 42） |
| 額外（不在 wiki 清單） | 94 |

## 不變式（invariants，違反＝資料一定有錯，必須驗證修正）

1. **wiki 有列的城市不可能沒資料**：違反數 **1**（severity `missing`）
2. **車站不可能沒有路線**：**0** 個系統、共 **0** 站的 `lines` 為空（severity `no_line`）
3. **站序必須正確**：**8** 個系統有站序可疑的線（severity `order`）——一律以該線 **Wikipedia 條目**的車站列表與 **urbanrail.net** 的線路站序人工確認

## 待查系統（fetch⇄verify 迴圈的回饋清單）

| 嚴重度 | 城市 | 國家 | 本站數 | wiki站數 | 比值 | 說明 | 參考 |
|---|---|---|---|---|---|---|---|
| missing | Wuhu | China | — | 36 | — | 本資料無此系統（OSM 未以 route=subway 標記，或城市名不同） | [wiki](https://en.wikipedia.org/wiki/Wuhu_Rail_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Wuhu) |
| order | New York City | United States | 529 | — | — | 2 條線站序可疑（路徑長 > 1.6× MST）：Jamaica Station Route 1.86×、Howard Beach Route 1.79×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| order | Sydney | Australia | 170 | — | — | 7 條線站序可疑（路徑長 > 1.6× MST）：Bybanen til Fyllingsdalen 2.3×、Bybanen til Fyllingsdalen, deltrinn 1 1.85×、华为松山湖有轨电车3号线 1.81×、Metro D 1.78×…，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sydney) |
| order | Tokyo | Japan | 266 | — | — | 3 條線站序可疑（路徑長 > 1.6× MST）：Tokyo Metro - Skytree Bypass Line (Hibiya, North->South) 1.85×、Tokyo Metro - Skytree Bypass Line (Hanzomon, South->North) 1.83×、Tokyo Metro - Denentoshi bypass line (Chuo-Rinkan -> Shibuya) 1.64×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| order | Buenos Aires | Argentina | 116 | — | — | 1 條線站序可疑（路徑長 > 1.6× MST）：Tren Universitario 1.69×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Buenos%20Aires) |
| order | Yokohama | Japan | 69 | — | — | 2 條線站序可疑（路徑長 > 1.6× MST）：Tokyo Metro - Mukōgaoka-Yuen Bypass Line (westbound) 1.94×、Tokyo Metro - Odawara Bypass Line (southbound) 1.79×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| order | Kobe | Japan | 44 | — | — | 1 條線站序可疑（路徑長 > 1.6× MST）：Port Liner 1.63×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kobe) |
| order | Doha | Qatar | 22 | — | — | 2 條線站序可疑（路徑長 > 1.6× MST）：Lusaii LRT - Purple Line 1.85×、Lusail Tram Orange Line: Legtaifiya → Al Yasmeen → Legtaifiya 1.64×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Doha) |
| order | null | null | 0 | — | — | 1 條線站序可疑（路徑長 > 1.6× MST）：Red Line Jerusalem Light Rail 1.68×，需以 Wikipedia 線路條目與 urbanrail 人工確認站序 | [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20) |
| low | Doha | Qatar | 22 | 37 | 0.59 | 站數偏少（22 vs wiki 37） | [wiki](https://en.wikipedia.org/wiki/Doha_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Doha) |
| low | Lagos | Nigeria | 5 | 13 | 0.38 | 站數偏少（5 vs wiki 13） | [wiki](https://en.wikipedia.org/wiki/Lagos_Rail_Mass_Transit[Nb_72]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lagos) |
| low | Samara | Russia | 3 | 10 | 0.3 | 站數偏少（3 vs wiki 10） | [wiki](https://en.wikipedia.org/wiki/Samara_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Samara) |
| high | Berlin | Germany | 405 | 175 | 2.31 | 站數偏多（405 vs wiki 175），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Berlin_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Berlin) |
| high | Tokyo | Japan | 266 | 142 | 1.87 | 站數偏多（266 vs wiki 142），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Tokyo_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Hong Kong | China | 190 | 99 | 1.92 | 站數偏多（190 vs wiki 99），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Mass_Transit_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Hong%20Kong) |
| high | Tokyo | Japan | 266 | 99 | 2.69 | 站數偏多（266 vs wiki 99），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Toei_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Hamburg | Germany | 155 | 93 | 1.67 | 站數偏多（155 vs wiki 93），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Hamburg_U-Bahn) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Hamburg) |
| high | Bangkok | Thailand | 112 | 64 | 1.75 | 站數偏多（112 vs wiki 64），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/BTS_Skytrain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Bangkok) |
| high | Philadelphia | United States | 93 | 53 | 1.75 | 站數偏多（93 vs wiki 53），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/SEPTA_Metro:_L,_B,_M[446]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Philadelphia) |
| high | Boston | United States | 115 | 52 | 2.21 | 站數偏多（115 vs wiki 52），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/MBTA_subway[Nb_92]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Boston) |
| high | Budapest | Hungary | 116 | 48 | 2.42 | 站數偏多（116 vs wiki 48），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Budapest_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Budapest) |
| high | San Francisco (Bay Area) | United States | 215 | 47 | 4.57 | 站數偏多（215 vs wiki 47），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/BART[Nb_102]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20San%20Francisco%20(Bay%20Area)) |
| high | London | United Kingdom | 318 | 45 | 7.07 | 站數偏多（318 vs wiki 45），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Docklands_Light_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20London) |
| high | Copenhagen | Denmark | 130 | 44 | 2.95 | 站數偏多（130 vs wiki 44），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Copenhagen_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Copenhagen) |
| high | Rio de Janeiro | Brazil | 112 | 41 | 2.73 | 站數偏多（112 vs wiki 41），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Rio_de_Janeiro_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Rio%20de%20Janeiro) |
| high | Yokohama | Japan | 69 | 40 | 1.73 | 站數偏多（69 vs wiki 40），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Yokohama_Municipal_Subway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| high | Kaohsiung | Taiwan | 67 | 38 | 1.76 | 站數偏多（67 vs wiki 38），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kaohsiung_Rapid_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kaohsiung) |
| high | Naples | Italy | 123 | 31 | 3.97 | 站數偏多（123 vs wiki 31），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Naples_Metro[Nb_53]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Naples) |
| high | Helsinki | Finland | 63 | 30 | 2.1 | 站數偏多（63 vs wiki 30），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Helsinki_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Helsinki) |
| high | Guadalajara | Mexico | 86 | 28 | 3.07 | 站數偏多（86 vs wiki 28），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/SITEUR[Nb_65]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Guadalajara) |
| high | Montreal | Canada | 89 | 23 | 3.87 | 站數偏多（89 vs wiki 23），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Réseau_express_métropolitain) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Montreal) |
| high | Sydney | Australia | 170 | 21 | 8.1 | 站數偏多（170 vs wiki 21），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Sydney_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Sydney) |
| high | New York City | United States | 529 | 21 | 25.19 | 站數偏多（529 vs wiki 21），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Staten_Island_Railway) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | Fortaleza | Brazil | 41 | 20 | 2.05 | 站數偏多（41 vs wiki 20），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Fortaleza_Metro[Nb_8]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Fortaleza) |
| high | Los Angeles | United States | 112 | 19 | 5.89 | 站數偏多（112 vs wiki 19），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Metro_Rail[Nb_96]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Los%20Angeles) |
| high | Jakarta | Indonesia | 37 | 18 | 2.06 | 站數偏多（37 vs wiki 18），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Jabodebek_LRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| high | Kobe | Japan | 44 | 18 | 2.44 | 站數偏多（44 vs wiki 18），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kobe_New_Transit) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Kobe) |
| high | Cleveland | United States | 50 | 18 | 2.78 | 站數偏多（50 vs wiki 18），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Red_Line_(RTA_Rapid_Transit)) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Cleveland) |
| high | Tokyo | Japan | 266 | 16 | 16.63 | 站數偏多（266 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Yurikamome) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Seoul | South Korea | 509 | 16 | 31.81 | 站數偏多（509 vs wiki 16），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Shinbundang_Line[Nb_62]_(Neo_Trans)) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Seoul) |
| high | Yokohama | Japan | 69 | 14 | 4.93 | 站數偏多（69 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Kanazawa_Seaside_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |
| high | Lausanne | Switzerland | 27 | 14 | 1.93 | 站數偏多（27 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Lausanne_Metro[Nb_85]) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Lausanne) |
| high | Baltimore | United States | 45 | 14 | 3.21 | 站數偏多（45 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Baltimore_Metro_SubwayLink) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Baltimore) |
| high | Philadelphia | United States | 93 | 14 | 6.64 | 站數偏多（93 vs wiki 14），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATCO_Speedline) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Philadelphia) |
| high | Jakarta | Indonesia | 37 | 13 | 2.85 | 站數偏多（37 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Jakarta_MRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| high | Saitama Prefecture | Japan | 55 | 13 | 4.23 | 站數偏多（55 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/New_Shuttle) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Saitama%20Prefecture) |
| high | Tokyo | Japan | 266 | 13 | 20.46 | 站數偏多（266 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Nippori-Toneri_Liner) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Manila | Philippines | 51 | 13 | 3.92 | 站數偏多（51 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Manila_Metro_Rail_Transit_System) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Manila) |
| high | New York City | United States | 529 | 13 | 40.69 | 站數偏多（529 vs wiki 13），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/PATH) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20New%20York%20City) |
| high | Genoa | Italy | 16 | 8 | 2 | 站數偏多（16 vs wiki 8），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Genoa_Metro) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Genoa) |
| high | Saitama Prefecture | Japan | 55 | 8 | 6.88 | 站數偏多（55 vs wiki 8），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Saitama_Rapid_Railway_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Saitama%20Prefecture) |
| high | Tokyo | Japan | 266 | 8 | 33.25 | 站數偏多（266 vs wiki 8），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Rinkai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Tokyo) |
| high | Jakarta | Indonesia | 37 | 6 | 6.17 | 站數偏多（37 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Jakarta_LRT) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Jakarta) |
| high | Yokohama | Japan | 69 | 6 | 11.5 | 站數偏多（69 vs wiki 6），可能混入輕軌 | [wiki](https://en.wikipedia.org/wiki/Minatomirai_Line) · [urbanrail](https://www.google.com/search?q=site%3Aurbanrail.net%20Yokohama) |

## 額外系統（本資料有、Wikipedia 清單無）

多為 OSM 標為 subway 但非 Wikipedia 定義的地鐵、或城市名變體/切分。

| 檔案 | 城市 | 國家 | 站 | 線 |
|---|---|---|---|---|
| systems/europe/germany/europe-germany-stuttgart.geojson | Stuttgart | Germany | 203 | 16 |
| systems/europe/germany/europe-germany-bad-wildbad.geojson | Bad Wildbad | Germany | 8 | 9 |
| systems/europe/germany/europe-germany-dusseldorf.geojson | Dusseldorf | Germany | 105 | 9 |
| systems/europe/spain/europe-spain-xirivella.geojson | Xirivella | Spain | 111 | 7 |
| systems/asia/myanmar/asia-myanmar-yangon-city.geojson | Yangon City | Myanmar | 58 | 7 |
| systems/unknown/unknown/mhd-kosice.geojson | — | — | 0 | 7 |
| systems/north-america/united-states/north-america-united-states-denver.geojson | Denver | United States | 57 | 6 |
| systems/europe/portugal/europe-portugal-porto.geojson | Porto | Portugal | 86 | 6 |
| systems/europe/germany/europe-germany-bielefeld.geojson | Bielefeld | Germany | 60 | 4 |
| systems/unknown/unknown/verkehrsverbund-mittelsachsen.geojson | — | — | 0 | 4 |
| systems/africa/tunisia/africa-tunisia-sidi-hassine.geojson | Sidi Hassine | Tunisia | 41 | 4 |
| systems/unknown/unknown/t.geojson | — | — | 12 | 4 |
| systems/north-america/united-states/north-america-united-states-minneapolis.geojson | Minneapolis | United States | 77 | 4 |
| systems/europe/belgium/europe-belgium-charleroi.geojson | Charleroi | Belgium | 50 | 4 |
| systems/north-america/united-states/north-america-united-states-san-diego.geojson | San Diego | United States | 62 | 4 |
| systems/north-america/united-states/north-america-united-states-miller-county.geojson | Miller County | United States | 68 | 4 |
| systems/unknown/france/france-lyon.geojson | Lyon | France | 0 | 4 |
| systems/europe/germany/europe-germany-pforzheim.geojson | Pforzheim | Germany | 2 | 3 |
| systems/north-america/united-states/north-america-united-states-taylorsville.geojson | Taylorsville | United States | 52 | 3 |
| systems/europe/spain/europe-spain-caldas-de-reis.geojson | Caldas de Reis | Spain | 45 | 3 |
| systems/north-america/canada/north-america-canada-edmonton.geojson | Edmonton | Canada | 31 | 3 |
| systems/north-america/united-states/north-america-united-states-sacramento.geojson | Sacramento | United States | 54 | 3 |
| systems/unknown/unknown/utrecht-binnen.geojson | — | — | 32 | 3 |
| systems/north-america/united-states/north-america-united-states-san-jose.geojson | San Jose | United States | 57 | 3 |
| systems/north-america/united-states/north-america-united-states-pittsburgh.geojson | Pittsburgh | United States | 52 | 3 |
| systems/north-america/united-states/north-america-united-states-phoenix.geojson | Phoenix | United States | 60 | 3 |
| systems/asia/qatar/asia-qatar-doha.geojson | Doha | Qatar | 41 | 3 |
| systems/north-america/united-states/north-america-united-states-paradise.geojson | Paradise | United States | 5 | 3 |
| systems/north-america/canada/north-america-canada-ottawa.geojson | Ottawa | Canada | 25 | 3 |
| systems/asia/turkey/asia-turkey-derince.geojson | Derince | Turkey | 11 | 3 |
| systems/unknown/argentina/argentina-buenos-aires.geojson | Buenos Aires | Argentina | 2 | 3 |
| systems/europe/germany/europe-germany-ratingen.geojson | Ratingen | Germany | 89 | 2 |
| systems/europe/germany/europe-germany-essen.geojson | Essen | Germany | 18 | 2 |
| systems/europe/united-kingdom/europe-united-kingdom-south-tyneside.geojson | South Tyneside | United Kingdom | 60 | 2 |
| systems/europe/italy/europe-italy-pauli-monserrato.geojson | Paùli/Monserrato | Italy | 10 | 2 |
| systems/africa/tunisia/africa-tunisia-tunis.geojson | Tunis | Tunisia | 31 | 2 |
| systems/europe/spain/europe-spain-palma-de-mallorca.geojson | Palma de Mallorca | Spain | 18 | 2 |
| systems/europe/russia/europe-russia.geojson | Краснооктябрьский район | Russia | 22 | 2 |
| systems/north-america/canada/north-america-canada-calgary.geojson | Calgary | Canada | 45 | 2 |
| systems/unknown/unknown/cosenza.geojson | — | — | 0 | 2 |
| systems/unknown/unknown/tez.geojson | — | — | 2 | 2 |
| systems/europe/spain/europe-spain-malaga.geojson | Málaga | Spain | 19 | 2 |
| systems/africa/ethiopia/africa-ethiopia-lideta.geojson | Lideta | Ethiopia | 39 | 2 |
| systems/unknown/unknown/skyss.geojson | — | — | 29 | 2 |
| systems/europe/denmark/europe-denmark-tranbjerg.geojson | Tranbjerg | Denmark | 39 | 2 |
| systems/unknown/unknown/abuja-rail-mass-transit.geojson | — | — | 12 | 2 |
| systems/unknown/unknown/metro-express-ltd.geojson | — | — | 22 | 2 |
| systems/europe/finland/europe-finland-tampere.geojson | Tampere | Finland | 33 | 2 |
| systems/europe/france/europe-france-nantes.geojson | Nantes | France | 6 | 2 |
| systems/europe/germany/europe-germany-bochum.geojson | Bochum | Germany | 23 | 1 |
| systems/europe/germany/europe-germany-walzbachtal.geojson | Walzbachtal | Germany | 1 | 1 |
| systems/europe/spain/europe-spain-seville.geojson | Seville | Spain | 20 | 1 |
| systems/unknown/unknown/parkeisenbahn-chemnitz.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/metro-de-teresina.geojson | — | — | 26 | 1 |
| systems/unknown/unknown/tramway-du-cap-ferret.geojson | — | — | 0 | 1 |
| systems/north-america/united-states/north-america-united-states-vista.geojson | Vista | United States | 15 | 1 |
| systems/unknown/unknown/jerusalem.geojson | — | — | 0 | 1 |
| systems/asia/japan/asia-japan-sabae.geojson | Sabae | Japan | 27 | 1 |
| systems/unknown/unknown/isle-of-man-public-transport.geojson | — | — | 2 | 1 |
| systems/south-america/argentina/south-america-argentina-distrito-el-resguardo.geojson | Distrito El Resguardo | Argentina | 26 | 1 |
| systems/unknown/unknown/fal.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/tel-aviv-lrt.geojson | — | — | 37 | 1 |
| systems/unknown/unknown/tnw.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/ter-grand-est-solea.geojson | — | — | 0 | 1 |
| systems/europe/switzerland/europe-switzerland-kusnacht-zh.geojson | Küsnacht (ZH) | Switzerland | 14 | 1 |
| systems/europe/austria/europe-austria-bezirk-landeck.geojson | Bezirk Landeck | Austria | 4 | 1 |
| systems/unknown/unknown/west-midlands-trains.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/detroit-transportation-corporation.geojson | — | — | 13 | 1 |
| systems/unknown/unknown/bari.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/trenitalia.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/saarvv.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/cagliari.geojson | — | — | 1 | 1 |
| systems/europe/spain/europe-spain-granada.geojson | Granada | Spain | 26 | 1 |
| systems/north-america/canada/north-america-canada-kitchener.geojson | Kitchener | Canada | 19 | 1 |
| systems/asia/north-korea/asia-north-korea-hamhung-si.geojson | Hamhung-si | North Korea | 3 | 1 |
| systems/north-america/united-states/north-america-united-states-norfolk.geojson | Norfolk | United States | 11 | 1 |
| systems/europe/spain/europe-spain-chiclana-de-la-frontera.geojson | Chiclana de la Frontera | Spain | 13 | 1 |
| systems/south-america/brazil/south-america-brazil-juazeiro-do-norte.geojson | Juazeiro do Norte | Brazil | 9 | 1 |
| systems/unknown/unknown/szeged.geojson | — | — | 0 | 1 |
| systems/asia/china/asia-china-sanya-city.geojson | Sanya City | China | 15 | 1 |
| systems/unknown/unknown/pkm.geojson | — | — | 0 | 1 |
| systems/oceania/australia/oceania-australia-newcastle-maitland.geojson | Newcastle-Maitland | Australia | 5 | 1 |
| systems/europe/isle-of-man/europe-isle-of-man-douglas.geojson | Douglas | Isle of Man | 1 | 1 |
| systems/north-america/united-states/north-america-united-states-charlotte.geojson | Charlotte | United States | 26 | 1 |
| systems/oceania/australia/oceania-australia-district-of-gungahlin.geojson | District of Gungahlin | Australia | 14 | 1 |
| systems/asia/china/asia-china-huai-an-district.geojson | Huai'an District | China | 1 | 1 |
| systems/unknown/unknown/kereta-layang-bandara-soekarno-hatta.geojson | — | — | 4 | 1 |
| systems/unknown/unknown/paradiski.geojson | — | — | 0 | 1 |
| systems/unknown/unknown/local.geojson | — | — | 6 | 1 |
| systems/asia/china/asia-china-chuzhou.geojson | Chuzhou | China | 10 | 1 |
| systems/unknown/unknown/mpk-poznan.geojson | — | — | 0 | 1 |
| systems/south-america/colombia/south-america-colombia-bogota.geojson | Bogota | Colombia | 1 | 1 |
| systems/unknown/brazil/brazil-rio-de-janeiro.geojson | Rio de Janeiro | Brazil | 1 | 1 |
| systems/unknown/united-states/united-states-new-york-city.geojson | New York City | United States | 0 | 1 |
