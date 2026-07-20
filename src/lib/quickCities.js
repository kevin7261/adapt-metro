// 「快速選擇」常用城市清單——加入 modal（DialogHost）與視圖畫廊（GalleryShell）
// 的「快速選擇」tab 共用同一份，避免兩邊各存一份而走樣。
// 城市順序不變；同城市的變體（＋山手／＋環狀／＋地標）緊接 base 放一起。
// en 需與 data/metro/index.json 的 system.city 對得上（精確比對優先，其次前綴容錯，
// 例如 index 的 "New York City" vs 顯示名 "New York"）。
export const QUICK_CITIES = [
  { zh: '台北', en: 'Taipei' }, { zh: '台北＋地標', en: 'Taipei + Landmark' },
  { zh: '台中', en: 'Taichung' }, { zh: '高雄', en: 'Kaohsiung' },
  { zh: '東京', en: 'Tokyo' }, { zh: '東京＋山手', en: 'Tokyo + Yamanote' }, { zh: '東京＋地標', en: 'Tokyo + Landmark' },
  { zh: '大阪', en: 'Osaka' }, { zh: '大阪＋環狀', en: 'Osaka + Loop' },
  { zh: '首爾', en: 'Seoul' }, { zh: '首爾＋地標', en: 'Seoul + Landmark' },
  { zh: '北京', en: 'Beijing' },
  { zh: '上海', en: 'Shanghai' }, { zh: '上海＋地標', en: 'Shanghai + Landmark' },
  { zh: '香港', en: 'Hong Kong' }, { zh: '新加坡', en: 'Singapore' },
  { zh: '倫敦', en: 'London' }, { zh: '倫敦＋地標', en: 'London + Landmark' },
  { zh: '巴黎', en: 'Paris' }, { zh: '巴黎＋地標', en: 'Paris + Landmark' },
  { zh: '柏林', en: 'Berlin' }, { zh: '柏林＋地標', en: 'Berlin + Landmark' },
  { zh: '慕尼黑', en: 'Munich' },
  { zh: '莫斯科', en: 'Moscow' },
  { zh: '維也納', en: 'Vienna' }, { zh: '維也納＋地標', en: 'Vienna + Landmark' },
  { zh: '紐約', en: 'New York' }, { zh: '紐約＋地標', en: 'New York City + Landmark' },
  { zh: '波士頓', en: 'Boston' },
  { zh: '洛杉磯', en: 'Los Angeles' },
  { zh: '雪梨', en: 'Sydney' }, { zh: '墨西哥城', en: 'Mexico City' },
  { zh: '舊金山', en: 'San Francisco' },
]

// catalog 的 system 依 QUICK_CITIES 的 en 比對（精確優先、其次前綴容錯）。
export const matchQuickSystem = (systems, en) =>
  systems.find((s) => s.city === en)
  ?? systems.find((s) => (s.city || '').toLowerCase().startsWith(en.toLowerCase()))
  ?? null
