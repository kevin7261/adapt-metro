// 規定表城市 LLM 成方批次（啟發式）——除 as-jpn-tokyo（大江戶，使用者已算）外
// 每個城市 orig＋rot 從格網化後收成四邊直線正方。
//
//   node scripts/_shapeSquareAll.mjs
//   node scripts/_shapeSquareAll.mjs as-sgp-singapore   # 只算一城
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SKIP = new Set(['as-jpn-tokyo']) // 大江戶已算過
const CITIES = [
  'as-jpn-tokyo-jr',
  'as-sgp-singapore',
  'as-twn-kaohsiung',
  'as-jpn-osaka-jr',
  'as-kor-seoul',
  'as-chn-shanghai',
  'as-chn-beijing',
  'eu-ger-berlin',
  'eu-rus-moscow',
]
const only = process.argv[2]
const onlyVariant = process.argv[3] // optional: orig|rot
// 明確指定城市時略過 SKIP（例：補 as-jpn-tokyo rot）；全量批次仍跳過大江戶。
const jobs = (only ? [only] : CITIES).filter((c) => only || !SKIP.has(c))

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 80e6, cwd: ROOT })
}
function exportCity(city, variant) {
  return JSON.parse(run(`node scripts/llmShape.mjs export ${city} ${variant}`))
}
function apply(city, variant, movesPath) {
  return JSON.parse(run(`node scripts/llmShape.mjs apply ${city} ${variant} ${movesPath}`))
}
function reset(city, variant) {
  try { run(`node scripts/llmShape.mjs reset ${city} ${variant}`) } catch { /* */ }
}

function shoelace(ring) {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    s += a.c * b.r - b.c * a.r
  }
  return s
}

function closestCorner(ring, cx, cy, exclude) {
  let bi = -1, bd = Infinity
  for (const p of ring) {
    if (exclude.has(p.i)) continue
    const d = Math.hypot(p.c - cx, p.r - cy)
    if (d < bd) { bd = d; bi = p.i }
  }
  return bi
}

function between(ordered, a, b) {
  const out = []
  for (let k = (a + 1) % ordered.length; k !== b; k = (k + 1) % ordered.length) out.push(ordered[k])
  return out
}

function placeSide(moves, ids, axis, fixed, from, to) {
  const n = ids.length
  for (let k = 0; k < n; k++) {
    const t = (k + 1) / (n + 1)
    moves[ids[k]] = axis === 'c'
      ? [fixed, Math.round(from + (to - from) * t)]
      : [Math.round(from + (to - from) * t), fixed]
  }
}

/** 單環：四角落角＋邊上等距。回傳 { moves, greens }（greens 先空，必要時第二輪補）。 */
function planRing(ringInfo, verts, edges, cols, rows) {
  const ring = ringInfo.ring
  const { minX, minY, maxX, maxY } = ringInfo.box
  const ringIs = ring.map((p) => p.i)
  const used = new Set()
  const C = {
    BR: closestCorner(ring, maxX, maxY, used),
  }
  used.add(C.BR)
  C.TR = closestCorner(ring, maxX, minY, used); used.add(C.TR)
  C.TL = closestCorner(ring, minX, minY, used); used.add(C.TL)
  C.BL = closestCorner(ring, minX, maxY, used); used.add(C.BL)

  const brAt = ringIs.indexOf(C.BR)
  const ordered = [...ringIs.slice(brAt), ...ringIs.slice(0, brAt)]
  const at = (id) => ordered.indexOf(id)
  const iBR = at(C.BR), iTR = at(C.TR), iTL = at(C.TL), iBL = at(C.BL)
  const moves = {
    [C.BR]: [maxX, maxY],
    [C.TR]: [maxX, minY],
    [C.TL]: [minX, minY],
    [C.BL]: [minX, maxY],
  }
  const trAfter = (iTR - iBR + ordered.length) % ordered.length
  const blAfter = (iBL - iBR + ordered.length) % ordered.length
  const ccw = trAfter < blAfter
  if (ccw) {
    placeSide(moves, between(ordered, iBR, iTR), 'c', maxX, maxY, minY)
    placeSide(moves, between(ordered, iTR, iTL), 'r', minY, maxX, minX)
    placeSide(moves, between(ordered, iTL, iBL), 'c', minX, minY, maxY)
    placeSide(moves, between(ordered, iBL, iBR), 'r', maxY, minX, maxX)
  } else {
    placeSide(moves, between(ordered, iBR, iBL), 'r', maxY, maxX, minX)
    placeSide(moves, between(ordered, iBL, iTL), 'c', minX, maxY, minY)
    placeSide(moves, between(ordered, iTL, iTR), 'r', minY, minX, maxX)
    placeSide(moves, between(ordered, iTR, iBR), 'c', maxX, minY, maxY)
  }

  // 環鄰域外推（擋路）
  const ringSet = new Set(ringIs)
  const edgeMap = new Map()
  for (const [a, b] of edges) {
    if (!edgeMap.has(a)) edgeMap.set(a, [])
    if (!edgeMap.has(b)) edgeMap.set(b, [])
    edgeMap.get(a).push(b)
    edgeMap.get(b).push(a)
  }
  const vertOf = Object.fromEntries(verts.map((v) => [v.i, v]))
  for (const i of ringIs) {
    for (const j of (edgeMap.get(i) || [])) {
      if (ringSet.has(j) || moves[j]) continue
      const v = vertOf[j], p = vertOf[i]
      if (!v || !p || !moves[i]) continue
      const [tc, tr] = moves[i]
      let nc = tc + (v.c - p.c), nr = tr + (v.r - p.r)
      if (nc >= minX && nc <= maxX && nr >= minY && nr <= maxY) {
        const dL = v.c - minX, dR = maxX - v.c, dT = v.r - minY, dB = maxY - v.r
        const m = Math.min(dL, dR, dT, dB)
        if (m === dL) nc = minX - 2
        else if (m === dR) nc = maxX + 2
        else if (m === dT) nr = minY - 2
        else nr = maxY + 2
      }
      nc = Math.max(0, Math.min(cols - 1, nc))
      nr = Math.max(0, Math.min(rows - 1, nr))
      moves[j] = [nc, nr]
    }
  }

  // 撞目標格的非環站外推
  const occ = new Set(Object.values(moves).map(([c, r]) => `${c},${r}`))
  for (const v of verts) {
    if (ringSet.has(v.i) || moves[v.i]) continue
    if (![...Object.values(moves)].some(([c, r]) => c === v.c && r === v.r)) continue
    let c = Math.min(cols - 1, maxX + 2), r = v.r
    let g = 0
    while (occ.has(`${c},${r}`) && g++ < 40) r = (r + 1) % rows
    moves[v.i] = [c, r]
    occ.add(`${c},${r}`)
  }

  return { moves, greens: [], corners: C, ccw }
}

