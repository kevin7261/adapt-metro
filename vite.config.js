import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import {
  createReadStream, existsSync, statSync, readdirSync, readFileSync,
  cpSync, mkdirSync, writeFileSync, rmSync,
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

// Serve the static 系統介紹 slides (slides/index.html) at /slides/* in dev & preview.
// Without this the dev server has no route for it, so /slides/ falls through to the
// SPA fallback and loads the app instead of the slides — the slides only appeared in
// production because the build copies slides/ → dist/slides/ as real files. Tolerates
// the optional /adapt-metro base prefix (GITHUB_PAGES=1) since vite does not strip it
// before these middlewares.
function serveSlides() {
  const root = resolve(process.cwd(), 'slides')
  const handler = (req, res, next) => {
    if (!req.url) return next()
    const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/adapt-metro/, '')
    const m = p.match(/^\/slides(\/.*)?$/)
    if (!m) return next()
    let rel = (m[1] || '/').replace(/^\/+/, '')
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'
    const file = normalize(join(root, rel))
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()
    const types = {
      html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
      json: 'application/json', png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    }
    const ext = file.split('.').pop().toLowerCase()
    res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  }
  return {
    name: 'serve-slides',
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
      const { key, outFile, prompt, userPrompt, seedFrom, resetOut } = v
      if (jobs.get(key)?.exit === null) {
        res.statusCode = 409
        res.end(JSON.stringify({ running: true }))
        return
      }
      // Seed the result file from the currently-displayed layout BEFORE the run,
      // so the skill starts optimizing from it (LLM 對齊「以目前顯示的佈局為主」):
      //   resetOut → 清掉 outFile（base=hc，從 Hill Climbing 重新起）
      //   seedFrom → 把顯示的那份結果檔複製進 outFile（base=auto/prompt）
      // fingerprint 不符時 skill 端會自動忽略、退回 HC，所以這裡不需驗證。
      try {
        const outAbs = join(root, outFile)
        if (resetOut) {
          if (existsSync(outAbs)) rmSync(outAbs)
        } else if (seedFrom) {
          const srcAbs = join(root, seedFrom)
          if (existsSync(srcAbs)) {
            mkdirSync(join(root, 'data/metro/llmviews'), { recursive: true })
            cpSync(srcAbs, outAbs)
          } else if (existsSync(outAbs)) {
            rmSync(outAbs) // 顯示的那份還沒存檔 → 當作從 HC 起
          }
        }
      } catch { /* seeding is best-effort; skill falls back to HC on mismatch */ }
      const cmd = process.env[spec.cmdEnv] ?? 'claude'
      // Optional model pick from the panel dropdown: an allow-listed short key →
      // the real model id passed to `claude --model`. 'default' / missing / any
      // unknown value omits the flag, so the user's own Claude Code default runs
      // (the prior behaviour). Keys mirror the panel's <select>.
      const MODELS = {
        opus: { id: 'claude-opus-4-8', name: 'Opus 4.8' },
        fable: { id: 'claude-fable-5', name: 'Fable 5' },
        sonnet: { id: 'claude-sonnet-5', name: 'Sonnet 5' },
        haiku: { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
      }
      const pick = MODELS[body?.model]
      const modelId = pick?.id
      // When a model is forced, tell the skill what name to record in its result
      // file's `model` field, so the tab badge matches the dropdown rather than
      // whatever the model guesses about itself.
      const runPrompt = pick
        ? `${prompt}\n\n本次由指定模型執行，請在結果檔的 model 欄一律填「${pick.name}」。`
        : prompt
      // stream-json (needs --verbose in print mode) emits one JSON event per
      // line as the run unfolds — so we can surface the model's replies live
      // instead of only its final text. A stub command (spec.cmdEnv) that
      // prints plain lines still works: unparseable lines fall back to raw text.
      // 跨距上限（SPAN_CAP）：網頁把「已套用」的最大跨距隨 /run body 送來，這裡經
      // env 傳給 headless run 裡模型執行的 node 腳本（llmAlign/llmGrid/llmEval.mjs
      // 讀 LLM_SPAN_CAP）——兩邊用同一個跨距，縮減網格尺寸（fingerprint 的 cols/rows）
      // 才會一致；不傳＝腳本用預設 3（手動 CLI 跑也是 3）。
      const spanCap = Math.min(99, Math.max(1, Math.round(+body?.span) || 3))
      const startedAt = Date.now() // 量測執行時間（spawn→close）寫進結果檔供面板顯示
      const child = spawn(cmd, [
        '-p', runPrompt,
        ...(modelId ? ['--model', modelId] : []),
        '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Bash(node:*),Read,Write,Glob,Grep,Skill',
      ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LLM_SPAN_CAP: String(spanCap) } })
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
            j.elapsedMs = Date.now() - startedAt // 執行時間（毫秒），面板顯示在模型下面
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
      // kind: 'auto'＝自動對齊（純最大化 H/V，寫 .json，餵下游）；'prompt'＝指定
      // 對齊（依使用者一句話，寫 .prompt.json，只在主視圖比較用）。兩者結果檔、
      // job key 完全分開，互不覆蓋、互不影響。
      const kind = b.kind === 'prompt' ? 'prompt' : 'auto'
      const suffix = kind === 'prompt' ? '.prompt' : ''
      const outFile = `data/metro/llmviews/${b.city}.${b.variant}${suffix}.json`
      // base＝「LLM 對齊主視圖目前顯示的佈局」（hc/auto/prompt）。每次執行都以它為
      // 起點（使用者裁決「以目前顯示的為主」）——handler 在 spawn 前把顯示的那份檔
      // seed 進 outFile：base=auto/prompt → 複製該檔；base=hc → 清掉 outFile 從 HC 起。
      // base 就是本 kind 自己（顯示的正是自己）→ 不動、接著自己 refine。
      const base = ['auto', 'prompt', 'hc'].includes(b.base) ? b.base : 'hc'
      const baseFile = base === 'auto' ? `data/metro/llmviews/${b.city}.${b.variant}.json`
        : base === 'prompt' ? `data/metro/llmviews/${b.city}.${b.variant}.prompt.json` : null
      const seedFrom = (baseFile && baseFile !== outFile) ? baseFile : null
      const resetOut = base === 'hc'
      // Optional user steering: a free-text instruction typed in the panel that
      // biases which coordinates the model moves (e.g.「優先把紅線拉成水平」).
      // 2000: LLM評價的「執行評價結果」會把建議＋逐線評語整段餵進來（>1000 字）。
      const userPrompt = typeof b.userPrompt === 'string' ? b.userPrompt.trim().slice(0, 2000) : ''
      // 注意：key 不可依賴 userPrompt——status 輪詢的 GET 不帶 userPrompt，若這裡
      // 因空 prompt 回 null 會導致指定對齊的狀態查不到 job。空指示的防護交給前端
      // （按鈕在 !prompt 時 disable），這裡只負責產出穩定的 key/outFile。
      return {
        key: `${b.city}.${b.variant}.${kind}`,
        outFile,
        seedFrom,   // handler 在 spawn 前把這份檔複製進 outFile（起點＝目前顯示）
        resetOut,   // base=hc → spawn 前清掉 outFile，從 Hill Climbing 重新起
        userPrompt,
        prompt: `使用 route-llm-align skill：幫城市 ${b.city}（變體 ${b.variant}）產生或更新`
          + (kind === 'prompt'
            ? `「指定對齊」結果——export／apply 一律加 --prompt 旗標，寫到 ${b.city}.${b.variant}.prompt.json（不要動 .json 的自動對齊結果）。`
            : '「自動對齊」結果（寫 .json）。')
          + '起點佈局已由系統 seed 好（＝主視圖目前顯示的佈局）——直接 export 讀現有 outFile 內容當起點、接著往下 refine 即可，不要自己重設起點。'
          + '反覆 export → 分析 → apply 迭代到收斂（上限 10 輪）；每輪 moves.json 都要含 model 與 note（本輪思路），'
          + '第一輪另附 prompt 欄位記錄本段指示。完成後只輸出最終的 水平垂直 before → after 數字與一句總結。'
          + (userPrompt ? `\n\n使用者的指示（請據此決定要移動哪些座標、往哪對齊）：${userPrompt}` : ''),
      }
    },
  })
}

// LLM 互動（RWD Maps「AI 改網格長寬」）：使用者的一句話 → route-llm-grid 推理
// 每個 X 欄／Y 列區間的顯示權重 → data/metro/llmgrids，「LLM互動」tab 載入
// （跑完不自動套用，按「執行調整」才重畫 RWD 路網）。
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
          + '（export 讀佈局幾何 → 寫評價＋moves → apply 存檔）。評價不修改佈局；'
          + '評語要用站名與數字落地（哪條線哪一段可以更直/更水平、彎在哪、怎麼更方正），'
          + '並把每條建議轉成具體 moves（export 的 verts 索引 → 目標格），apply 會過硬規則、'
          + '把調整後佈局存進結果檔供網頁「執行調整」一鍵切換。'
          + '完成後只輸出一句總結（總評第一句＋執行調整的 H/V 前後數字）。'
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
  plugins: [vue(), serveDataDir(), serveSkills(), serveSlides(), llmAlignTrigger(), llmGridTrigger(), llmEvalTrigger(), copyStaticAssets()],
  server: {
    port: 5173,
  },
})
