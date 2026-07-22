// 全城「重新計算」——清空衍生 JSON 後重跑 buildViews／bakeHcCells（可選再跑 LLM 成方）。
//   POST /metro-recompute/run   { mode: 'all' | 'no-shape' | 'dataflow' }
//   GET  /metro-recompute/status
//
// mode:
//   all      — 全清（含成方）＋重算資料流＋重跑 LLM 成方
//   no-shape — 成方相關一律不動（straighten-shape／形狀 cells／畫廊 *-shape 視圖）
//              只重算一般（無形狀）路網
//   dataflow — 不成方（保留 straighten-shape），但清空並重算整條資料流
//              （含有形狀圖層的畫廊／cells）
//
// 衍生檔（皆 JSON）：
//   data/metro/map-adjust/*.json      Map Adjust 畫廊縮圖
//   data/metro/straighten/*.json      Straighten 畫廊縮圖
//   data/metro/rwd-maps/*.json        RWD Maps 畫廊縮圖
//   data/metro/straighten-cells/*.json  整數格佈局（開分頁讀檔）
//   data/metro/straighten-shape/*.json  LLM 成方結果
import {
  existsSync, readdirSync, rmSync, readFileSync, writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const VIEW_DIRS = [
  'data/metro/map-adjust',
  'data/metro/straighten',
  'data/metro/rwd-maps',
]
const SHAPE_VIEW_DIRS = ['data/metro/straighten', 'data/metro/rwd-maps']
const CELLS_DIR = 'data/metro/straighten-cells'
const SHAPE_DIR = 'data/metro/straighten-shape'

const MODES = new Set(['all', 'no-shape', 'dataflow'])

/** 成方相關 cells：*.shapelike.json 或 *-(orig|rot)-shape*.json */
function isShapeCellFile(name) {
  return name.includes('.shapelike.')
    || name.endsWith('.shapelike.json')
    || /\.(orig|rot)-shape(\.|\.shapelike\.)?json$/.test(name)
    || name.includes('-shape.')
}

/** 畫廊 views 裡的成方鍵（loop-*-orig-shape / rwd-*-rot-shape …） */
function isShapeViewKey(key) {
  return /-(orig|rot)-shape$/.test(key)
}

function clearJsonDir(abs, { keepIndex = false, skipFile = null } = {}) {
  if (!existsSync(abs)) return 0
  let n = 0
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.json')) continue
    if (keepIndex && name === 'index.json') continue
    if (name.startsWith('_')) continue
    if (skipFile && skipFile(name)) continue
    try { rmSync(join(abs, name)); n++ } catch { /* best-effort */ }
  }
  return n
}

/** 備份各城畫廊 JSON 裡的成方 views（no-shape 重算後寫回，確保成方縮圖不動） */
function snapshotShapeViews(root) {
  const snap = new Map() // relDir/id → { views:{}, stats?:{} }
  for (const rel of SHAPE_VIEW_DIRS) {
    const abs = join(root, rel)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.json') || name === 'index.json') continue
      try {
        const j = JSON.parse(readFileSync(join(abs, name), 'utf8'))
        const views = {}
        const stats = {}
        for (const [k, v] of Object.entries(j.views ?? {})) {
          if (isShapeViewKey(k)) views[k] = v
        }
        for (const [k, v] of Object.entries(j.stats ?? {})) {
          if (isShapeViewKey(k)) stats[k] = v
        }
        if (Object.keys(views).length) {
          snap.set(`${rel}/${name}`, { views, stats })
        }
      } catch { /* skip bad file */ }
    }
  }
  return snap
}

function restoreShapeViews(root, snap) {
  let n = 0
  for (const [rel, { views, stats }] of snap) {
    const abs = join(root, rel)
    if (!existsSync(abs)) continue
    try {
      const j = JSON.parse(readFileSync(abs, 'utf8'))
      j.views = { ...(j.views ?? {}), ...views }
      if (Object.keys(stats).length) j.stats = { ...(j.stats ?? {}), ...stats }
      writeFileSync(abs, JSON.stringify(j))
      n++
    } catch { /* skip */ }
  }
  return n
}

