// The set of NATIONAL railway networks to fetch, ONE geojson per country
// (使用者: 一國家一檔). See skill railway-osm-fetch — railway is the metro/highway
// counterpart at COUNTRY scope (national/state railways + high-speed rail; NOT
// metro/subway, NOT tram/light_rail). Private railways are excluded by the
// OSM heuristic (route=train, mainline) plus an optional per-country operator
// exclusion list (Japan 私鉄) read from data/railway/_overrides/{cc}_exclude.json.
//
// Each entry: { name, name_zh, iso2 }. continent (→ continent code) comes from
// CONTINENT[iso2]; the 3-letter path code from iocCode(name); together they make
// cc = `{continentCode}-{iocCode}` (as-twn / as-jpn / eu-fra / am-usa …), the file
// stem, exactly like highway. name / name_zh drive the 中文＋English menu labels.
import { CONTINENT } from './continents.mjs'
import { continentCode, iocCode } from './countryCodes.mjs'

export const COUNTRIES = [
  // ── East Asia (使用者先抓: 台灣 日本 中國 韓國) ──────────────────────────
  { name: 'Taiwan', name_zh: '台灣', iso2: 'TW' },        // 台鐵 TRA + 台灣高鐵 THSR
  { name: 'Japan', name_zh: '日本', iso2: 'JP' },         // JR 各社 + 新幹線 (私鉄 excluded)
  { name: 'China', name_zh: '中國', iso2: 'CN' },         // 国铁集团 + 高铁/动车
  { name: 'South Korea', name_zh: '韓國', iso2: 'KR' },   // Korail + SR (SRT/KTX)
  // ── Europe (使用者: 歐洲各國) ────────────────────────────────────────────
  { name: 'France', name_zh: '法國', iso2: 'FR' },        // SNCF + TGV
  { name: 'Germany', name_zh: '德國', iso2: 'DE' },       // DB + ICE
  { name: 'United Kingdom', name_zh: '英國', iso2: 'GB' },
  { name: 'Italy', name_zh: '義大利', iso2: 'IT' },       // Trenitalia + Frecce, Italo
  { name: 'Spain', name_zh: '西班牙', iso2: 'ES' },       // Renfe + AVE
  { name: 'Switzerland', name_zh: '瑞士', iso2: 'CH' },   // SBB/CFF/FFS
  { name: 'Netherlands', name_zh: '荷蘭', iso2: 'NL' },   // NS
  { name: 'Belgium', name_zh: '比利時', iso2: 'BE' },     // SNCB/NMBS
  { name: 'Austria', name_zh: '奧地利', iso2: 'AT' },     // ÖBB + Railjet
  { name: 'Sweden', name_zh: '瑞典', iso2: 'SE' },        // SJ
  { name: 'Norway', name_zh: '挪威', iso2: 'NO' },        // Vy
  { name: 'Denmark', name_zh: '丹麥', iso2: 'DK' },       // DSB
  { name: 'Finland', name_zh: '芬蘭', iso2: 'FI' },       // VR
  { name: 'Poland', name_zh: '波蘭', iso2: 'PL' },        // PKP
  { name: 'Czechia', name_zh: '捷克', iso2: 'CZ' },       // ČD
  { name: 'Portugal', name_zh: '葡萄牙', iso2: 'PT' },    // CP
  { name: 'Ireland', name_zh: '愛爾蘭', iso2: 'IE' },     // Iarnród Éireann
  { name: 'Hungary', name_zh: '匈牙利', iso2: 'HU' },     // MÁV
  { name: 'Romania', name_zh: '羅馬尼亞', iso2: 'RO' },   // CFR
  { name: 'Greece', name_zh: '希臘', iso2: 'GR' },        // Hellenic Train
  { name: 'Slovakia', name_zh: '斯洛伐克', iso2: 'SK' },  // ZSSK
  { name: 'Slovenia', name_zh: '斯洛維尼亞', iso2: 'SI' },// SŽ
  { name: 'Croatia', name_zh: '克羅埃西亞', iso2: 'HR' }, // HŽ
  { name: 'Luxembourg', name_zh: '盧森堡', iso2: 'LU' },  // CFL
  { name: 'Bulgaria', name_zh: '保加利亞', iso2: 'BG' },  // BDŽ
  // ── North America (使用者: 美國 加拿大) ─────────────────────────────────
  { name: 'United States', name_zh: '美國', iso2: 'US' }, // Amtrak (intercity national rail)
  { name: 'Canada', name_zh: '加拿大', iso2: 'CA' },      // VIA Rail
]

// Enrich each entry with continent + path codes (cc = {continentCode}-{iocCode}).
export function countryList() {
  return COUNTRIES.map((c) => {
    const continent = CONTINENT[c.iso2] || 'other'
    const cc = `${continentCode(continent)}-${iocCode(c.name)}`
    return { ...c, continent, cc }
  })
}
