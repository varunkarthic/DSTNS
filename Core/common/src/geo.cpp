// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/geo.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <numbers>

namespace dstns {
namespace {

// The seed's world catalogue.
//
// Centres of densely mapped urban areas, spread across every inhabited
// continent, so that consecutive seeds land in visibly different parts of the
// world rather than cycling through a handful of capitals. Coordinates are
// city centres; the extract is built around them.
//
// This list and its order are part of the "urban-crfg-v3" map selection: any
// change to either changes which city a seed resolves to.
const std::vector<City> kCities{
    {"London", "United Kingdom", 51.5074, -0.1278},
    {"Paris", "France", 48.8566, 2.3522},
    {"Berlin", "Germany", 52.5200, 13.4050},
    {"Madrid", "Spain", 40.4168, -3.7038},
    {"Barcelona", "Spain", 41.3874, 2.1686},
    {"Rome", "Italy", 41.9028, 12.4964},
    {"Milan", "Italy", 45.4642, 9.1900},
    {"Amsterdam", "Netherlands", 52.3676, 4.9041},
    {"Rotterdam", "Netherlands", 51.9244, 4.4777},
    {"Brussels", "Belgium", 50.8503, 4.3517},
    {"Vienna", "Austria", 48.2082, 16.3738},
    {"Prague", "Czechia", 50.0755, 14.4378},
    {"Budapest", "Hungary", 47.4979, 19.0402},
    {"Warsaw", "Poland", 52.2297, 21.0122},
    {"Krakow", "Poland", 50.0647, 19.9450},
    {"Copenhagen", "Denmark", 55.6761, 12.5683},
    {"Stockholm", "Sweden", 59.3293, 18.0686},
    {"Oslo", "Norway", 59.9139, 10.7522},
    {"Helsinki", "Finland", 60.1699, 24.9384},
    {"Dublin", "Ireland", 53.3498, -6.2603},
    {"Edinburgh", "United Kingdom", 55.9533, -3.1883},
    {"Manchester", "United Kingdom", 53.4808, -2.2426},
    {"Birmingham", "United Kingdom", 52.4862, -1.8904},
    {"Glasgow", "United Kingdom", 55.8642, -4.2518},
    {"Lisbon", "Portugal", 38.7223, -9.1393},
    {"Porto", "Portugal", 41.1579, -8.6291},
    {"Zurich", "Switzerland", 47.3769, 8.5417},
    {"Geneva", "Switzerland", 46.2044, 6.1432},
    {"Munich", "Germany", 48.1351, 11.5820},
    {"Hamburg", "Germany", 53.5511, 9.9937},
    {"Frankfurt", "Germany", 50.1109, 8.6821},
    {"Cologne", "Germany", 50.9375, 6.9603},
    {"Stuttgart", "Germany", 48.7758, 9.1829},
    {"Lyon", "France", 45.7640, 4.8357},
    {"Marseille", "France", 43.2965, 5.3698},
    {"Toulouse", "France", 43.6047, 1.4442},
    {"Naples", "Italy", 40.8518, 14.2681},
    {"Turin", "Italy", 45.0703, 7.6869},
    {"Florence", "Italy", 43.7696, 11.2558},
    {"Athens", "Greece", 37.9838, 23.7275},
    {"Bucharest", "Romania", 44.4268, 26.1025},
    {"Sofia", "Bulgaria", 42.6977, 23.3219},
    {"Belgrade", "Serbia", 44.7866, 20.4489},
    {"Zagreb", "Croatia", 45.8150, 15.9819},
    {"Ljubljana", "Slovenia", 46.0569, 14.5058},
    {"Bratislava", "Slovakia", 48.1486, 17.1077},
    {"Vilnius", "Lithuania", 54.6872, 25.2797},
    {"Riga", "Latvia", 56.9496, 24.1052},
    {"Tallinn", "Estonia", 59.4370, 24.7536},
    {"Valencia", "Spain", 39.4699, -0.3763},
    {"Seville", "Spain", 37.3891, -5.9845},
    {"Bilbao", "Spain", 43.2630, -2.9350},
    {"Antwerp", "Belgium", 51.2194, 4.4025},
    {"Gothenburg", "Sweden", 57.7089, 11.9746},
    {"Istanbul", "Turkey", 41.0082, 28.9784},
    {"Ankara", "Turkey", 39.9334, 32.8597},
    {"Izmir", "Turkey", 38.4237, 27.1428},
    {"Tokyo", "Japan", 35.6762, 139.6503},
    {"Osaka", "Japan", 34.6937, 135.5023},
    {"Yokohama", "Japan", 35.4437, 139.6380},
    {"Nagoya", "Japan", 35.1815, 136.9066},
    {"Fukuoka", "Japan", 33.5904, 130.4017},
    {"Sapporo", "Japan", 43.0618, 141.3545},
    {"Seoul", "South Korea", 37.5665, 126.9780},
    {"Busan", "South Korea", 35.1796, 129.0756},
    {"Incheon", "South Korea", 37.4563, 126.7052},
    {"Taipei", "Taiwan", 25.0330, 121.5654},
    {"Kaohsiung", "Taiwan", 22.6273, 120.3014},
    {"Hong Kong", "China", 22.3193, 114.1694},
    {"Singapore", "Singapore", 1.3521, 103.8198},
    {"Kuala Lumpur", "Malaysia", 3.1390, 101.6869},
    {"Bangkok", "Thailand", 13.7563, 100.5018},
    {"Ho Chi Minh City", "Vietnam", 10.7769, 106.7009},
    {"Hanoi", "Vietnam", 21.0278, 105.8342},
    {"Jakarta", "Indonesia", -6.2088, 106.8456},
    {"Manila", "Philippines", 14.5995, 120.9842},
    {"Shanghai", "China", 31.2304, 121.4737},
    {"Beijing", "China", 39.9042, 116.4074},
    {"Shenzhen", "China", 22.5431, 114.0579},
    {"Guangzhou", "China", 23.1291, 113.2644},
    {"Chengdu", "China", 30.5728, 104.0668},
    {"Hangzhou", "China", 30.2741, 120.1551},
    {"Mumbai", "India", 19.0760, 72.8777},
    {"Delhi", "India", 28.6139, 77.2090},
    {"Bengaluru", "India", 12.9716, 77.5946},
    {"Chennai", "India", 13.0827, 80.2707},
    {"Hyderabad", "India", 17.3850, 78.4867},
    {"Kolkata", "India", 22.5726, 88.3639},
    {"Pune", "India", 18.5204, 73.8567},
    {"Ahmedabad", "India", 23.0225, 72.5714},
    {"Jaipur", "India", 26.9124, 75.7873},
    {"Karachi", "Pakistan", 24.8607, 67.0011},
    {"Lahore", "Pakistan", 31.5204, 74.3587},
    {"Dhaka", "Bangladesh", 23.8103, 90.4125},
    {"Colombo", "Sri Lanka", 6.9271, 79.8612},
    {"Kathmandu", "Nepal", 27.7172, 85.3240},
    {"Tel Aviv", "Israel", 32.0853, 34.7818},
    {"Dubai", "United Arab Emirates", 25.2048, 55.2708},
    {"Abu Dhabi", "United Arab Emirates", 24.4539, 54.3773},
    {"Doha", "Qatar", 25.2854, 51.5310},
    {"Riyadh", "Saudi Arabia", 24.7136, 46.6753},
    {"Jeddah", "Saudi Arabia", 21.4858, 39.1925},
    {"Kuwait City", "Kuwait", 29.3759, 47.9774},
    {"Amman", "Jordan", 31.9454, 35.9284},
    {"Baku", "Azerbaijan", 40.4093, 49.8671},
    {"Tbilisi", "Georgia", 41.7151, 44.8271},
    {"Yerevan", "Armenia", 40.1792, 44.4991},
    {"Tashkent", "Uzbekistan", 41.2995, 69.2401},
    {"Almaty", "Kazakhstan", 43.2220, 76.8512},
    {"Cairo", "Egypt", 30.0444, 31.2357},
    {"Alexandria", "Egypt", 31.2001, 29.9187},
    {"Casablanca", "Morocco", 33.5731, -7.5898},
    {"Rabat", "Morocco", 34.0209, -6.8416},
    {"Tunis", "Tunisia", 36.8065, 10.1815},
    {"Algiers", "Algeria", 36.7538, 3.0588},
    {"Lagos", "Nigeria", 6.5244, 3.3792},
    {"Abuja", "Nigeria", 9.0765, 7.3986},
    {"Accra", "Ghana", 5.6037, -0.1870},
    {"Nairobi", "Kenya", -1.2921, 36.8219},
    {"Addis Ababa", "Ethiopia", 9.0320, 38.7469},
    {"Dar es Salaam", "Tanzania", -6.7924, 39.2083},
    {"Kampala", "Uganda", 0.3476, 32.5825},
    {"Johannesburg", "South Africa", -26.2041, 28.0473},
    {"Cape Town", "South Africa", -33.9249, 18.4241},
    {"Durban", "South Africa", -29.8587, 31.0218},
    {"Pretoria", "South Africa", -25.7479, 28.2293},
    {"New York", "United States", 40.7128, -74.0060},
    {"Chicago", "United States", 41.8781, -87.6298},
    {"Los Angeles", "United States", 34.0522, -118.2437},
    {"San Francisco", "United States", 37.7749, -122.4194},
    {"Seattle", "United States", 47.6062, -122.3321},
    {"Boston", "United States", 42.3601, -71.0589},
    {"Philadelphia", "United States", 39.9526, -75.1652},
    {"Washington", "United States", 38.9072, -77.0369},
    {"Atlanta", "United States", 33.7490, -84.3880},
    {"Miami", "United States", 25.7617, -80.1918},
    {"Houston", "United States", 29.7604, -95.3698},
    {"Dallas", "United States", 32.7767, -96.7970},
    {"Austin", "United States", 30.2672, -97.7431},
    {"Denver", "United States", 39.7392, -104.9903},
    {"Portland", "United States", 45.5152, -122.6784},
    {"Minneapolis", "United States", 44.9778, -93.2650},
    {"Detroit", "United States", 42.3314, -83.0458},
    {"Pittsburgh", "United States", 40.4406, -79.9959},
    {"San Diego", "United States", 32.7157, -117.1611},
    {"Phoenix", "United States", 33.4484, -112.0740},
    {"Las Vegas", "United States", 36.1699, -115.1398},
    {"New Orleans", "United States", 29.9511, -90.0715},
    {"Toronto", "Canada", 43.6532, -79.3832},
    {"Montreal", "Canada", 45.5019, -73.5674},
    {"Vancouver", "Canada", 49.2827, -123.1207},
    {"Ottawa", "Canada", 45.4215, -75.6972},
    {"Calgary", "Canada", 51.0447, -114.0719},
    {"Mexico City", "Mexico", 19.4326, -99.1332},
    {"Guadalajara", "Mexico", 20.6597, -103.3496},
    {"Monterrey", "Mexico", 25.6866, -100.3161},
    {"Panama City", "Panama", 8.9824, -79.5199},
    {"San Jose", "Costa Rica", 9.9281, -84.0907},
    {"Havana", "Cuba", 23.1136, -82.3666},
    {"Santo Domingo", "Dominican Republic", 18.4861, -69.9312},
    {"Guatemala City", "Guatemala", 14.6349, -90.5069},
    {"Bogota", "Colombia", 4.7110, -74.0721},
    {"Medellin", "Colombia", 6.2442, -75.5812},
    {"Lima", "Peru", -12.0464, -77.0428},
    {"Santiago", "Chile", -33.4489, -70.6693},
    {"Buenos Aires", "Argentina", -34.6037, -58.3816},
    {"Sao Paulo", "Brazil", -23.5505, -46.6333},
    {"Rio de Janeiro", "Brazil", -22.9068, -43.1729},
    {"Brasilia", "Brazil", -15.7939, -47.8828},
    {"Curitiba", "Brazil", -25.4284, -49.2733},
    {"Porto Alegre", "Brazil", -30.0346, -51.2177},
    {"Montevideo", "Uruguay", -34.9011, -56.1645},
    {"Quito", "Ecuador", -0.1807, -78.4678},
    {"Sydney", "Australia", -33.8688, 151.2093},
    {"Melbourne", "Australia", -37.8136, 144.9631},
    {"Brisbane", "Australia", -27.4698, 153.0251},
    {"Perth", "Australia", -31.9505, 115.8605},
    {"Adelaide", "Australia", -34.9285, 138.6007},
    {"Auckland", "New Zealand", -36.8485, 174.7633},
    {"Wellington", "New Zealand", -41.2866, 174.7756},
    {"Christchurch", "New Zealand", -43.5321, 172.6362},
};

// More cities, for urban-geo-v2 only: appended after kCities, so urban-crfg-v3 and urban-geo-v1 keep their catalogue
// and every seed they have chosen keeps its city. Add to the end of this list only, under a new policy version.
const std::vector<City> kMoreCities{
    {"Kochi", "India", 9.9312, 76.2673},
    {"Coimbatore", "India", 11.0168, 76.9558},
    {"Lucknow", "India", 26.8467, 80.9462},
    {"Chandigarh", "India", 30.7333, 76.7794},
    {"Indore", "India", 22.7196, 75.8577},
    {"Surat", "India", 21.1702, 72.8311},
    {"Nagpur", "India", 21.1458, 79.0882},
    {"Visakhapatnam", "India", 17.6868, 83.2185},
    {"Thiruvananthapuram", "India", 8.5241, 76.9366},
    {"Mysuru", "India", 12.2958, 76.6394},
    {"Madurai", "India", 9.9252, 78.1198},
    {"Bhopal", "India", 23.2599, 77.4126},
    {"Bhubaneswar", "India", 20.2961, 85.8245},
    {"Guwahati", "India", 26.1445, 91.7362},
    {"Patna", "India", 25.5941, 85.1376},
    {"Vadodara", "India", 22.3072, 73.1812},
    {"Panaji", "India", 15.4909, 73.8278},
    {"Mangaluru", "India", 12.9141, 74.8560},
    {"Vijayawada", "India", 16.5062, 80.6480},
    {"Noida", "India", 28.5355, 77.3910},
    {"Gurugram", "India", 28.4595, 77.0266},
    {"Kanpur", "India", 26.4499, 80.3319},
    {"Ludhiana", "India", 30.9010, 75.8573},
    {"Amritsar", "India", 31.6340, 74.8723},
    {"Varanasi", "India", 25.3176, 82.9739},
    {"Navi Mumbai", "India", 19.0330, 73.0297},
    {"Thane", "India", 19.2183, 72.9781},
    {"Bristol", "United Kingdom", 51.4545, -2.5879},
    {"Leeds", "United Kingdom", 53.8008, -1.5491},
    {"Liverpool", "United Kingdom", 53.4084, -2.9916},
    {"Newcastle", "United Kingdom", 54.9783, -1.6178},
    {"Belfast", "United Kingdom", 54.5973, -5.9301},
    {"Cardiff", "United Kingdom", 51.4816, -3.1791},
    {"Nice", "France", 43.7102, 7.2620},
    {"Bordeaux", "France", 44.8378, -0.5792},
    {"Lille", "France", 50.6292, 3.0573},
    {"Nantes", "France", 47.2184, -1.5536},
    {"Strasbourg", "France", 48.5734, 7.7521},
    {"Dusseldorf", "Germany", 51.2277, 6.7735},
    {"Leipzig", "Germany", 51.3397, 12.3731},
    {"Dresden", "Germany", 51.0504, 13.7373},
    {"Hanover", "Germany", 52.3759, 9.7320},
    {"Nuremberg", "Germany", 49.4521, 11.0767},
    {"Bologna", "Italy", 44.4949, 11.3426},
    {"Genoa", "Italy", 44.4056, 8.9463},
    {"Venice", "Italy", 45.4408, 12.3155},
    {"Palermo", "Italy", 38.1157, 13.3615},
    {"Malaga", "Spain", 36.7213, -4.4214},
    {"Zaragoza", "Spain", 41.6488, -0.8891},
    {"The Hague", "Netherlands", 52.0705, 4.3007},
    {"Utrecht", "Netherlands", 52.0907, 5.1214},
    {"Eindhoven", "Netherlands", 51.4416, 5.4697},
    {"Ghent", "Belgium", 51.0543, 3.7174},
    {"Luxembourg", "Luxembourg", 49.6116, 6.1319},
    {"Basel", "Switzerland", 47.5596, 7.5886},
    {"Bern", "Switzerland", 46.9480, 7.4474},
    {"Salzburg", "Austria", 47.8095, 13.0550},
    {"Graz", "Austria", 47.0707, 15.4395},
    {"Brno", "Czechia", 49.1951, 16.6068},
    {"Gdansk", "Poland", 54.3520, 18.6466},
    {"Wroclaw", "Poland", 51.1079, 17.0385},
    {"Poznan", "Poland", 52.4064, 16.9252},
    {"Lodz", "Poland", 51.7592, 19.4560},
    {"Malmo", "Sweden", 55.6050, 13.0038},
    {"Aarhus", "Denmark", 56.1629, 10.2039},
    {"Bergen", "Norway", 60.3913, 5.3221},
    {"Tampere", "Finland", 61.4978, 23.7610},
    {"Reykjavik", "Iceland", 64.1466, -21.9426},
    {"Thessaloniki", "Greece", 40.6401, 22.9444},
    {"Cluj-Napoca", "Romania", 46.7712, 23.6236},
    {"Kyiv", "Ukraine", 50.4501, 30.5234},
    {"Lviv", "Ukraine", 49.8397, 24.0297},
    {"Chisinau", "Moldova", 47.0105, 28.8638},
    {"Sarajevo", "Bosnia and Herzegovina", 43.8563, 18.4131},
    {"Skopje", "North Macedonia", 41.9981, 21.4254},
    {"Tirana", "Albania", 41.3275, 19.8187},
    {"Valletta", "Malta", 35.8989, 14.5146},
    {"Nicosia", "Cyprus", 35.1856, 33.3823},
    {"Cork", "Ireland", 51.8985, -8.4756},
    {"Minsk", "Belarus", 53.9006, 27.5590},
    {"Moscow", "Russia", 55.7558, 37.6173},
    {"Saint Petersburg", "Russia", 59.9311, 30.3609},
    {"Antalya", "Turkey", 36.8969, 30.7133},
    {"Bursa", "Turkey", 40.1826, 29.0665},
    {"Kyoto", "Japan", 35.0116, 135.7681},
    {"Kobe", "Japan", 34.6901, 135.1955},
    {"Hiroshima", "Japan", 34.3853, 132.4553},
    {"Sendai", "Japan", 38.2682, 140.8694},
    {"Daegu", "South Korea", 35.8714, 128.6014},
    {"Daejeon", "South Korea", 36.3504, 127.3845},
    {"Taichung", "Taiwan", 24.1477, 120.6736},
    {"Macau", "China", 22.1987, 113.5439},
    {"Wuhan", "China", 30.5928, 114.3055},
    {"Xian", "China", 34.3416, 108.9398},
    {"Nanjing", "China", 32.0603, 118.7969},
    {"Chongqing", "China", 29.5630, 106.5516},
    {"Tianjin", "China", 39.3434, 117.3616},
    {"Suzhou", "China", 31.2989, 120.5853},
    {"Qingdao", "China", 36.0671, 120.3826},
    {"Ulaanbaatar", "Mongolia", 47.8864, 106.9057},
    {"Phnom Penh", "Cambodia", 11.5564, 104.9282},
    {"Vientiane", "Laos", 17.9757, 102.6331},
    {"Yangon", "Myanmar", 16.8409, 96.1735},
    {"Chiang Mai", "Thailand", 18.7883, 98.9853},
    {"Da Nang", "Vietnam", 16.0544, 108.2022},
    {"George Town", "Malaysia", 5.4141, 100.3288},
    {"Johor Bahru", "Malaysia", 1.4927, 103.7414},
    {"Surabaya", "Indonesia", -7.2575, 112.7521},
    {"Bandung", "Indonesia", -6.9175, 107.6191},
    {"Denpasar", "Indonesia", -8.6705, 115.2126},
    {"Cebu City", "Philippines", 10.3157, 123.8854},
    {"Davao City", "Philippines", 7.1907, 125.4553},
    {"Islamabad", "Pakistan", 33.6844, 73.0479},
    {"Chittagong", "Bangladesh", 22.3569, 91.7832},
    {"Tehran", "Iran", 35.6892, 51.3890},
    {"Isfahan", "Iran", 32.6546, 51.6680},
    {"Baghdad", "Iraq", 33.3152, 44.3661},
    {"Beirut", "Lebanon", 33.8938, 35.5018},
    {"Haifa", "Israel", 32.7940, 34.9896},
    {"Muscat", "Oman", 23.5880, 58.3829},
    {"Manama", "Bahrain", 26.2285, 50.5860},
    {"Bishkek", "Kyrgyzstan", 42.8746, 74.5698},
    {"Astana", "Kazakhstan", 51.1694, 71.4491},
    {"Dakar", "Senegal", 14.7167, -17.4677},
    {"Abidjan", "Ivory Coast", 5.3600, -4.0083},
    {"Kinshasa", "DR Congo", -4.4419, 15.2663},
    {"Luanda", "Angola", -8.8390, 13.2894},
    {"Kigali", "Rwanda", -1.9441, 30.0619},
    {"Lusaka", "Zambia", -15.3875, 28.3228},
    {"Harare", "Zimbabwe", -17.8252, 31.0335},
    {"Maputo", "Mozambique", -25.9692, 32.5732},
    {"Windhoek", "Namibia", -22.5609, 17.0658},
    {"Gaborone", "Botswana", -24.6282, 25.9231},
    {"Antananarivo", "Madagascar", -18.8792, 47.5079},
    {"Mombasa", "Kenya", -4.0435, 39.6682},
    {"Marrakesh", "Morocco", 31.6295, -7.9811},
    {"Tangier", "Morocco", 35.7595, -5.8340},
    {"Port Louis", "Mauritius", -20.1609, 57.5012},
    {"Kano", "Nigeria", 12.0022, 8.5920},
    {"Ibadan", "Nigeria", 7.3775, 3.9470},
    {"Kumasi", "Ghana", 6.6885, -1.6244},
    {"Douala", "Cameroon", 4.0511, 9.7679},
    {"Gqeberha", "South Africa", -33.9608, 25.6022},
    {"San Antonio", "United States", 29.4241, -98.4936},
    {"Nashville", "United States", 36.1627, -86.7816},
    {"Charlotte", "United States", 35.2271, -80.8431},
    {"Baltimore", "United States", 39.2904, -76.6122},
    {"Salt Lake City", "United States", 40.7608, -111.8910},
    {"Sacramento", "United States", 38.5816, -121.4944},
    {"Columbus", "United States", 39.9612, -82.9988},
    {"Indianapolis", "United States", 39.7684, -86.1581},
    {"Kansas City", "United States", 39.0997, -94.5786},
    {"St Louis", "United States", 38.6270, -90.1994},
    {"Cleveland", "United States", 41.4993, -81.6944},
    {"Cincinnati", "United States", 39.1031, -84.5120},
    {"Milwaukee", "United States", 43.0389, -87.9065},
    {"Tampa", "United States", 27.9506, -82.4572},
    {"Orlando", "United States", 28.5383, -81.3792},
    {"Raleigh", "United States", 35.7796, -78.6382},
    {"Honolulu", "United States", 21.3099, -157.8581},
    {"Anchorage", "United States", 61.2181, -149.9003},
    {"Edmonton", "Canada", 53.5461, -113.4938},
    {"Winnipeg", "Canada", 49.8951, -97.1384},
    {"Quebec City", "Canada", 46.8139, -71.2080},
    {"Halifax", "Canada", 44.6488, -63.5752},
    {"Puebla", "Mexico", 19.0414, -98.2063},
    {"Tijuana", "Mexico", 32.5149, -117.0382},
    {"Merida", "Mexico", 20.9674, -89.5926},
    {"Cancun", "Mexico", 21.1619, -86.8515},
    {"San Juan", "Puerto Rico", 18.4655, -66.1057},
    {"Kingston", "Jamaica", 17.9714, -76.7920},
    {"San Salvador", "El Salvador", 13.6929, -89.2182},
    {"Tegucigalpa", "Honduras", 14.0723, -87.1921},
    {"Managua", "Nicaragua", 12.1140, -86.2362},
    {"Cali", "Colombia", 3.4516, -76.5320},
    {"Barranquilla", "Colombia", 10.9685, -74.7813},
    {"Cartagena", "Colombia", 10.3910, -75.4794},
    {"Caracas", "Venezuela", 10.4806, -66.9036},
    {"Guayaquil", "Ecuador", -2.1710, -79.9224},
    {"Arequipa", "Peru", -16.4090, -71.5375},
    {"La Paz", "Bolivia", -16.4897, -68.1193},
    {"Asuncion", "Paraguay", -25.2637, -57.5759},
    {"Valparaiso", "Chile", -33.0472, -71.6127},
    {"Cordoba", "Argentina", -31.4201, -64.1888},
    {"Rosario", "Argentina", -32.9442, -60.6505},
    {"Mendoza", "Argentina", -32.8895, -68.8458},
    {"Belo Horizonte", "Brazil", -19.9167, -43.9345},
    {"Salvador", "Brazil", -12.9777, -38.5016},
    {"Recife", "Brazil", -8.0476, -34.8770},
    {"Fortaleza", "Brazil", -3.7319, -38.5267},
    {"Manaus", "Brazil", -3.1190, -60.0217},
    {"Florianopolis", "Brazil", -27.5954, -48.5480},
    {"Gold Coast", "Australia", -28.0167, 153.4000},
    {"Canberra", "Australia", -35.2809, 149.1300},
    {"Hobart", "Australia", -42.8821, 147.3272},
    {"Darwin", "Australia", -12.4634, 130.8456},
    {"Dunedin", "New Zealand", -45.8788, 170.5028},
    {"Suva", "Fiji", -18.1416, 178.4419},
};

std::string fixed6(double value) {
    char buffer[32];
    std::snprintf(buffer, sizeof buffer, "%.6f", value);
    return buffer;
}

} // namespace

std::string City::slug() const {
    std::string out;
    for (const char c : name) {
        if (c == ' ') out.push_back('-');
        else if (std::isalnum(static_cast<unsigned char>(c)))
            out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return out;
}

const std::vector<City>& city_catalog() { return kCities; }

const std::vector<City>& world_catalog() {
    static const auto all = [] {
        auto out = kCities;
        out.insert(out.end(), kMoreCities.begin(), kMoreCities.end());
        return out;
    }();
    return all;
}

double metres_per_degree_lon(double latitude) {
    // Guard the poles so a degenerate cosine can never scale a span to zero.
    return kMetresPerDegreeLat * std::max(0.01, std::cos(latitude * std::numbers::pi / 180.0));
}

// The extract is a square of extent_m centred on the city, so its bounds depend
// only on the city and the extent. Every district of that city reads the same
// file.
double MapLocation::min_lat() const { return centre_lat - extent_m / 2 / kMetresPerDegreeLat; }
double MapLocation::max_lat() const { return centre_lat + extent_m / 2 / kMetresPerDegreeLat; }
double MapLocation::min_lon() const { return centre_lon - extent_m / 2 / metres_per_degree_lon(centre_lat); }
double MapLocation::max_lon() const { return centre_lon + extent_m / 2 / metres_per_degree_lon(centre_lat); }

std::string MapLocation::bbox() const {
    return fixed6(min_lat()) + "," + fixed6(min_lon()) + "," + fixed6(max_lat()) + "," + fixed6(max_lon());
}

std::string MapLocation::cache_key() const {
    std::string slug;
    for (const char c : city) {
        if (c == ' ') slug.push_back('-');
        else if (std::isalnum(static_cast<unsigned char>(c)))
            slug.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return slug + "_x" + std::to_string(static_cast<long long>(std::llround(extent_m)));
}

std::filesystem::path MapLocation::cache_path(const std::filesystem::path& directory) const {
    return directory / (cache_key() + ".osm.xml");
}

MapLocation select_map_location(Seed128 seed, double extent_m) {
    if (!(extent_m >= 500.0) || extent_m > 20000.0) {
        throw std::invalid_argument("city extract extent must be in [500, 20000] metres");
    }
    const DeterministicRng city_rng{seed.derive("map.city")};
    const auto& city = kCities.at(city_rng.bounded({RngDomain::MapSelection, 0, 0, 0},
                                                   static_cast<std::uint32_t>(kCities.size())));

    MapLocation location;
    location.city = city.name;
    location.country = city.country;
    location.extent_m = extent_m;
    location.centre_lat = city.centre_lat();
    location.centre_lon = city.centre_lon();

    // The anchor ranges over the extract, inset by a quarter so a district grown
    // around it stays largely inside the downloaded area instead of running off
    // the edge. Different seeds for one city therefore pick genuinely different
    // districts of the same file.
    const DeterministicRng anchor_rng{seed.derive("map.anchor")};
    const double lat_span = (location.max_lat() - location.min_lat()) * 0.5;
    const double lon_span = (location.max_lon() - location.min_lon()) * 0.5;
    location.anchor_lat = location.centre_lat - lat_span / 2
        + lat_span * anchor_rng.uniform01({RngDomain::MapSelection, 0, 1, 0});
    location.anchor_lon = location.centre_lon - lon_span / 2
        + lon_span * anchor_rng.uniform01({RngDomain::MapSelection, 0, 2, 0});
    return location;
}

} // namespace dstns
