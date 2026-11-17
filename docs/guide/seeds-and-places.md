# Seeds and places

A DSTNS run is named by one number, its **seed**. The seed decides where the
simulation happens and everything that happens there. This page explains what
a seed is, how it becomes a real place, how maps are cached, and how to save
and share configurations.

## What a seed is

A seed is an unsigned integer of up to 128 bits. You write it as a decimal
number everywhere you see one: on the command line, in the observer, in
reports. The same seed shown in the interface is the one you type to get the
same world back.

| You write | Means |
|---|---|
| `382923` | That seed |
| `0x5d7cb` | The same seed in hexadecimal (the internal form, shown as `seed_hex` in the API) |
| *(nothing)*, `auto`, `random`, `0` | Draw a fresh 64-bit seed, short enough to read off the screen and retype |

```bash
./launcher start --seed 382923
./launcher start --seed 0x5d7cb      # the same world
./launcher start                     # a fresh seed
```

## What a seed decides

```mermaid
flowchart TD
    S["Seed (128-bit)"] --> H{"SHA-256 derivation<br/>per subsystem"}
    H --> C["map.city → which of 379 cities"]
    H --> A["map.anchor → where in the city"]
    H --> M["map → district root, node attributes"]
    H --> SIG["signals → offsets, splits"]
    H --> W["weather → storm times, places, sizes"]
    H --> I["incidents → what, where, when"]
    H --> D["demand → place schedules"]
```

Each subsystem draws from its own sub-seed, derived from the master seed with
SHA-256 and a fixed label. Changing one subsystem's code therefore never
shifts another's random choices. See [Deterministic
seeding](../concepts/deterministic-seeding.md).

## From seed to place

Under the launcher's policy on core-ng, `urban-geo-v2`:

1. **City.** The `map.city` sub-seed picks one of 379 cities in 126 countries,
   on every inhabited continent (60 south of the equator, 128 west of
   Greenwich), or one of those Places allows. Under `urban-crfg-v3`, the
   original policy, it is one of the first 181, in 83 countries (25 south of
   the equator, 62 west of Greenwich), and every seed keeps the city it always
   had.
2. **Extract.** The city's extract is a square, 5 km on a side by default,
   centred on the city. Every seed that lands on the same city shares it.
3. **Anchor.** The `map.anchor` sub-seed picks a point in the middle half of
   the extract.
4. **District.** The road network grows outward from the junction nearest the
   anchor, along real roads, until it reaches about 3,000 junctions.

Two seeds that land on the same city therefore give two different districts of
it, from one download. See [OSM map generation](../concepts/osm-map-generation.md)
for the details.

!!! note "The catalogue is part of the policy"
    Which city a seed means depends on the catalogue and its order. Changing
    either would silently move every saved seed somewhere else, so each is
    frozen under its policy's name: the first 181 under `urban-crfg-v3` (and
    `urban-geo-v1`), all 379 under `urban-geo-v2`. New cities come only with a
    new policy, and seeds saved under a policy this build does not have are
    refused rather than reinterpreted.

