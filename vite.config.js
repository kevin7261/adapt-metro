import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import {
  createReadStream, existsSync, statSync, readdirSync, readFileSync,
  cpSync, mkdirSync, writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { join, normalize, resolve } from 'node:path'

// GitHub Pages project site: https://kevin7261.github.io/adapt-metro/
const pages = process.env.GITHUB_PAGES === '1'

// Serve the repo's data/ directory (metro catalog + per-system GeoJSON)
// at /data/* without copying 100+ MB into public/.
function serveDataDir() {
  const root = resolve(process.cwd(), 'data')
  const handler = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/data/')) return next()
    const urlPath = decodeURIComponent(req.url.split('?')[0]).replace(/^\/data\//, '')
    const file = normalize(join(root, urlPath))
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()
    const types = {
      json: 'application/json', geojson: 'application/json',
      png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    }
    const ext = file.split('.').pop().toLowerCase()
    res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  }
  return {
    name: 'serve-data-dir',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}

function listSkills(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
    .map((d) => {
      const md = readFileSync(join(root, d.name, 'SKILL.md'), 'utf8')
      const description = md.match(/^description:\s*(.+)$/m)?.[1].trim() ?? ''
      return { id: d.name, description }
    })
}

// Expose this repo's Claude skills (.claude/skills/*/SKILL.md) at /skills/*
// so the UI can list and display them.
function serveSkills() {
  const root = resolve(process.cwd(), '.claude/skills')
  const handler = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/skills/')) return next()
    const p = decodeURIComponent(req.url.split('?')[0])

    if (p === '/skills/index.json') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(listSkills(root)))
      return
    }

    const m = p.match(/^\/skills\/([\w-]+)\.md$/)
    if (m) {
      const file = join(root, m[1], 'SKILL.md')
      if (existsSync(file)) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        createReadStream(file).pipe(res)
        return
      }
    }
    next()
  }
  return {
    name: 'serve-skills',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}

// Headless Claude Code trigger (dev only): a page button POSTs to
// <prefix>/run and we spawn a HEADLESS session (`claude -p …`) that runs the
// given skill — no API key, the user's own Claude Code does the work. The page
// polls <prefix>/status and reloads the result file when the run finishes. On
// GitHub Pages there is no dev server, so the button simply reports that a
// local `npm run dev` is required. Instantiated three times: LLM 對齊
// (/llm-align, skill route-llm-align → llmviews)、LLM 調整 (/llm-grid, skill
// route-llm-grid → llmgrids)、LLM 評價 (/llm-eval, skill route-llm-eval →
// llmevals); `spec` supplies what differs between them.
//   spec = { name, prefix, cmdEnv,
//            validate(body|query) -> { key, outFile, prompt?, userPrompt? } | null }
function claudeSkillTrigger(spec) {
  const root = process.cwd()
  const jobs = new Map() // key -> { child, log, exit, prompt }
  const readBody = (req) => new Promise((ok) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok(null) } })
  })
  const handler = async (req, res, next) => {
    const p = (req.url ?? '').split('?')[0]
    if (!p.startsWith(`${spec.prefix}/`)) return next()
    res.setHeader('Content-Type', 'application/json')
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')

    if (p === `${spec.prefix}/status`) {
      const job = jobs.get(spec.validate(Object.fromEntries(q))?.key)
      res.end(JSON.stringify(job
        ? {
            running: job.exit === null, exit: job.exit,
            tail: job.log.slice(-6).join('\n'),
            text: job.text.slice(-4000), // live assistant transcript (streamed)
          }
        : { running: false, exit: null, tail: '', text: '' }))
      return
    }
    if (p === `${spec.prefix}/run` && req.method === 'POST') {
      const body = await readBody(req)
      const v = body ? spec.validate(body) : null
      if (!v) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'bad params' }))
        return
      }
      const { key, outFile, prompt, userPrompt } = v
      if (jobs.get(key)?.exit === null) {
        res.statusCode = 409
        res.end(JSON.stringify({ running: true }))
        return
      }
      const cmd = process.env[spec.cmdEnv] ?? 'claude'
      // stream-json (needs --verbose in print mode) emits one JSON event per
      // line as the run unfolds — so we can surface the model's replies live
      // instead of only its final text. A stub command (spec.cmdEnv) that
      // prints plain lines still works: unparseable lines fall back to raw text.
      const child = spawn(cmd, [
        '-p', prompt,
        '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Bash(node:*),Read,Write,Glob,Grep,Skill',
      ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      const job = { child, log: [], text: '', final: '', exit: null, prompt, buf: '' }
      jobs.set(key, job)
      const append = (s) => {
        job.text += s
        if (job.text.length > 8000) job.text = job.text.slice(-8000)
      }
      // Turn one stream-json event into readable「LLM 回傳文字」: assistant text
      // verbatim, tool calls as a compact marker, tool results as a short head.
      const onEvent = (ev) => {
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === 'text' && b.text) append(b.text)
            else if (b.type === 'tool_use') {
              const arg = b.name === 'Bash' ? (b.input?.command ?? '') : b.name === 'Skill' ? (b.input?.skill ?? '') : ''
              append(`\n  ⟶ ${b.name}${arg ? `：${String(arg).slice(0, 80)}` : ''}\n`)
            }
          }
        } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) {
            if (b.type === 'tool_result') {
              const t = typeof b.content === 'string' ? b.content
                : (b.content ?? []).map((c) => c.text ?? '').join('')
              append(`  ⟵ ${t.split('\n')[0].slice(0, 90)}\n`)
            }
          }
        } else if (ev.type === 'result' && ev.result) {
          job.final = ev.result
          append(`\n${ev.result}`)
        }
      }
      const push = (buf) => {
        job.buf += buf.toString()
        const lines = job.buf.split('\n')
        job.buf = lines.pop() ?? '' // keep the trailing partial line
        for (const line of lines) {
          if (!line.trim()) continue
          job.log.push(line)
          try { onEvent(JSON.parse(line)) } catch { append(`${line}\n`) } // stub / plain
        }
        if (job.log.length > 400) job.log.splice(0, job.log.length - 400)
      }
      child.stdout.on('data', push)
      child.stderr.on('data', push)
      child.on('close', (code) => {
        job.exit = code ?? -1
        // Merge the run's provenance into the result file so the panel can
        // show the prompt we sent and what the model answered.
        try {
          const f = join(root, outFile)
          if (existsSync(f)) {
            const j = JSON.parse(readFileSync(f, 'utf8'))
            j.prompt = j.prompt ?? prompt
            if (userPrompt) j.userPrompt = userPrompt // last steering instruction
            j.finalOutput = job.final || job.text.slice(-1500)
            writeFileSync(f, JSON.stringify(j))
          }
        } catch { /* provenance is best-effort */ }
      })
      child.on('error', (err) => {
        job.exit = -1
        append(`spawn 失敗：${err.message}（需要本機安裝 Claude Code CLI）`)
      })
      res.end(JSON.stringify({ started: true }))
      return
    }
    next()
  }
  return {
    name: spec.name,
    configureServer(server) { server.middlewares.use(handler) },
  }
}

