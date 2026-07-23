// 全城／單城「重新計算」——清空 cells（可選成方）後重跑 bakeHcCells／buildViews（可選 LLM 成方）。
//   POST /metro-recompute/run   { mode: 'all' | 'no-shape' | 'dataflow' }
//   POST /metro-recompute/city  { city }  — 單城後續資料流（Metro／Map Adjust「重新計算」）
//   GET  /metro-recompute/status
//
// mode:
//   all      — 全清 cells＋成方＋重算資料流＋重跑 LLM 成方
//   no-shape — 成方相關一律不動（straighten-shape／形狀 cells／畫廊 *-shape 視圖）
//              只重算一般（無形狀）路網
//   dataflow — 不成方（保留 straighten-shape），但清空並重算整條資料流 cells
//
// 只清可重算的 cells／成方；不動：
//   data/metro/index.json、metro-maps/*.geojson、maps/（官方路線圖）
//   畫廊 map-adjust／straighten／rwd-maps 也不先刪——buildViews 依指紋覆寫，
//   重算中途 OSM 清單與縮圖仍可顯示。
import {
  existsSync, readdirSync, rmSync, readFileSync, writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PAUSE_FILE, waitIfPaused } from '../scripts/_recomputePause.mjs'

// 成方縮圖備份／還原用（no-shape：cells 指紋變了會整檔重烤，需蓋回舊成方視圖）
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

/** 只清單一城市的 straighten-cells（含 shape／shapelike） */
function clearCityCells(root, cityId) {
  const abs = join(root, CELLS_DIR)
  if (!existsSync(abs) || !cityId) return 0
  const pref = `${cityId}.`
  let n = 0
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.json') || !name.startsWith(pref)) continue
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
    const ids = [...m[1].matchAll(/^\s*'([\w-]+)':\s*\[/gm)].map((x) => x[1])
    // 站數少→多（與 bakeHcCells 一致）
    let count = new Map()
    try {
      const index = JSON.parse(readFileSync(join(root, 'data/metro/index.json'), 'utf8'))
      for (const s of index.systems ?? []) {
        const id = (s.file || '').split('/').pop()?.replace(/\.geojson$/, '')
        if (id) count.set(id, s.station_count ?? 0)
      }
    } catch { /* ignore */ }
    return ids.sort((a, b) => (count.get(a) ?? 0) - (count.get(b) ?? 0) || a.localeCompare(b))
  } catch { return [] }
}