??? info "The first 181 cities, in catalogue order"
    | # | City | Country | Latitude | Longitude |
    |---:|---|---|---:|---:|
    | 0 | London | United Kingdom | 51.5074 | -0.1278 |
    | 1 | Paris | France | 48.8566 | 2.3522 |
    | 2 | Berlin | Germany | 52.5200 | 13.4050 |
    | 3 | Madrid | Spain | 40.4168 | -3.7038 |
    | 4 | Barcelona | Spain | 41.3874 | 2.1686 |
    | 5 | Rome | Italy | 41.9028 | 12.4964 |
    | 6 | Milan | Italy | 45.4642 | 9.1900 |
    | 7 | Amsterdam | Netherlands | 52.3676 | 4.9041 |
    | 8 | Rotterdam | Netherlands | 51.9244 | 4.4777 |
    | 9 | Brussels | Belgium | 50.8503 | 4.3517 |
    | 10 | Vienna | Austria | 48.2082 | 16.3738 |
    | 11 | Prague | Czechia | 50.0755 | 14.4378 |
    | 12 | Budapest | Hungary | 47.4979 | 19.0402 |
    | 13 | Warsaw | Poland | 52.2297 | 21.0122 |
    | 14 | Krakow | Poland | 50.0647 | 19.9450 |
    | 15 | Copenhagen | Denmark | 55.6761 | 12.5683 |
    | 16 | Stockholm | Sweden | 59.3293 | 18.0686 |
    | 17 | Oslo | Norway | 59.9139 | 10.7522 |
    | 18 | Helsinki | Finland | 60.1699 | 24.9384 |
    | 19 | Dublin | Ireland | 53.3498 | -6.2603 |
    | 20 | Edinburgh | United Kingdom | 55.9533 | -3.1883 |
    | 21 | Manchester | United Kingdom | 53.4808 | -2.2426 |
    | 22 | Birmingham | United Kingdom | 52.4862 | -1.8904 |
    | 23 | Glasgow | United Kingdom | 55.8642 | -4.2518 |
    | 24 | Lisbon | Portugal | 38.7223 | -9.1393 |
    | 25 | Porto | Portugal | 41.1579 | -8.6291 |
    | 26 | Zurich | Switzerland | 47.3769 | 8.5417 |
    | 27 | Geneva | Switzerland | 46.2044 | 6.1432 |
    | 28 | Munich | Germany | 48.1351 | 11.5820 |
    | 29 | Hamburg | Germany | 53.5511 | 9.9937 |
    | 30 | Frankfurt | Germany | 50.1109 | 8.6821 |
    | 31 | Cologne | Germany | 50.9375 | 6.9603 |
    | 32 | Stuttgart | Germany | 48.7758 | 9.1829 |
    | 33 | Lyon | France | 45.7640 | 4.8357 |
    | 34 | Marseille | France | 43.2965 | 5.3698 |
    | 35 | Toulouse | France | 43.6047 | 1.4442 |
    | 36 | Naples | Italy | 40.8518 | 14.2681 |
    | 37 | Turin | Italy | 45.0703 | 7.6869 |
    | 38 | Florence | Italy | 43.7696 | 11.2558 |
    | 39 | Athens | Greece | 37.9838 | 23.7275 |
    | 40 | Bucharest | Romania | 44.4268 | 26.1025 |
    | 41 | Sofia | Bulgaria | 42.6977 | 23.3219 |
    | 42 | Belgrade | Serbia | 44.7866 | 20.4489 |
    | 43 | Zagreb | Croatia | 45.8150 | 15.9819 |
    | 44 | Ljubljana | Slovenia | 46.0569 | 14.5058 |
    | 45 | Bratislava | Slovakia | 48.1486 | 17.1077 |
    | 46 | Vilnius | Lithuania | 54.6872 | 25.2797 |
    | 47 | Riga | Latvia | 56.9496 | 24.1052 |
    | 48 | Tallinn | Estonia | 59.4370 | 24.7536 |
    | 49 | Valencia | Spain | 39.4699 | -0.3763 |
    | 50 | Seville | Spain | 37.3891 | -5.9845 |
    | 51 | Bilbao | Spain | 43.2630 | -2.9350 |
    | 52 | Antwerp | Belgium | 51.2194 | 4.4025 |
    | 53 | Gothenburg | Sweden | 57.7089 | 11.9746 |
    | 54 | Istanbul | Turkey | 41.0082 | 28.9784 |
    | 55 | Ankara | Turkey | 39.9334 | 32.8597 |
    | 56 | Izmir | Turkey | 38.4237 | 27.1428 |
    | 57 | Tokyo | Japan | 35.6762 | 139.6503 |
    | 58 | Osaka | Japan | 34.6937 | 135.5023 |
    | 59 | Yokohama | Japan | 35.4437 | 139.6380 |
    | 60 | Nagoya | Japan | 35.1815 | 136.9066 |
    | 61 | Fukuoka | Japan | 33.5904 | 130.4017 |
    | 62 | Sapporo | Japan | 43.0618 | 141.3545 |
    | 63 | Seoul | South Korea | 37.5665 | 126.9780 |
    | 64 | Busan | South Korea | 35.1796 | 129.0756 |
    | 65 | Incheon | South Korea | 37.4563 | 126.7052 |
    | 66 | Taipei | Taiwan | 25.0330 | 121.5654 |
    | 67 | Kaohsiung | Taiwan | 22.6273 | 120.3014 |
    | 68 | Hong Kong | China | 22.3193 | 114.1694 |
    | 69 | Singapore | Singapore | 1.3521 | 103.8198 |
    | 70 | Kuala Lumpur | Malaysia | 3.1390 | 101.6869 |
    | 71 | Bangkok | Thailand | 13.7563 | 100.5018 |
    | 72 | Ho Chi Minh City | Vietnam | 10.7769 | 106.7009 |
    | 73 | Hanoi | Vietnam | 21.0278 | 105.8342 |
    | 74 | Jakarta | Indonesia | -6.2088 | 106.8456 |
    | 75 | Manila | Philippines | 14.5995 | 120.9842 |
    | 76 | Shanghai | China | 31.2304 | 121.4737 |
    | 77 | Beijing | China | 39.9042 | 116.4074 |
    | 78 | Shenzhen | China | 22.5431 | 114.0579 |
    | 79 | Guangzhou | China | 23.1291 | 113.2644 |
    | 80 | Chengdu | China | 30.5728 | 104.0668 |
    | 81 | Hangzhou | China | 30.2741 | 120.1551 |
    | 82 | Mumbai | India | 19.0760 | 72.8777 |
    | 83 | Delhi | India | 28.6139 | 77.2090 |
    | 84 | Bengaluru | India | 12.9716 | 77.5946 |
    | 85 | Chennai | India | 13.0827 | 80.2707 |
    | 86 | Hyderabad | India | 17.3850 | 78.4867 |
    | 87 | Kolkata | India | 22.5726 | 88.3639 |
    | 88 | Pune | India | 18.5204 | 73.8567 |
    | 89 | Ahmedabad | India | 23.0225 | 72.5714 |
    | 90 | Jaipur | India | 26.9124 | 75.7873 |
    | 91 | Karachi | Pakistan | 24.8607 | 67.0011 |
    | 92 | Lahore | Pakistan | 31.5204 | 74.3587 |
    | 93 | Dhaka | Bangladesh | 23.8103 | 90.4125 |
    | 94 | Colombo | Sri Lanka | 6.9271 | 79.8612 |
    | 95 | Kathmandu | Nepal | 27.7172 | 85.3240 |
    | 96 | Tel Aviv | Israel | 32.0853 | 34.7818 |
    | 97 | Dubai | United Arab Emirates | 25.2048 | 55.2708 |
    | 98 | Abu Dhabi | United Arab Emirates | 24.4539 | 54.3773 |
    | 99 | Doha | Qatar | 25.2854 | 51.5310 |
    | 100 | Riyadh | Saudi Arabia | 24.7136 | 46.6753 |
    | 101 | Jeddah | Saudi Arabia | 21.4858 | 39.1925 |
    | 102 | Kuwait City | Kuwait | 29.3759 | 47.9774 |
    | 103 | Amman | Jordan | 31.9454 | 35.9284 |
    | 104 | Baku | Azerbaijan | 40.4093 | 49.8671 |
    | 105 | Tbilisi | Georgia | 41.7151 | 44.8271 |
    | 106 | Yerevan | Armenia | 40.1792 | 44.4991 |
    | 107 | Tashkent | Uzbekistan | 41.2995 | 69.2401 |
    | 108 | Almaty | Kazakhstan | 43.2220 | 76.8512 |
    | 109 | Cairo | Egypt | 30.0444 | 31.2357 |
    | 110 | Alexandria | Egypt | 31.2001 | 29.9187 |
    | 111 | Casablanca | Morocco | 33.5731 | -7.5898 |
    | 112 | Rabat | Morocco | 34.0209 | -6.8416 |
    | 113 | Tunis | Tunisia | 36.8065 | 10.1815 |
    | 114 | Algiers | Algeria | 36.7538 | 3.0588 |
    | 115 | Lagos | Nigeria | 6.5244 | 3.3792 |
    | 116 | Abuja | Nigeria | 9.0765 | 7.3986 |
    | 117 | Accra | Ghana | 5.6037 | -0.1870 |
    | 118 | Nairobi | Kenya | -1.2921 | 36.8219 |
    | 119 | Addis Ababa | Ethiopia | 9.0320 | 38.7469 |
    | 120 | Dar es Salaam | Tanzania | -6.7924 | 39.2083 |
    | 121 | Kampala | Uganda | 0.3476 | 32.5825 |
    | 122 | Johannesburg | South Africa | -26.2041 | 28.0473 |
    | 123 | Cape Town | South Africa | -33.9249 | 18.4241 |
    | 124 | Durban | South Africa | -29.8587 | 31.0218 |
    | 125 | Pretoria | South Africa | -25.7479 | 28.2293 |
    | 126 | New York | United States | 40.7128 | -74.0060 |
    | 127 | Chicago | United States | 41.8781 | -87.6298 |
    | 128 | Los Angeles | United States | 34.0522 | -118.2437 |
    | 129 | San Francisco | United States | 37.7749 | -122.4194 |
    | 130 | Seattle | United States | 47.6062 | -122.3321 |
    | 131 | Boston | United States | 42.3601 | -71.0589 |
    | 132 | Philadelphia | United States | 39.9526 | -75.1652 |
    | 133 | Washington | United States | 38.9072 | -77.0369 |
    | 134 | Atlanta | United States | 33.7490 | -84.3880 |
    | 135 | Miami | United States | 25.7617 | -80.1918 |
    | 136 | Houston | United States | 29.7604 | -95.3698 |
    | 137 | Dallas | United States | 32.7767 | -96.7970 |
    | 138 | Austin | United States | 30.2672 | -97.7431 |
    | 139 | Denver | United States | 39.7392 | -104.9903 |
    | 140 | Portland | United States | 45.5152 | -122.6784 |
    | 141 | Minneapolis | United States | 44.9778 | -93.2650 |
    | 142 | Detroit | United States | 42.3314 | -83.0458 |
    | 143 | Pittsburgh | United States | 40.4406 | -79.9959 |
    | 144 | San Diego | United States | 32.7157 | -117.1611 |
    | 145 | Phoenix | United States | 33.4484 | -112.0740 |
    | 146 | Las Vegas | United States | 36.1699 | -115.1398 |
    | 147 | New Orleans | United States | 29.9511 | -90.0715 |
    | 148 | Toronto | Canada | 43.6532 | -79.3832 |
    | 149 | Montreal | Canada | 45.5019 | -73.5674 |
    | 150 | Vancouver | Canada | 49.2827 | -123.1207 |
    | 151 | Ottawa | Canada | 45.4215 | -75.6972 |
    | 152 | Calgary | Canada | 51.0447 | -114.0719 |
    | 153 | Mexico City | Mexico | 19.4326 | -99.1332 |
    | 154 | Guadalajara | Mexico | 20.6597 | -103.3496 |
    | 155 | Monterrey | Mexico | 25.6866 | -100.3161 |
    | 156 | Panama City | Panama | 8.9824 | -79.5199 |
    | 157 | San Jose | Costa Rica | 9.9281 | -84.0907 |
    | 158 | Havana | Cuba | 23.1136 | -82.3666 |
    | 159 | Santo Domingo | Dominican Republic | 18.4861 | -69.9312 |
    | 160 | Guatemala City | Guatemala | 14.6349 | -90.5069 |
    | 161 | Bogota | Colombia | 4.7110 | -74.0721 |
    | 162 | Medellin | Colombia | 6.2442 | -75.5812 |
    | 163 | Lima | Peru | -12.0464 | -77.0428 |
    | 164 | Santiago | Chile | -33.4489 | -70.6693 |
    | 165 | Buenos Aires | Argentina | -34.6037 | -58.3816 |
    | 166 | Sao Paulo | Brazil | -23.5505 | -46.6333 |
    | 167 | Rio de Janeiro | Brazil | -22.9068 | -43.1729 |
    | 168 | Brasilia | Brazil | -15.7939 | -47.8828 |
    | 169 | Curitiba | Brazil | -25.4284 | -49.2733 |
    | 170 | Porto Alegre | Brazil | -30.0346 | -51.2177 |
    | 171 | Montevideo | Uruguay | -34.9011 | -56.1645 |
    | 172 | Quito | Ecuador | -0.1807 | -78.4678 |
    | 173 | Sydney | Australia | -33.8688 | 151.2093 |
    | 174 | Melbourne | Australia | -37.8136 | 144.9631 |
    | 175 | Brisbane | Australia | -27.4698 | 153.0251 |
    | 176 | Perth | Australia | -31.9505 | 115.8605 |
    | 177 | Adelaide | Australia | -34.9285 | 138.6007 |
    | 178 | Auckland | New Zealand | -36.8485 | 174.7633 |
    | 179 | Wellington | New Zealand | -41.2866 | 174.7756 |
    | 180 | Christchurch | New Zealand | -43.5321 | 172.6362 |

