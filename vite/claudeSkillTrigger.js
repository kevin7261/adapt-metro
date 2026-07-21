import {
  createReadStream, existsSync, readFileSync,
  cpSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { LLM_MODELS } from './llmModels.js'

export function claudeSkillTrigger(spec) {
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
      const pick = LLM_MODELS[body?.model]
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