/** 缺角時補綠折：找跨過該角的相鄰環站對。 */
function greenForMissingCorners(ringInfo, exp) {
  const ring = ringInfo.ring
  const { minX, minY, maxX, maxY } = ringInfo.box
  const corners = [[maxX, maxY], [maxX, minY], [minX, minY], [minX, maxY]]
  const greens = []
  const moves = {}
  for (const [cx, cy] of corners) {
    if (ring.some((p) => p.c === cx && p.r === cy)) continue
    let best = -1, bd = Infinity
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      const mx = (a.c + b.c) / 2, my = (a.r + b.r) / 2
      const d = Math.hypot(mx - cx, my - cy)
      if (d < bd) { bd = d; best = i }
    }
    const a = ring[best], b = ring[(best + 1) % ring.length]
    greens.push({ a: a.i, b: b.i, cell: [cx, cy] })
    // 兩端貼最近邊
    for (const p of [a, b]) {
      const dL = Math.abs(p.c - minX), dR = Math.abs(p.c - maxX)
      const dT = Math.abs(p.r - minY), dB = Math.abs(p.r - maxY)
      const m = Math.min(dL, dR, dT, dB)
      if (m === dR) moves[p.i] = [maxX, Math.min(maxY, Math.max(minY, p.r))]
      else if (m === dL) moves[p.i] = [minX, Math.min(maxY, Math.max(minY, p.r))]
      else if (m === dT) moves[p.i] = [Math.min(maxX, Math.max(minX, p.c)), minY]
      else moves[p.i] = [Math.min(maxX, Math.max(minX, p.c)), maxY]
    }
  }
  // 清角格佔用
  for (const v of exp.verts) {
    if (moves[v.i]) continue
    if (!greens.some((g) => g.cell[0] === v.c && g.cell[1] === v.r)) continue
    moves[v.i] = [Math.min(exp.cols - 1, v.c + 2), v.r]
  }
  return { moves, greens }
}

function writeMoves(path, spec) {
  writeFileSync(path, JSON.stringify(spec, null, 2))
}