// LLM 對齊：the「開始 LLM 對齊」button — headless run of route-llm-align.
function llmAlignTrigger() {
  return claudeSkillTrigger({
    name: 'llm-align-trigger',
    prefix: '/llm-align',
    cmdEnv: 'LLM_ALIGN_CMD',
    validate(b) {
      if (!/^[\w-]+$/.test(b.city ?? '') || !['orig', 'rot'].includes(b.variant)) return null
      // Optional user steering: a free-text instruction typed in the panel that
      // biases which coordinates the model moves (e.g.「優先把紅線拉成水平」).
      // 2000: LLM評價的「執行評價結果」會把建議＋逐線評語整段餵進來（>1000 字）。
      const userPrompt = typeof b.userPrompt === 'string' ? b.userPrompt.trim().slice(0, 2000) : ''
      return {
        key: `${b.city}.${b.variant}`,
        outFile: `data/metro/llmviews/${b.city}.${b.variant}.json`,
        userPrompt,
        prompt: `使用 route-llm-align skill：幫城市 ${b.city}（變體 ${b.variant}）產生或更新 LLM 對齊結果。`
          + '反覆 export → 分析 → apply 迭代到收斂（上限 10 輪）；每輪 moves.json 都要含 model 與 note（本輪思路），'
          + '第一輪另附 prompt 欄位記錄本段指示。完成後只輸出最終的 水平垂直 before → after 數字與一句總結。'
          + (userPrompt ? `\n\n使用者的額外指示（請據此決定要移動哪些座標、往哪對齊）：${userPrompt}` : ''),
      }
    },
  })
}

