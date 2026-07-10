// File-naming codes (see metro-osm-fetch skill):
//   continent -> 2-letter code, country -> IOC 3-letter code (Olympic codes:
//   Taiwan=TPE, Germany=GER, Netherlands=NED, ... lowercased in paths).
// Countries missing here fall back to a slug of the name — add the IOC code
// and rebuild when that happens.

export const CONTINENT_CODE = {
  africa: 'af',
  asia: 'as',
  europe: 'eu',
  // 北美＋南美合併為美洲 am（使用者指定）
  'north-america': 'am',
  'south-america': 'am',
  oceania: 'oc',
}

const IOC = {
  algeria: 'ALG', argentina: 'ARG', armenia: 'ARM', australia: 'AUS',
  austria: 'AUT', azerbaijan: 'AZE', bangladesh: 'BAN', belarus: 'BLR',
  belgium: 'BEL', brazil: 'BRA', bulgaria: 'BUL', canada: 'CAN',
  chile: 'CHI', china: 'CHN', colombia: 'COL',
  czechia: 'CZE', czechrepublic: 'CZE',
  denmark: 'DEN', dominicanrepublic: 'DOM', ecuador: 'ECU', egypt: 'EGY',
  finland: 'FIN', france: 'FRA', georgia: 'GEO', germany: 'GER',
  greece: 'GRE', hungary: 'HUN', india: 'IND', indonesia: 'INA',
  iran: 'IRI', italy: 'ITA', japan: 'JPN', kazakhstan: 'KAZ',
  malaysia: 'MAS', mexico: 'MEX', netherlands: 'NED', nigeria: 'NGR',
  northkorea: 'PRK', norway: 'NOR', pakistan: 'PAK', panama: 'PAN',
  peru: 'PER', philippines: 'PHI', poland: 'POL', portugal: 'POR',
  qatar: 'QAT', romania: 'ROU', russia: 'RUS', russianfederation: 'RUS',
  saudiarabia: 'KSA', singapore: 'SGP', southkorea: 'KOR',
  republicofkorea: 'KOR', spain: 'ESP', sweden: 'SWE', switzerland: 'SUI',
  // 台灣用 ISO 3166 的 TWN（使用者指定），不用 IOC 的 TPE
  taiwan: 'TWN', thailand: 'THA', turkey: 'TUR', turkiye: 'TUR',
  ukraine: 'UKR', unitedarabemirates: 'UAE', unitedkingdom: 'GBR',
  unitedstates: 'USA', unitedstatesofamerica: 'USA', uzbekistan: 'UZB',
  venezuela: 'VEN', vietnam: 'VIE',
  // occasionally reverse-geocoded variants
  hongkong: 'HKG', macau: 'MAC', macao: 'MAC', northmacedonia: 'MKD',
  serbia: 'SRB', israel: 'ISR', morocco: 'MAR', tunisia: 'TUN',
  puertorico: 'PUR', uruguay: 'URU', southafrica: 'RSA', kenya: 'KEN',
  ethiopia: 'ETH', myanmar: 'MYA', laos: 'LAO', cambodia: 'CAM',
  srilanka: 'SRI', nepal: 'NEP', mongolia: 'MGL', kuwait: 'KUW',
  bahrain: 'BRN', oman: 'OMA', jordan: 'JOR', lebanon: 'LBN',
  iraq: 'IRQ', syria: 'SYR', ireland: 'IRL', iceland: 'ISL',
  luxembourg: 'LUX', slovakia: 'SVK', slovenia: 'SLO', croatia: 'CRO',
  bosniaandherzegovina: 'BIH', albania: 'ALB', montenegro: 'MNE',
  moldova: 'MDA', lithuania: 'LTU', latvia: 'LAT', estonia: 'EST',
  cuba: 'CUB', jamaica: 'JAM', bolivia: 'BOL', paraguay: 'PAR',
  costarica: 'CRC', guatemala: 'GUA', elsalvador: 'ESA', honduras: 'HON',
  nicaragua: 'NCA', newzealand: 'NZL', isleofman: 'IOM',
}

const normName = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '')

// lowercase 3-letter path code; falls back to a slug for unmapped names.
export function iocCode(country) {
  if (!country) return 'xxx'
  const hit = IOC[normName(country)]
  if (hit) return hit.toLowerCase()
  return country.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'xxx'
}

export function continentCode(continent) {
  return CONTINENT_CODE[continent] ?? 'xx'
}
