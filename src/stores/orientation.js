// Street/line-network orientation analysis, after Boeing (2019),
// "Urban Spatial Order: Street Network Orientation, Configuration, and Entropy".
//
// For every straight segment of every line we take its compass bearing AND its
// reciprocal (bearing + 180°) — the centreline is undirected, so the rose is
// bidirectionally symmetric. Bearings are binned into 36 equal 10° bins, each
// shifted by −5° so cardinal values (0°, 90°, …) sit at bin CENTRES rather than
// edges. Each bearing is weighted by its segment's great-circle length, so the
// distribution reflects how much track runs in each direction (Boeing's H_w).

const NUM_BINS = 36
const BIN_DEG = 360 / NUM_BINS // 10°
const H_MAX = Math.log(NUM_BINS) // 3.584 nats — perfectly uniform
const H_GRID = Math.log(4) // 1.386 nats — a perfect 4-way grid (2 axes → 4 bins)

const toRad = (d) => (d * Math.PI) / 180

// Initial compass bearing (0–360, 0 = north) from point a to b ([lng, lat]).
function bearing(a, b) {
  const φ1 = toRad(a[1]), φ2 = toRad(b[1])
  const Δλ = toRad(b[0] - a[0])
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

// Great-circle length (metres) of a segment.
function segLength(a, b) {
  const R = 6371000
  const φ1 = toRad(a[1]), φ2 = toRad(b[1])
  const dφ = toRad(b[1] - a[1]), dλ = toRad(b[0] - a[0])
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Bin index for a bearing, with the −5° shift so 0°/90°/… are bin centres.
function binOf(deg) {
  return Math.floor(((deg + BIN_DEG / 2) % 360) / BIN_DEG) % NUM_BINS
}

// Walk every straight segment of a line geometry (LineString / MultiLineString).
function eachSegment(geom, fn) {
  if (!geom) return
  const lines = geom.type === 'LineString' ? [geom.coordinates]
    : geom.type === 'MultiLineString' ? geom.coordinates
      : []
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) fn(line[i - 1], line[i])
  }
}

// Compute the length-weighted orientation distribution of a GeoJSON's line
// features. Returns { bins, hist, hw, phi, segments, totalKm, numBins }:
//   bins  — normalised weights per bin (sum ≈ 1), length NUM_BINS
//   hw    — length-weighted Shannon entropy (nats)
//   phi   — orientation-order φ ∈ [0,1]: 0 = uniform/disordered, 1 = perfect grid
export function computeOrientation(geojson) {
  const weights = new Array(NUM_BINS).fill(0)
  let total = 0
  let segments = 0

  for (const f of geojson?.features ?? []) {
    if (f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint') continue
    eachSegment(f.geometry, (a, b) => {
      const len = segLength(a, b)
      if (!(len > 0)) return
      const brg = bearing(a, b)
      // bearing + reciprocal, each weighted by the same segment length
      weights[binOf(brg)] += len
      weights[binOf((brg + 180) % 360)] += len
      total += len * 2
      segments++
    })
  }

  if (total === 0) {
    return { bins: weights, hw: 0, phi: 0, segments: 0, totalKm: 0, numBins: NUM_BINS }
  }

  const bins = weights.map((w) => w / total)
  let hw = 0
  for (const p of bins) if (p > 0) hw -= p * Math.log(p)
  // φ = 1 − ((H − H_grid) / (H_max − H_grid))²  (Boeing 2019, eq. 3)
  const norm = (hw - H_GRID) / (H_MAX - H_GRID)
  const phi = Math.max(0, Math.min(1, 1 - norm * norm))

  return {
    bins,
    hw,
    phi,
    segments,
    // one direction's length in km (weights double-count via the reciprocal)
    totalKm: total / 2 / 1000,
    numBins: NUM_BINS,
  }
}