??? info "The 198 cities urban-geo-v2 adds, in catalogue order"
    These follow the 181 above, so every seed under `urban-crfg-v3` and `urban-geo-v1` keeps its city. They bring 43
    countries the first 181 did not have. `./launcher cities` lists all 379; Tools, Supported cities saves them as CSV.

    | # | City | Country | Code | Latitude | Longitude |
    |---:|---|---|---|---:|---:|
    | 181 | Kochi | India | IN | 9.9312 | 76.2673 |
    | 182 | Coimbatore | India | IN | 11.0168 | 76.9558 |
    | 183 | Lucknow | India | IN | 26.8467 | 80.9462 |
    | 184 | Chandigarh | India | IN | 30.7333 | 76.7794 |
    | 185 | Indore | India | IN | 22.7196 | 75.8577 |
    | 186 | Surat | India | IN | 21.1702 | 72.8311 |
    | 187 | Nagpur | India | IN | 21.1458 | 79.0882 |
    | 188 | Visakhapatnam | India | IN | 17.6868 | 83.2185 |
    | 189 | Thiruvananthapuram | India | IN | 8.5241 | 76.9366 |
    | 190 | Mysuru | India | IN | 12.2958 | 76.6394 |
    | 191 | Madurai | India | IN | 9.9252 | 78.1198 |
    | 192 | Bhopal | India | IN | 23.2599 | 77.4126 |
    | 193 | Bhubaneswar | India | IN | 20.2961 | 85.8245 |
    | 194 | Guwahati | India | IN | 26.1445 | 91.7362 |
    | 195 | Patna | India | IN | 25.5941 | 85.1376 |
    | 196 | Vadodara | India | IN | 22.3072 | 73.1812 |
    | 197 | Panaji | India | IN | 15.4909 | 73.8278 |
    | 198 | Mangaluru | India | IN | 12.9141 | 74.8560 |
    | 199 | Vijayawada | India | IN | 16.5062 | 80.6480 |
    | 200 | Noida | India | IN | 28.5355 | 77.3910 |
    | 201 | Gurugram | India | IN | 28.4595 | 77.0266 |
    | 202 | Kanpur | India | IN | 26.4499 | 80.3319 |
    | 203 | Ludhiana | India | IN | 30.9010 | 75.8573 |
    | 204 | Amritsar | India | IN | 31.6340 | 74.8723 |
    | 205 | Varanasi | India | IN | 25.3176 | 82.9739 |
    | 206 | Navi Mumbai | India | IN | 19.0330 | 73.0297 |
    | 207 | Thane | India | IN | 19.2183 | 72.9781 |
    | 208 | Bristol | United Kingdom | GB | 51.4545 | -2.5879 |
    | 209 | Leeds | United Kingdom | GB | 53.8008 | -1.5491 |
    | 210 | Liverpool | United Kingdom | GB | 53.4084 | -2.9916 |
    | 211 | Newcastle | United Kingdom | GB | 54.9783 | -1.6178 |
    | 212 | Belfast | United Kingdom | GB | 54.5973 | -5.9301 |
    | 213 | Cardiff | United Kingdom | GB | 51.4816 | -3.1791 |
    | 214 | Nice | France | FR | 43.7102 | 7.2620 |
    | 215 | Bordeaux | France | FR | 44.8378 | -0.5792 |
    | 216 | Lille | France | FR | 50.6292 | 3.0573 |
    | 217 | Nantes | France | FR | 47.2184 | -1.5536 |
    | 218 | Strasbourg | France | FR | 48.5734 | 7.7521 |
    | 219 | Dusseldorf | Germany | DE | 51.2277 | 6.7735 |
    | 220 | Leipzig | Germany | DE | 51.3397 | 12.3731 |
    | 221 | Dresden | Germany | DE | 51.0504 | 13.7373 |
    | 222 | Hanover | Germany | DE | 52.3759 | 9.7320 |
    | 223 | Nuremberg | Germany | DE | 49.4521 | 11.0767 |
    | 224 | Bologna | Italy | IT | 44.4949 | 11.3426 |
    | 225 | Genoa | Italy | IT | 44.4056 | 8.9463 |
    | 226 | Venice | Italy | IT | 45.4408 | 12.3155 |
    | 227 | Palermo | Italy | IT | 38.1157 | 13.3615 |
    | 228 | Malaga | Spain | ES | 36.7213 | -4.4214 |
    | 229 | Zaragoza | Spain | ES | 41.6488 | -0.8891 |
    | 230 | The Hague | Netherlands | NL | 52.0705 | 4.3007 |
    | 231 | Utrecht | Netherlands | NL | 52.0907 | 5.1214 |
    | 232 | Eindhoven | Netherlands | NL | 51.4416 | 5.4697 |
    | 233 | Ghent | Belgium | BE | 51.0543 | 3.7174 |
    | 234 | Luxembourg | Luxembourg | LU | 49.6116 | 6.1319 |
    | 235 | Basel | Switzerland | CH | 47.5596 | 7.5886 |
    | 236 | Bern | Switzerland | CH | 46.9480 | 7.4474 |
    | 237 | Salzburg | Austria | AT | 47.8095 | 13.0550 |
    | 238 | Graz | Austria | AT | 47.0707 | 15.4395 |
    | 239 | Brno | Czechia | CZ | 49.1951 | 16.6068 |
    | 240 | Gdansk | Poland | PL | 54.3520 | 18.6466 |
    | 241 | Wroclaw | Poland | PL | 51.1079 | 17.0385 |
    | 242 | Poznan | Poland | PL | 52.4064 | 16.9252 |
    | 243 | Lodz | Poland | PL | 51.7592 | 19.4560 |
    | 244 | Malmo | Sweden | SE | 55.6050 | 13.0038 |
    | 245 | Aarhus | Denmark | DK | 56.1629 | 10.2039 |
    | 246 | Bergen | Norway | NO | 60.3913 | 5.3221 |
    | 247 | Tampere | Finland | FI | 61.4978 | 23.7610 |
    | 248 | Reykjavik | Iceland | IS | 64.1466 | -21.9426 |
    | 249 | Thessaloniki | Greece | GR | 40.6401 | 22.9444 |
    | 250 | Cluj-Napoca | Romania | RO | 46.7712 | 23.6236 |
    | 251 | Kyiv | Ukraine | UA | 50.4501 | 30.5234 |
    | 252 | Lviv | Ukraine | UA | 49.8397 | 24.0297 |
    | 253 | Chisinau | Moldova | MD | 47.0105 | 28.8638 |
    | 254 | Sarajevo | Bosnia and Herzegovina | BA | 43.8563 | 18.4131 |
    | 255 | Skopje | North Macedonia | MK | 41.9981 | 21.4254 |
    | 256 | Tirana | Albania | AL | 41.3275 | 19.8187 |
    | 257 | Valletta | Malta | MT | 35.8989 | 14.5146 |
    | 258 | Nicosia | Cyprus | CY | 35.1856 | 33.3823 |
    | 259 | Cork | Ireland | IE | 51.8985 | -8.4756 |
    | 260 | Minsk | Belarus | BY | 53.9006 | 27.5590 |
    | 261 | Moscow | Russia | RU | 55.7558 | 37.6173 |
    | 262 | Saint Petersburg | Russia | RU | 59.9311 | 30.3609 |
    | 263 | Antalya | Turkey | TR | 36.8969 | 30.7133 |
    | 264 | Bursa | Turkey | TR | 40.1826 | 29.0665 |
    | 265 | Kyoto | Japan | JP | 35.0116 | 135.7681 |
    | 266 | Kobe | Japan | JP | 34.6901 | 135.1955 |
    | 267 | Hiroshima | Japan | JP | 34.3853 | 132.4553 |
    | 268 | Sendai | Japan | JP | 38.2682 | 140.8694 |
    | 269 | Daegu | South Korea | KR | 35.8714 | 128.6014 |
    | 270 | Daejeon | South Korea | KR | 36.3504 | 127.3845 |
    | 271 | Taichung | Taiwan | TW | 24.1477 | 120.6736 |
    | 272 | Macau | China | CN | 22.1987 | 113.5439 |
    | 273 | Wuhan | China | CN | 30.5928 | 114.3055 |
    | 274 | Xian | China | CN | 34.3416 | 108.9398 |
    | 275 | Nanjing | China | CN | 32.0603 | 118.7969 |
    | 276 | Chongqing | China | CN | 29.5630 | 106.5516 |
    | 277 | Tianjin | China | CN | 39.3434 | 117.3616 |
    | 278 | Suzhou | China | CN | 31.2989 | 120.5853 |
    | 279 | Qingdao | China | CN | 36.0671 | 120.3826 |
    | 280 | Ulaanbaatar | Mongolia | MN | 47.8864 | 106.9057 |
    | 281 | Phnom Penh | Cambodia | KH | 11.5564 | 104.9282 |
    | 282 | Vientiane | Laos | LA | 17.9757 | 102.6331 |
    | 283 | Yangon | Myanmar | MM | 16.8409 | 96.1735 |
    | 284 | Chiang Mai | Thailand | TH | 18.7883 | 98.9853 |
    | 285 | Da Nang | Vietnam | VN | 16.0544 | 108.2022 |
    | 286 | George Town | Malaysia | MY | 5.4141 | 100.3288 |
    | 287 | Johor Bahru | Malaysia | MY | 1.4927 | 103.7414 |
    | 288 | Surabaya | Indonesia | ID | -7.2575 | 112.7521 |
    | 289 | Bandung | Indonesia | ID | -6.9175 | 107.6191 |
    | 290 | Denpasar | Indonesia | ID | -8.6705 | 115.2126 |
    | 291 | Cebu City | Philippines | PH | 10.3157 | 123.8854 |
    | 292 | Davao City | Philippines | PH | 7.1907 | 125.4553 |
    | 293 | Islamabad | Pakistan | PK | 33.6844 | 73.0479 |
    | 294 | Chittagong | Bangladesh | BD | 22.3569 | 91.7832 |
    | 295 | Tehran | Iran | IR | 35.6892 | 51.3890 |
    | 296 | Isfahan | Iran | IR | 32.6546 | 51.6680 |
    | 297 | Baghdad | Iraq | IQ | 33.3152 | 44.3661 |
    | 298 | Beirut | Lebanon | LB | 33.8938 | 35.5018 |
    | 299 | Haifa | Israel | IL | 32.7940 | 34.9896 |
    | 300 | Muscat | Oman | OM | 23.5880 | 58.3829 |
    | 301 | Manama | Bahrain | BH | 26.2285 | 50.5860 |
    | 302 | Bishkek | Kyrgyzstan | KG | 42.8746 | 74.5698 |
    | 303 | Astana | Kazakhstan | KZ | 51.1694 | 71.4491 |
    | 304 | Dakar | Senegal | SN | 14.7167 | -17.4677 |
    | 305 | Abidjan | Ivory Coast | CI | 5.3600 | -4.0083 |
    | 306 | Kinshasa | DR Congo | CD | -4.4419 | 15.2663 |
    | 307 | Luanda | Angola | AO | -8.8390 | 13.2894 |
    | 308 | Kigali | Rwanda | RW | -1.9441 | 30.0619 |
    | 309 | Lusaka | Zambia | ZM | -15.3875 | 28.3228 |
    | 310 | Harare | Zimbabwe | ZW | -17.8252 | 31.0335 |
    | 311 | Maputo | Mozambique | MZ | -25.9692 | 32.5732 |
    | 312 | Windhoek | Namibia | NA | -22.5609 | 17.0658 |
    | 313 | Gaborone | Botswana | BW | -24.6282 | 25.9231 |
    | 314 | Antananarivo | Madagascar | MG | -18.8792 | 47.5079 |
    | 315 | Mombasa | Kenya | KE | -4.0435 | 39.6682 |
    | 316 | Marrakesh | Morocco | MA | 31.6295 | -7.9811 |
    | 317 | Tangier | Morocco | MA | 35.7595 | -5.8340 |
    | 318 | Port Louis | Mauritius | MU | -20.1609 | 57.5012 |
    | 319 | Kano | Nigeria | NG | 12.0022 | 8.5920 |
    | 320 | Ibadan | Nigeria | NG | 7.3775 | 3.9470 |
    | 321 | Kumasi | Ghana | GH | 6.6885 | -1.6244 |
    | 322 | Douala | Cameroon | CM | 4.0511 | 9.7679 |
    | 323 | Gqeberha | South Africa | ZA | -33.9608 | 25.6022 |
    | 324 | San Antonio | United States | US | 29.4241 | -98.4936 |
    | 325 | Nashville | United States | US | 36.1627 | -86.7816 |
    | 326 | Charlotte | United States | US | 35.2271 | -80.8431 |
    | 327 | Baltimore | United States | US | 39.2904 | -76.6122 |
    | 328 | Salt Lake City | United States | US | 40.7608 | -111.8910 |
    | 329 | Sacramento | United States | US | 38.5816 | -121.4944 |
    | 330 | Columbus | United States | US | 39.9612 | -82.9988 |
    | 331 | Indianapolis | United States | US | 39.7684 | -86.1581 |
    | 332 | Kansas City | United States | US | 39.0997 | -94.5786 |
    | 333 | St Louis | United States | US | 38.6270 | -90.1994 |
    | 334 | Cleveland | United States | US | 41.4993 | -81.6944 |
    | 335 | Cincinnati | United States | US | 39.1031 | -84.5120 |
    | 336 | Milwaukee | United States | US | 43.0389 | -87.9065 |
    | 337 | Tampa | United States | US | 27.9506 | -82.4572 |
    | 338 | Orlando | United States | US | 28.5383 | -81.3792 |
    | 339 | Raleigh | United States | US | 35.7796 | -78.6382 |
    | 340 | Honolulu | United States | US | 21.3099 | -157.8581 |
    | 341 | Anchorage | United States | US | 61.2181 | -149.9003 |
    | 342 | Edmonton | Canada | CA | 53.5461 | -113.4938 |
    | 343 | Winnipeg | Canada | CA | 49.8951 | -97.1384 |
    | 344 | Quebec City | Canada | CA | 46.8139 | -71.2080 |
    | 345 | Halifax | Canada | CA | 44.6488 | -63.5752 |
    | 346 | Puebla | Mexico | MX | 19.0414 | -98.2063 |
    | 347 | Tijuana | Mexico | MX | 32.5149 | -117.0382 |
    | 348 | Merida | Mexico | MX | 20.9674 | -89.5926 |
    | 349 | Cancun | Mexico | MX | 21.1619 | -86.8515 |
    | 350 | San Juan | Puerto Rico | PR | 18.4655 | -66.1057 |
    | 351 | Kingston | Jamaica | JM | 17.9714 | -76.7920 |
    | 352 | San Salvador | El Salvador | SV | 13.6929 | -89.2182 |
    | 353 | Tegucigalpa | Honduras | HN | 14.0723 | -87.1921 |
    | 354 | Managua | Nicaragua | NI | 12.1140 | -86.2362 |
    | 355 | Cali | Colombia | CO | 3.4516 | -76.5320 |
    | 356 | Barranquilla | Colombia | CO | 10.9685 | -74.7813 |
    | 357 | Cartagena | Colombia | CO | 10.3910 | -75.4794 |
    | 358 | Caracas | Venezuela | VE | 10.4806 | -66.9036 |
    | 359 | Guayaquil | Ecuador | EC | -2.1710 | -79.9224 |
    | 360 | Arequipa | Peru | PE | -16.4090 | -71.5375 |
    | 361 | La Paz | Bolivia | BO | -16.4897 | -68.1193 |
    | 362 | Asuncion | Paraguay | PY | -25.2637 | -57.5759 |
    | 363 | Valparaiso | Chile | CL | -33.0472 | -71.6127 |
    | 364 | Cordoba | Argentina | AR | -31.4201 | -64.1888 |
    | 365 | Rosario | Argentina | AR | -32.9442 | -60.6505 |
    | 366 | Mendoza | Argentina | AR | -32.8895 | -68.8458 |
    | 367 | Belo Horizonte | Brazil | BR | -19.9167 | -43.9345 |
    | 368 | Salvador | Brazil | BR | -12.9777 | -38.5016 |
    | 369 | Recife | Brazil | BR | -8.0476 | -34.8770 |
    | 370 | Fortaleza | Brazil | BR | -3.7319 | -38.5267 |
    | 371 | Manaus | Brazil | BR | -3.1190 | -60.0217 |
    | 372 | Florianopolis | Brazil | BR | -27.5954 | -48.5480 |
    | 373 | Gold Coast | Australia | AU | -28.0167 | 153.4000 |
    | 374 | Canberra | Australia | AU | -35.2809 | 149.1300 |
    | 375 | Hobart | Australia | AU | -42.8821 | 147.3272 |
    | 376 | Darwin | Australia | AU | -12.4634 | 130.8456 |
    | 377 | Dunedin | New Zealand | NZ | -45.8788 | 170.5028 |
    | 378 | Suva | Fiji | FJ | -18.1416 | 178.4419 |

