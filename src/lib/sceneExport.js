// 目前畫面內容 → GeoJSON（圖層「匯出」）。
// lineData 的 SVG path 解析回座標；stationData 是已放好的節點。
// 座標＝畫面像素（示意佈局本就非地理座標）。

export function pathToSubpaths(d) {
  const out = []
  for (const part of String(d ?? '').split(/(?=[Mm])/)) {
    const nums = part.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
    if (!nums || nums.length < 4) continue
    const coords = []
    for (let i = 0; i + 1 < nums.length; i += 2) coords.push([+nums[i], +nums[i + 1]])
    if (coords.length >= 2) out.push(coords)
  }
  return out
}

export function sceneToGeojson(lineData, stationData, w, h, viewType = 'd3') {
  const features = []
  for (const ln of lineData) {
    const subs = pathToSubpaths(ln.d)
    if (!subs.length) continue
    features.push({
      type: 'Feature',
      geometry: subs.length === 1
        ? { type: 'LineString', coordinates: subs[0] }
        : { type: 'MultiLineString', coordinates: subs },
      properties: { kind: 'line', stroke: ln.stroke ?? null, ...(ln.dash ? { dash: ln.dash } : {}) },
    })
  }
  for (const s of stationData) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.x, s.y] },
      properties: { ...s.props, kind: 'node', fill: s.fill },
    })
  }
  return { type: 'FeatureCollection', _view: viewType, _frame: { w, h }, features }
}