function squareOne(city, variant) {
  reset(city, variant)
  let exp = exportCity(city, variant)
  if (exp.skipped) return { city, variant, status: 'skipped', note: exp.note }
  if (exp.allSquare) return { city, variant, status: 'already', square: true }

  const tmp = join(ROOT, 'scripts', `_sq-${city}.${variant}.json`)
  let last = null

  // Round 1: all rings corner+edge plan
  {
    const moves = {}
    for (const ri of exp.rings) {
      const plan = planRing(ri, exp.verts, exp.edges, exp.cols, exp.rows)
      Object.assign(moves, plan.moves)
    }
    writeMoves(tmp, {
      model: 'Composer',
      prompt: `成方批次——${city} ${variant}`,
      note: `第1輪：各環四角落角＋邊上等距＋鄰域外推（${exp.rings.map((r) => r.route).join('＋')}）`,
      moves, greens: [],
    })
    last = apply(city, variant, tmp)
    exp = exportCity(city, variant)
    if (exp.allSquare) {
      try { unlinkSync(tmp) } catch { /* */ }
      return { city, variant, status: 'ok', square: true, via: last.via, rounds: last.rounds, crosses: last.crosses }
    }
  }

  // Round 2: greens for missing corners on each ring
  {
    const moves = {}
    const greens = []
    for (const ri of exp.rings) {
      if (ri.square) continue
      const g = greenForMissingCorners(ri, exp)
      Object.assign(moves, g.moves)
      greens.push(...g.greens)
    }
    writeMoves(tmp, {
      model: 'Composer',
      note: `第2輪：缺角補綠折 ×${greens.length}`,
      moves, greens,
    })
    last = apply(city, variant, tmp)
    exp = exportCity(city, variant)
    if (exp.allSquare) {
      try { unlinkSync(tmp) } catch { /* */ }
      return { city, variant, status: 'ok', square: true, via: last.via, rounds: last.rounds, crosses: last.crosses }
    }
  }

  // Round 3–6: snap remaining ring verts to nearest edge; shove blockers
  for (let round = 3; round <= 6; round++) {
    if (exp.allSquare) break
    const moves = {}
    for (const ri of exp.rings) {
      if (ri.square) continue
      const { minX, minY, maxX, maxY } = ri.box
      for (const p of ri.ring) {
        const dL = Math.abs(p.c - minX), dR = Math.abs(p.c - maxX)
        const dT = Math.abs(p.r - minY), dB = Math.abs(p.r - maxY)
        const m = Math.min(dL, dR, dT, dB)
        let t
        if (m === dR) t = [maxX, Math.min(maxY, Math.max(minY, p.r))]
        else if (m === dL) t = [minX, Math.min(maxY, Math.max(minY, p.r))]
        else if (m === dT) t = [Math.min(maxX, Math.max(minX, p.c)), minY]
        else t = [Math.min(maxX, Math.max(minX, p.c)), maxY]
        if (t[0] !== p.c || t[1] !== p.r) moves[p.i] = t
      }
      // force corners occupied or green
      for (const [cx, cy] of [[maxX, maxY], [maxX, minY], [minX, minY], [minX, maxY]]) {
        if (ri.ring.some((p) => p.c === cx && p.r === cy)) continue
        // move nearest ring vert onto corner if free
        let bi = -1, bd = Infinity
        for (const p of ri.ring) {
          const d = Math.hypot(p.c - cx, p.r - cy)
          if (d < bd) { bd = d; bi = p.i }
        }
        if (bi >= 0) moves[bi] = [cx, cy]
      }
    }
    if (!Object.keys(moves).length) break
    writeMoves(tmp, {
      model: 'Composer',
      note: `第${round}輪：貼邊／補角`,
      moves, greens: [],
    })
    last = apply(city, variant, tmp)
    exp = exportCity(city, variant)
  }

  try { unlinkSync(tmp) } catch { /* */ }
  return {
    city, variant,
    status: exp.allSquare ? 'ok' : 'fail',
    square: !!exp.allSquare,
    via: last?.via,
    rounds: last?.rounds,
    crosses: last?.crosses,
    rings: exp.rings?.map((r) => ({ route: r.route, square: r.square, q: r.quality })),
  }
}

const results = []
for (const city of jobs) {
  for (const variant of (onlyVariant ? [onlyVariant] : ['orig', 'rot'])) {
    process.stdout.write(`→ ${city}.${variant} … `)
    try {
      const r = squareOne(city, variant)
      results.push(r)
      console.log(r.status, r.square ? '✓' : '✗', r.via ?? '', r.rings ? JSON.stringify(r.rings) : '')
    } catch (e) {
      results.push({ city, variant, status: 'error', err: String(e.message || e).slice(0, 200) })
      console.log('ERROR', e.message || e)
    }
  }
}

console.log('\n=== SUMMARY ===')
for (const r of results) {
  console.log(`${r.city}.${r.variant}`, r.status, r.square ? 'square' : '', r.err ?? '')
}
const ok = results.filter((r) => r.square || r.status === 'already').length
const fail = results.filter((r) => r.status === 'fail' || r.status === 'error').length
console.log(`成方 ${ok}／${results.length}，失敗 ${fail}`)
writeFileSync(join(ROOT, 'scripts/_shapeSquareAll.out.json'), JSON.stringify(results, null, 2))