function shapeCities(root) {
  try {
    const src = readFileSync(join(root, 'src/stores/paper/shapePresets.js'), 'utf8')
    const m = src.match(/export const SHAPE_PRESETS = \{([\s\S]*?)\n\}/)
    if (!m) return []
    return [...m[1].matchAll(/^\s*'([\w-]+)':\s*\[/gm)].map((x) => x[1])
  } catch { return [] }
}

export function metroRecompute() {
  const root = process.cwd()
  /** @type {{ running: boolean, mode: string|null, step: string, log: string[], exit: number|null, error: string|null, cleared: object|null }} */
  let job = {
    running: false, mode: null, step: '', log: [], exit: null, error: null, cleared: null,
  }

  const append = (line) => {
    const s = String(line).replace(/\s+$/, '')
    if (!s) return
    job.log.push(s)
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400)
    console.log(`[metro-recompute] ${s}`)
  }

  const readBody = (req) => new Promise((ok) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok(null) } })
  })

  const runCmd = (cmd, args, label) => new Promise((resolve, reject) => {
    job.step = label
    append(`▶ ${label}：${cmd} ${args.join(' ')}`)
    const child = spawn(cmd, args, { cwd: root, env: process.env, shell: false })
    const onChunk = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) append(line)
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} 結束碼 ${code}`))
    })
  })

  const runLlmShapes = async () => {
    const cities = shapeCities(root)
    if (!cities.length) {
      append('無規定表城市——跳過 LLM 成方')
      return
    }
    const cmd = process.env.CLAUDE_CMD ?? 'claude'
    const variants = ['orig', 'rot']
    let i = 0
    const total = cities.length * variants.length
    for (const city of cities) {
      for (const variant of variants) {
        i++
        job.step = `llm-shape ${city}.${variant} (${i}/${total})`
        append(`▶ LLM 成方 ${city}.${variant}（${i}/${total}）`)
        const prompt = `使用 route-llm-shape skill：幫城市 ${city}（變體 ${variant}）用 LLM 把規定路段收成`
          + '四邊直線正方（isFourLineSquare），是 ⑨形狀計算的 LLM 版。'
        await new Promise((resolve, reject) => {
          const child = spawn(cmd, [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions',
          ], { cwd: root, env: process.env, shell: false })
          child.stdout.on('data', (buf) => {
            for (const line of String(buf).split(/\r?\n/)) {
              if (!line) continue
              try {
                const ev = JSON.parse(line)
                if (ev.type === 'assistant' && ev.message?.content) {
                  for (const c of ev.message.content) {
                    if (c.type === 'text' && c.text) append(c.text.slice(0, 200))
                  }
                }
              } catch { append(line.slice(0, 200)) }
            }
          })
          child.stderr.on('data', (buf) => append(String(buf).slice(0, 300)))
          child.on('error', (err) => reject(err))
          child.on('close', (code) => {
            if (code === 0) resolve()
            else {
              append(`⚠ LLM 成方 ${city}.${variant} 結束碼 ${code}（繼續下一城）`)
              resolve()
            }
          })
        })
      }
    }
  }

  const startJob = async (mode) => {
    job = {
      running: true, mode, step: 'clear', log: [], exit: null, error: null, cleared: null,
    }
    try {
      const cleared = { views: 0, cells: 0, shapes: 0, shapeViewsKept: 0 }

      // no-shape：先備份畫廊成方視圖，重算後寫回
      const shapeSnap = mode === 'no-shape' ? snapshotShapeViews(root) : null
      if (shapeSnap) append(`已備份 ${shapeSnap.size} 個畫廊檔的成方縮圖（將原樣寫回）`)

      for (const d of VIEW_DIRS) cleared.views += clearJsonDir(join(root, d))

      if (mode === 'no-shape') {
        // 成方 cells 一律不動
        cleared.cells = clearJsonDir(join(root, CELLS_DIR), { skipFile: isShapeCellFile })
        append(`已清空：畫廊 ${cleared.views}、一般 cells ${cleared.cells}（成方 cells／成方結果不動）`)
      } else {
        cleared.cells = clearJsonDir(join(root, CELLS_DIR))
        if (mode === 'all') cleared.shapes = clearJsonDir(join(root, SHAPE_DIR))
        append(`已清空：畫廊 ${cleared.views}、cells ${cleared.cells}`
          + (mode === 'all' ? `、成方 ${cleared.shapes}` : '（成方結果檔保留）'))
      }
      job.cleared = cleared

      await runCmd('node', ['scripts/buildViews.mjs'], 'buildViews 畫廊縮圖')
      await runCmd('node', ['scripts/bakeHcCells.mjs', '--force'], 'bakeHcCells 一般路網')

      if (mode === 'no-shape') {
        // 把舊的成方縮圖蓋回，避免 buildViews 用現有成方檔重算出新的形狀視圖
        cleared.shapeViewsKept = restoreShapeViews(root, shapeSnap)
        append(`已還原 ${cleared.shapeViewsKept} 個畫廊檔的成方縮圖（內容未改）`)
      } else if (mode === 'dataflow') {
        // 沿用既有成方 → 重算有形狀資料流
        await runCmd('node', ['scripts/bakeHcCells.mjs', '--shape', '--force'], 'bakeHcCells 有形狀資料流')
      } else if (mode === 'all') {
        await runLlmShapes()
        await runCmd('node', ['scripts/buildViews.mjs'], 'buildViews（含新成方）')
        await runCmd('node', ['scripts/bakeHcCells.mjs', '--shape', '--force'], 'bakeHcCells 有形狀資料流')
      }

      job.step = 'done'
      job.exit = 0
      append('✓ 全部完成')
    } catch (err) {
      job.error = String(err?.message ?? err)
      job.exit = 1
      append(`✗ ${job.error}`)
    } finally {
      job.running = false
    }
  }

  const handler = async (req, res, next) => {
    const p = (req.url ?? '').split('?')[0]
    if (!p.startsWith('/metro-recompute/')) return next()
    res.setHeader('Content-Type', 'application/json')

    if (p === '/metro-recompute/status' && req.method === 'GET') {
      res.end(JSON.stringify({
        running: job.running,
        mode: job.mode,
        step: job.step,
        exit: job.exit,
        error: job.error,
        cleared: job.cleared,
        tail: job.log.slice(-12).join('\n'),
        logCount: job.log.length,
      }))
      return
    }

    if (p === '/metro-recompute/run' && req.method === 'POST') {
      if (job.running) {
        res.statusCode = 409
        res.end(JSON.stringify({ error: 'already running', step: job.step }))
        return
      }
      const body = await readBody(req)
      const mode = MODES.has(body?.mode) ? body.mode : null
      if (!mode) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'mode must be all | no-shape | dataflow' }))
        return
      }
      startJob(mode)
      res.statusCode = 202
      res.end(JSON.stringify({ ok: true, mode, message: 'started' }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  }

  return {
    name: 'metro-recompute',
    configureServer(server) { server.middlewares.use(handler) },
  }
}