## The map cache

A city's extract is downloaded from OpenStreetMap's Overpass API the first time
a seed needs it, then kept:

```text
data/maps/
├── dar-es-salaam_x5000.osm.xml            the extract (typically 5 to 50 MB)
└── dar-es-salaam_x5000.osm.manifest.json  where and when it came from, its SHA-256
```

| Situation | What happens |
|---|---|
| The city is cached | Used immediately, no network |
| Not cached, network available | Downloaded (20 to 60 s), validated, cached |
| Not cached, no network | The run fails with `MAP_FETCH_FAILED`, naming the city; no other city is substituted |
| A cached file is truncated | Deleted and downloaded again |

At start-up the server sweeps the cache: by default it keeps the newest
extract and removes older ones (`--map-cache prune`, `--map-cache-keep 1`;
the Docker image keeps 3). Interrupted downloads are always removed. Set
`--map-cache keep` to keep everything.

!!! warning "Why there is no fallback map"
    A seed means a place. Substituting another city when a download fails
    would make the same seed mean different worlds on different days. DSTNS
    fails loudly instead, and the CLI lists the maps you have, with the command
    to run one offline.

## Pinning a map

To run a specific map, offline or not, pin it:

```bash
./launcher start --osm-file data/maps/dar-es-salaam_x5000.osm.xml
./launcher start --osm-file data/fixtures/real_network.osm.xml   # bundled
```

