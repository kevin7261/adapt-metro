// Wikipedia 連結的語言 fallback：沒中文→英文→當地語言。
// 用 Wikidata 的 sitelinks（一次 API 呼叫拿到某條目的所有語言版本），
// 依 zh → en → 該國當地語言挑第一個「真的存在」的版本；都沒有時退回任一存在的
// Wikipedia 版本，確保永遠有連結。物件 tab 的車站連結與 Info tab 的系統連結共用。

// 各國（metro 資料裡出現的 63 國）→ 主要 Wikipedia 語言代碼（當地語言）。
// 只在 zh/en 版本都不存在時才會用到，故雙語國取較常見者即可。
export const COUNTRY_WIKI_LANG = {
  Algeria: 'ar', Argentina: 'es', Armenia: 'hy', Australia: 'en', Austria: 'de',
  Azerbaijan: 'az', Bangladesh: 'bn', Belarus: 'be', Belgium: 'fr', Brazil: 'pt',
  Bulgaria: 'bg', Canada: 'en', Chile: 'es', China: 'zh', Colombia: 'es',
  Czechia: 'cs', Denmark: 'da', 'Dominican Republic': 'es', Ecuador: 'es', Egypt: 'ar',
  Finland: 'fi', France: 'fr', Georgia: 'ka', Germany: 'de', Greece: 'el',
  Hungary: 'hu', India: 'hi', Indonesia: 'id', Iran: 'fa', Italy: 'it',
  Japan: 'ja', Kazakhstan: 'kk', Malaysia: 'ms', Mexico: 'es', Netherlands: 'nl',
  Nigeria: 'en', 'North Korea': 'ko', Norway: 'no', Pakistan: 'ur', Panama: 'es',
  Peru: 'es', Philippines: 'en', Poland: 'pl', Portugal: 'pt', Qatar: 'ar',
  Romania: 'ro', Russia: 'ru', 'Saudi Arabia': 'ar', Singapore: 'en', 'South Korea': 'ko',
  Spain: 'es', Sweden: 'sv', Switzerland: 'de', Taiwan: 'zh', Thailand: 'th',
  Turkey: 'tr', Ukraine: 'uk', 'United Arab Emirates': 'ar', 'United Kingdom': 'en',
  'United States': 'en', Uzbekistan: 'uz', Venezuela: 'es', Vietnam: 'vi',
}

// sitelinks 的鍵含姊妹計畫（commonswiki、specieswiki…）與非百科；「任一存在」的
// 後備只該挑真正的語言版 Wikipedia。排除這些非語言版 wiki 鍵。
const NON_LANG_WIKI = new Set([
  'commonswiki', 'specieswiki', 'metawiki', 'wikidatawiki', 'sourceswiki',
  'mediawikiwiki', 'incubatorwiki', 'foundationwiki', 'outreachwiki',
])
const isLangWiki = (key) => /^[a-z][a-z0-9_-]*wiki$/.test(key) && !NON_LANG_WIKI.has(key)
const langOf = (key) => key.slice(0, -4).replace(/_/g, '-') // 'zh_yuewiki' → 'zh-yue'

const articleUrl = (lang, title) =>
  `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

// Q-id → { lang, title, url }，依 zh → en → 當地語言挑存在者；快取每個 (qid,country)。
const cache = new Map()
export function resolveWikiLink(qid, country) {
  if (typeof qid !== 'string' || !/^Q\d+$/.test(qid)) return Promise.resolve(null)
  const key = `${qid}|${country || ''}`
  if (cache.has(key)) return cache.get(key)
  const p = (async () => {
    try {
      const api = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&format=json&origin=*`
      const res = await fetch(api)
      if (!res.ok) return null
      const data = await res.json()
      const links = data?.entities?.[qid]?.sitelinks
      if (!links) return null
      const order = ['zh', 'en', COUNTRY_WIKI_LANG[country]].filter(Boolean)
      for (const lang of order) {
        const sl = links[`${lang}wiki`]
        if (sl?.title) return { lang, title: sl.title, url: articleUrl(lang, sl.title) }
      }
      // 都沒有 → 任一語言版 Wikipedia（deterministic：語言代碼字典序最小）
      const langKeys = Object.keys(links).filter(isLangWiki).sort()
      if (langKeys.length) {
        const k = langKeys[0]
        return { lang: langOf(k), title: links[k].title, url: articleUrl(langOf(k), links[k].title) }
      }
      return null
    } catch {
      return null
    }
  })()
  cache.set(key, p)
  return p
}