export function metroRecompute() {
  const root = process.cwd()
  /** @type {{ running: boolean, paused: boolean, mode: string|null, step: string, phase: string, progress: { current: number, total: number, item: string }|null, log: string[], exit: number|null, error: string|null, cleared: object|null }} */
  let job = {
    running: false, paused: false, mode: null, step: '', phase: '', progress: null,
    log: [], exit: null, error: null, cleared: null,
  }

  const clearPauseFile = () => {
    try { if (existsSync(PAUSE_FILE)) rmSync(PAUSE_FILE) } catch { /* ignore */ }
    job.paused = false
  }

  const setPaused = (on) => {
    if (!job.running) return false
    if (on) {
      try { writeFileSync(PAUSE_FILE, `${Date.now()}\n`) } catch { return false }
      job.paused = true
      const base = job.step.replace(/^已暫停 · /, '')
      job.step = `已暫停 · ${base}`
      append('⏸ 已暫停（目前這城算完後停；按繼續再開）')
    } else {
      clearPauseFile()
      job.step = job.step.replace(/^已暫停 · /, '')
      append('▶ 繼續')
    }
    return true
  }

  const setProgress = (current, total, item, phase) => {
    job.progress = { current, total, item: item || '' }
    if (phase) job.phase = phase
    const ph = job.phase || phase || ''
    const frac = total > 0 ? `${current}/${total}` : ''
    const body = [ph, frac, item].filter(Boolean).join(' · ')
    job.step = job.paused ? `已暫停 · ${body}` : body
  }

  const append = (line) => {
    const s = String(line).replace(/\s+$/, '')
    if (!s) return
    job.log.push(s)
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400)
    if (s === 'PAUSED') {
      job.paused = true
      if (!job.step.startsWith('已暫停')) job.step = `已暫停 · ${job.step}`
    } else if (s === 'RESUMED') {
      job.paused = false
      job.step = job.step.replace(/^已暫停 · /, '')
    }
    // bakeHcCells / buildViews：PROGRESS i/n item
    const m = s.match(/^PROGRESS\s+(\d+)\/(\d+)\s*(.*)$/)
    if (m) setProgress(+m[1], +m[2], m[3].trim(), job.phase)
    console.log(`[metro-recompute] ${s}`)
  }

  const readBody = (req) => new Promise((ok) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok(null) } })
  })

  const runCmd = async (cmd, args, label) => {
    await waitIfPaused()
    job.paused = existsSync(PAUSE_FILE)
    job.phase = label
    job.progress = null
    job.step = job.paused ? `已暫停 · ${label}` : label
    append(`▶ ${label}：${cmd} ${args.join(' ')}`)
    return new Promise((resolve, reject) => {
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
  }

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
    job.phase = 'LLM 成方'
    for (const city of cities) {
      for (const variant of variants) {
        await waitIfPaused()
        job.paused = existsSync(PAUSE_FILE)
        i++
        setProgress(i, total, `${city}.${variant}`, 'LLM 成方')
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

  /** 單城後續資料流：清該城 cells → bakeHcCells → bake shape → buildViews */
  const startCityJob = async (cityId) => {
    clearPauseFile()
    job = {
      running: true, paused: false, mode: 'city', step: `清空 ${cityId}…`, phase: 'clear',
      progress: null, log: [], exit: null, error: null, cleared: null, city: cityId,
    }
    try {
      const n = clearCityCells(root, cityId)
      job.cleared = { cells: n }
      append(`已清空 ${cityId} cells ${n}`)
      await runCmd('node', ['scripts/bakeHcCells.mjs', '--force', cityId], `${cityId} 一般路網`)
      await runCmd('node', ['scripts/bakeHcCells.mjs', '--shape', '--force', cityId], `${cityId} 有形狀資料流`)
      await runCmd('node', ['scripts/buildViews.mjs', cityId], `${cityId} 畫廊縮圖`)
      job.step = '完成'
      job.phase = 'done'
      job.progress = null
      job.exit = 0
      append(`✓ ${cityId} 資料流完成`)
    } catch (err) {
      job.error = String(err?.message ?? err)
      job.exit = 1
      append(`✗ ${job.error}`)
    } finally {
      clearPauseFile()
      job.running = false
    }
  }

  const startJob = async (mode) => {
    clearPauseFile()
    job = {
      running: true, paused: false, mode, step: '清空舊檔…', phase: 'clear', progress: null,
      log: [], exit: null, error: null, cleared: null,
    }
    try {
      const cleared = { views: 0, cells: 0, shapes: 0, shapeViewsKept: 0 }

      // no-shape：先備份畫廊成方視圖，重算後寫回（畫廊檔不先刪，但 cells 指紋變會整檔重烤）
      const shapeSnap = mode === 'no-shape' ? snapshotShapeViews(root) : null
      if (shapeSnap) append(`已備份 ${shapeSnap.size} 個畫廊檔的成方縮圖（將原樣寫回）`)

      // 不動畫廊／geojson／官方圖；只清可重算的 cells（與可選成方結果）
      if (mode === 'no-shape') {
        cleared.cells = clearJsonDir(join(root, CELLS_DIR), { skipFile: isShapeCellFile })
        append(`已清空：一般 cells ${cleared.cells}（畫廊／geojson／成方 cells／成方結果不動）`)
      } else {
        cleared.cells = clearJsonDir(join(root, CELLS_DIR))
        if (mode === 'all') cleared.shapes = clearJsonDir(join(root, SHAPE_DIR))
        append(`已清空：cells ${cleared.cells}`
          + (mode === 'all' ? `、成方 ${cleared.shapes}` : '（成方結果檔保留）')
          + '（畫廊／geojson／官方路線圖不動）')
      }
      job.cleared = cleared

      // 先 bake cells（D3Tab 真結果），再 buildViews（畫廊優先畫 cells）——順序不能反。
      await runCmd('node', ['scripts/bakeHcCells.mjs', '--force'], '一般路網')

      if (mode === 'no-shape') {
        await runCmd('node', ['scripts/buildViews.mjs'], '畫廊縮圖')
        // 把舊的成方縮圖蓋回，避免 buildViews 用現有成方檔重算出新的形狀視圖
        cleared.shapeViewsKept = restoreShapeViews(root, shapeSnap)
        append(`已還原 ${cleared.shapeViewsKept} 個畫廊檔的成方縮圖（內容未改）`)
      } else if (mode === 'dataflow') {
        await runCmd('node', ['scripts/bakeHcCells.mjs', '--shape', '--force'], '有形狀資料流')
        await runCmd('node', ['scripts/buildViews.mjs'], '畫廊縮圖')
      } else if (mode === 'all') {
        await runLlmShapes()
        await runCmd('node', ['scripts/bakeHcCells.mjs', '--shape', '--force'], '有形狀資料流')
        await runCmd('node', ['scripts/buildViews.mjs'], '畫廊縮圖')
      }

      job.step = '完成'
      job.phase = 'done'
      job.progress = null
      job.exit = 0
      append('✓ 全部完成')
    } catch (err) {
      job.error = String(err?.message ?? err)
      job.exit = 1
      append(`✗ ${job.error}`)
    } finally {
      clearPauseFile()
      job.running = false
    }
  }

  const handler = async (req, res, next) => {
    const p = (req.url ?? '').split('?')[0]
    if (!p.startsWith('/metro-recompute/')) return next()
    res.setHeader('Content-Type', 'application/json')

    if (p === '/metro-recompute/status' && req.method === 'GET') {
      // 與暫停檔同步（子行程可能已印 PAUSED／RESUMED）
      if (job.running) job.paused = existsSync(PAUSE_FILE)
      res.end(JSON.stringify({
        running: job.running,
        paused: job.paused,
        mode: job.mode,
        step: job.step,
        phase: job.phase,
        progress: job.progress,
        exit: job.exit,
        error: job.error,
        cleared: job.cleared,
        tail: job.log.slice(-12).join('\n'),
        logCount: job.log.length,
      }))
      return
    }

    if (p === '/metro-recompute/pause' && req.method === 'POST') {
      if (!job.running) {
        res.statusCode = 409
        res.end(JSON.stringify({ error: 'not running' }))
        return
      }
      setPaused(true)
      res.end(JSON.stringify({ ok: true, paused: true, step: job.step }))
      return
    }

    if (p === '/metro-recompute/resume' && req.method === 'POST') {
      if (!job.running) {
        res.statusCode = 409
        res.end(JSON.stringify({ error: 'not running' }))
        return
      }
      setPaused(false)
      res.end(JSON.stringify({ ok: true, paused: false, step: job.step }))
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

    // 單城：從目前位置起的後續資料流（cells → 可選 shape cells → 畫廊 views）
    // POST { city: 'as-twn-taipei' }
    if (p === '/metro-recompute/city' && req.method === 'POST') {
      if (job.running) {
        res.statusCode = 409
        res.end(JSON.stringify({ error: 'already running', step: job.step }))
        return
      }
      const body = await readBody(req)
      const city = String(body?.city || '').replace(/[^\w-]/g, '')
      if (!city) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'city required' }))
        return
      }
      startCityJob(city)
      res.statusCode = 202
      res.end(JSON.stringify({ ok: true, city, message: 'started' }))
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
