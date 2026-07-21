// Shape-Guided 規定表——要不要算、算哪一段、嵌什麼形，一律由此表決定，不自動猜環線。
//
// 目前只開三處（其餘城市＝不需計算）：
//   as-jpn-tokyo-jr  山手線（整條閉合環）
//   as-sgp-singapore 環狀線閉合主線（不含支線）
//   as-jpn-tokyo     大江戶線環形路段（首站重複處切斷，不含支線）
//
// 兩個必存欄位：
//   stations / routeSegment —— 沿路車站路段（骨架站序，含合成 x*）
//   shape —— 形狀碼；目前一律 0＝方形

/** 0＝方形（目前唯一） */
export const SHAPE_SQUARE = 0

/**
 * @typedef {{
 *   label: string,
 *   shape: number,
 *   routeId: string,
 *   nameRe: RegExp,
 *   segment: 'full' | 'first-cycle',
 *   stations: string[],
 * }} ShapePreset
 */

/** @type {Record<string, ShapePreset>} */
export const SHAPE_PRESETS = {
  // 東京＋山手：整條山手線
  'as-jpn-tokyo-jr': {
    label: '山手線',
    shape: SHAPE_SQUARE,
    routeId: 'jr1972960',
    nameRe: /山手|やまのて|yamanote/i,
    segment: 'full',
    stations: [
      'n3589537622', 'n7293401980', 'n3708279829', 'n1926726026', 'n3349961083',
      'x4', 'n6191130324', 'n6193732167', 'x17', 'x1', 'n6329152325', 'n6238851056',
      'n3708277005', 'x16', 'n7786715957', 'n3708279853', 'n3708276261', 'n772364943',
      'n3708277021', 'n5406704191', 'n5409208380', 'n1950369530', 'n1926376083',
      'n3708276252', 'n5408217482', 'n3708277016', 'x15', 'n281417661', 'n5410124418',
      'n4947881828', 'x11', 'n6219204314', 'n262449251', 'n266085875', 'n7791605888',
      'n3708277011', 'n3589537622',
    ],
  },
  // 新加坡：MRT Circle Line 閉合主線（rm7981685；支線 r7981667 不算）
  'as-sgp-singapore': {
    label: '環狀線',
    shape: SHAPE_SQUARE,
    routeId: 'rm7981685',
    nameRe: /Circle|環狀|circle.?line/i,
    segment: 'full',
    stations: [
      'n5388281880', 'n5388291979', 'n6589313470', 'n387133039', 'n387132839',
      'n387133091', 'n7691088900', 'n387132826', 'n5233734955', 'n387133490',
      'n12842237353', 'n6587643568', 'n1840733425', 'n1090384588', 'n2578601203',
      'n388561979', 'n388561205', 'n7691088944', 'n7691088945', 'n7684326283',
      'n388560610', 'n388560505', 'n388558260', 'n7691352819', 'n388555785',
      'n388553160', 'n6531622803', 'n12849271710', 'n12849271709', 'n12849271708',
      'n5388281880',
    ],
  },
  // 東京地鐵：大江戶線環形路段（全線有支線；取首站重複前的閉合段）
  'as-jpn-tokyo': {
    label: '大江戶線環形路段',
    shape: SHAPE_SQUARE,
    routeId: 'rm8019893',
    nameRe: /大江戸|おおえど|oedo|Ōedo/i,
    segment: 'first-cycle',
    stations: [
      'n6203591949', 'x2', 'n2389826102', 'n1951953898', 'n475369200', 'n2389826186',
      'n2389826225', 'n5406690065', 'n5409196590', 'n789405355', 'x8', 'n5411585752',
      'n6209017478', 'n7791591076', 'n7791605896', 'n5594511143', 'n5594511144',
      'n251465504', 'n1926417056', 'n6440614866', 'n7791605894', 'n2389825841',
      'n1926726026', 'x10', 'n7777248485', 'n6509432921', 'n7786715975', 'x7',
      'n265554028', 'n6206496012', 'x4', 'n5410124418', 'n281417661', 'n6203591949',
    ],
  },
}

/** 圖層 id → 規定表鍵；無規定回 null（＝不需計算） */
export function shapePresetKey(cityId) {
  if (!cityId) return null
  const base = String(cityId).replace(/-lm$/, '')
  if (SHAPE_PRESETS[base]) return base
  // 新加坡＋LRT 變體仍含環狀線閉合主線
  if (base === 'as-sgp-singapore-lrt') return 'as-sgp-singapore'
  return null
}

export function getShapePreset(cityId) {
  const key = shapePresetKey(cityId)
  return key ? SHAPE_PRESETS[key] : null
}
