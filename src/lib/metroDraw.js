// D3Tab 與 viewGeometry 共用的色盤／站色／共線虛線（單一來源，避免縮圖與互動視圖漂移）。

export const NODE_COLOR = {
  red: '#e11d48', blue: '#2563eb', black: '#ffffff', purple: '#a855f7',
  pink: '#ec4899', gray: '#9ca3af', yellow: '#eab308',
  green: '#22c55e', // Shape-Guided 控制點（路線轉折）
}
export const EDGE_HL = { coline: '#e11d48', loop: '#16a34a', parallel: '#2563eb' }
export const EDGE_LABEL = { coline: '共線合併', loop: '環線', parallel: '頭尾共點', plain: '一般' }

export const MAX_OVERLAP = 6
export const DASH = 5

// Geographic / MapLibre 同源：interchange 紅、terminus 藍、否則白。
// 用 is_interchange，不用 lines>1（後者會把多線共軌中途站誤判成紅）。
export function stationColor(p) {
  if (p?.is_interchange) return '#e11d48'
  if (p?.is_terminus) return '#2563eb'
  return '#ffffff'
}

// 單色 → 實線；共線（≥2 相異色）→ 交錯虛線。
// colorKey：viewGeometry 用 'color'、D3Tab 用 'stroke'。
export function strokesOf(routeColors, fallback, d, { colorKey = 'color', extra = null } = {}) {
  const cols = (routeColors ?? []).slice(0, MAX_OVERLAP)
  if (new Set(cols).size >= 2) {
    const n = cols.length
    return cols.map((c, i) => ({
      d,
      [colorKey]: c,
      ...(extra || {}),
      dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}`,
    }))
  }
  return [{ d, [colorKey]: cols[0] ?? fallback ?? '#e11d48', ...(extra || {}) }]
}

// D3Tab 畫線慣用 stroke 欄位。
export const dashStrokes = (d, colsIn, fallback, extra) =>
  strokesOf(colsIn, fallback, d, { colorKey: 'stroke', extra })

export const isLandmark = (p) => p && p.landmark_id != null
export const landmarkStroke = (p) => (/river/.test(p?.kind || '') ? '#00E5FF' : '#58a866')
export const featStrokes = (f, d, extra) => isLandmark(f.properties)
  ? [{ d, stroke: landmarkStroke(f.properties), ...extra }]
  : dashStrokes(d, f.properties.route_colors, null, extra)
