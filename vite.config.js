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

// LLM 對齊 on-demand trigger (dev only): the「開始 LLM 對齊」button POSTs here
// and we spawn a HEADLESS Claude Code session (`claude -p …`) that runs the
// route-llm-align skill for that city/variant — no API key, the user's own
// Claude Code does the work. The page polls /llm-align/status and reloads the
// llmview when the run finishes. On GitHub Pages there is no dev server, so
// the button simply reports that a local `npm run dev` is required.
function llmAlignTrigger() {
  const root = process.cwd()
  const jobs = new Map() // "city.variant" -> { child, log, exit, prompt }
  const readBody = (req) => new Promise((ok) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok(null) } })
  })
  const handler = async (req, res, next) => {
    const p = (req.url ?? '').split('?')[0]
    if (!p.startsWith('/llm-align/')) return next()
    res.setHeader('Content-Type', 'application/json')
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')

    if (p === '/llm-align/status') {
      const job = jobs.get(`${q.get('city')}.${q.get('variant')}`)
      res.end(JSON.stringify(job
        ? {
            running: job.exit === null, exit: job.exit,
            tail: job.log.slice(-6).join('\n'),
            text: job.text.slice(-4000), // live assistant transcript (streamed)
          }
        : { running: false, exit: null, tail: '', text: '' }))
      return
    }
    if (p === '/llm-align/run' && req.method === 'POST') {
      const body = await readBody(req)
      const city = body?.city, variant = body?.variant
      if (!/^[\w-]+$/.test(city ?? '') || !['orig', 'rot'].includes(variant)) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'bad city/variant' }))
        return
      }
      const key = `${city}.${variant}`
      if (jobs.get(key)?.exit === null) {
        res.statusCode = 409
        res.end(JSON.stringify({ running: true }))
        return
      }
      const prompt = `使用 route-llm-align skill：幫城市 ${city}（變體 ${variant}）產生或更新 LLM 對齊結果。`
        + '反覆 export → 分析 → apply 迭代到收斂（上限 10 輪）；每輪 moves.json 都要含 model 與 note（本輪思路），'
        + '第一輪另附 prompt 欄位記錄本段指示。完成後只輸出最終的 水平垂直 before → after 數字與一句總結。'
      const cmd = process.env.LLM_ALIGN_CMD ?? 'claude'
      // stream-json (needs --verbose in print mode) emits one JSON event per
      // line as the run unfolds — so we can surface the model's replies live
      // instead of only its final text. A stub command (LLM_ALIGN_CMD) that
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
        // Merge the run's provenance into the llmview so the LLM對齊 panel can
        // show the prompt we sent and what the model answered.
        try {
          const f = join(root, 'data/metro/llmviews', `${city}.${variant}.json`)
          if (existsSync(f)) {
            const j = JSON.parse(readFileSync(f, 'utf8'))
            j.prompt = j.prompt ?? prompt
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
    name: 'llm-align-trigger',
    configureServer(server) { server.middlewares.use(handler) },
  }
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

      const skillsRoot = resolve(process.cwd(), '.claude/skills')
      const skillsDest = join(dist, 'skills')
      mkdirSync(skillsDest, { recursive: true })
      const skills = listSkills(skillsRoot)
      writeFileSync(join(skillsDest, 'index.json'), JSON.stringify(skills))
      for (const { id } of skills) {
        cpSync(join(skillsRoot, id, 'SKILL.md'), join(skillsDest, `${id}.md`))
      }
    },
  }
}

export default defineConfig({
  base: pages ? '/adapt-metro/' : '/',
  plugins: [vue(), serveDataDir(), serveSkills(), llmAlignTrigger(), copyStaticAssets()],
  server: {
    port: 5173,
  },
})