With a pinned map the seed still chooses the district's root and every
simulated detail, but not the city. Any OpenStreetMap XML file works; export
one from [openstreetmap.org](https://www.openstreetmap.org/export) or Overpass.

!!! tip "Fetching a larger area"
    `./build/dstns_server --fetch-osm --bbox=S,W,N,E --output=data/maps/area.osm.xml`
    downloads any bounding box. Write `--bbox=` with an equals sign: a southern
    or western box starts with a minus sign.

## Saving and sharing configurations

A seed alone reproduces a world. A **saved seed** also records the day type,
duration, speed and modules under a name and, for a pinned map, keeps a verified
copy of the map file:

```bash
./launcher start --seed 382923 --day-type weekend --save-seed harbour-weekend \
                 --description "Weekend demo for the review"
./launcher seeds list
./launcher start --saved-seed harbour-weekend
```

Every command, what is stored and how replay is verified are described in
[Saved seeds](saved-seeds.md).

To share a run with someone, give them the seed and the day type. If you used a
pinned map, give them the file too, or copy your `data/seed-store/` directory.

## Reproducibility guarantees

The same seed, configuration, map bytes and DSTNS version produce the same
world and the same day, on any machine. Operator actions (overrides, toggles,
manual rain) are part of a run's history and change it from the moment they
are applied. The full contract, and how it is tested, is in
[Reproducibility](../concepts/reproducibility.md).