// LLM 調整（RWD Maps「AI 改網格長寬」）：使用者的一句話 → route-llm-grid 推理
// 每個 X 欄／Y 列區間的顯示權重 → data/metro/llmgrids，「LLM調整」tab 載入。
function llmGridTrigger() {
  return claudeSkillTrigger({
    name: 'llm-grid-trigger',
    prefix: '/llm-grid',
    cmdEnv: 'LLM_GRID_CMD',
    validate(b) {
      if (!/^[\w-]+$/.test(b.city ?? '') || !['orig', 'rot'].includes(b.variant)) return null
      const compact = ['hc', 'rect', 'align', 'ilp', 'llm'].includes(b.compact) ? b.compact : 'hc'
      const userPrompt = (typeof b.userPrompt === 'string' && b.userPrompt.trim())
        ? b.userPrompt.trim().slice(0, 1000)
        : '把路網最密集的核心區域拉開（放大），外圍相對壓縮'
      return {
        key: `${b.city}.${b.variant}.${compact}`,
        outFile: `data/metro/llmgrids/${b.city}.${b.variant}.${compact}.json`,
        userPrompt,
        prompt: `使用 route-llm-grid skill：幫城市 ${b.city}（變體 ${b.variant}，縮減 ${compact}）依使用者的一句話`
          + '推理路網網格每個 X 欄與 Y 列區間的顯示權重（export → 推理 → apply 存檔）。'
          + '權重要明顯（核心 3–5 倍、至少一組 ≥3）、由核心向外漸近、給出全部區間。'
          + '完成後只輸出一句總結（放大了哪一帶、最大倍率）。'
          + `\n\n使用者的指示：${userPrompt}`,
      }
    },
  })
}

// LLM 評價（RWD Maps「AI 評路網佈局」）：route-llm-eval 讀佈局幾何、寫評價
// （不動任何座標）→ data/metro/llmevals，「LLM評價」tab 載入顯示。
function llmEvalTrigger() {
  return claudeSkillTrigger({
    name: 'llm-eval-trigger',
    prefix: '/llm-eval',
    cmdEnv: 'LLM_EVAL_CMD',
    validate(b) {
      if (!/^[\w-]+$/.test(b.city ?? '') || !['orig', 'rot'].includes(b.variant)) return null
      const compact = ['hc', 'rect', 'align', 'ilp', 'llm'].includes(b.compact) ? b.compact : 'hc'
      const userPrompt = typeof b.userPrompt === 'string' ? b.userPrompt.trim().slice(0, 1000) : ''
      return {
        key: `${b.city}.${b.variant}.${compact}`,
        outFile: `data/metro/llmevals/${b.city}.${b.variant}.${compact}.json`,
        userPrompt,
        prompt: `使用 route-llm-eval skill：幫城市 ${b.city}（變體 ${b.variant}，縮減 ${compact}）產生或更新 LLM 評價`
          + '（export 讀佈局幾何 → 寫評價 → apply 存檔）。只評價、不修改任何座標；'
          + '評語要用站名與數字落地（哪條線哪一段可以更直/更水平、彎在哪、怎麼更方正）。'
          + '完成後只輸出一句總結（總評第一句＋最需要改的一條線）。'
          + (userPrompt ? `\n\n使用者的關注點：${userPrompt}` : ''),
      }
    },
  })
}

// Production build: copy runtime assets Vite middleware serves in dev.
function copyStaticAssets() {
  return {
    name: 'copy-static-assets',
    closeBundle() {
      const dist = resolve(process.cwd(), 'dist')
      const metroSrc = resolve(process.cwd(), 'data/metro')
      const metroDest = join(dist, 'data', 'metro')
      if (existsSync(metroSrc)) {
        mkdirSync(join(dist, 'data'), { recursive: true })
        cpSync(metroSrc, metroDest, {
          recursive: true,
          filter: (src) => !src.split(/[/\\]/).includes('_cache'),
        })
      }
      // Highway networks (data/highway) mirror the metro layout — copy them too.
      const highwaySrc = resolve(process.cwd(), 'data/highway')
      if (existsSync(highwaySrc)) {
        mkdirSync(join(dist, 'data'), { recursive: true })
        cpSync(highwaySrc, join(dist, 'data', 'highway'), {
          recursive: true,
          filter: (src) => !src.split(/[/\\]/).includes('_cache'),
        })
      }

      const skillsRoot = resolve(process.cwd(), '.claude/skills')
      const skillsDest = join(dist, 'skills')
      mkdirSync(skillsDest, { recursive: true })
      const skills = listSkills(skillsRoot)
      writeFileSync(join(skillsDest, 'index.json'), JSON.stringify(skills))
      for (const { id } of skills) {
        cpSync(join(skillsRoot, id, 'SKILL.md'), join(skillsDest, `${id}.md`))
      }

      // 系統介紹（/slides）：純靜態頁，不需要 Vite 打包，直接照抄進 dist。
      const slidesSrc = resolve(process.cwd(), 'slides')
      if (existsSync(slidesSrc)) cpSync(slidesSrc, join(dist, 'slides'), { recursive: true })
    },
  }
}

export default defineConfig({
  base: pages ? '/adapt-metro/' : '/',
  plugins: [vue(), serveDataDir(), serveSkills(), llmAlignTrigger(), llmGridTrigger(), llmEvalTrigger(), copyStaticAssets()],
  server: {
    port: 5173,
  },
})
