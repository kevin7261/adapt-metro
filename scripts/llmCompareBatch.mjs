// 全球 RWD Maps LLM 比較批次——每城一次選出全體／原始／旋轉最佳，
// 寫入 data/metro/llmcompares/<city>.json（與 route-llm-compare / llmCompare.mjs
// apply 同格式）。評分＝skill 準則的可重現啟發式（forced/fallback 最重、再比
// 直線率／轉折／平衡／共線）；已有結果且 fingerprint 相符則跳過。
//
//   node scripts/llmCompareBatch.mjs
//   node scripts/llmCompareBatch.mjs --force
//   node scripts/llmCompareBatch.mjs as-twn-taipei
//   node scripts/llmCompareBatch.mjs --limit 20
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DATA = join(ROOT, 'data', 'metro')
const OUT = join(DATA, 'llmcompares')
const MODEL = 'batch-metric'

const args = process.argv.slice(2)
const force = args.includes('--force')
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? Math.max(1, +args[limitIdx + 1] || 0) : 0
const onlyCity = args.find((a, i) => !a.startsWith('--') && !(limitIdx >= 0 && i === limitIdx + 1))

function score(c) {
  const g = c.geometry
  // forced / fallback 最優先避免；再比直線率、轉折、平衡、共線（同 skill）。
  return (
    -(g.forced ?? 0) * 100_000
    - (g.fallback ?? 0) * 50_000
    + (g.straightness ?? 0) * 10_000
    - (g.bends ?? 0) * 20
    + (g.balance ?? 0) * 100
    - (g.colinear ?? 0) * 50
    - (g.multiBend ?? 0) * 5
    - (g.doubleBend ?? 0) * 2
    - (g.singleBend ?? 0) * 0.5
  )
}

function bestOf(list) {
  if (!list.length) return null
  return [...list].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0]
}

function pointsFor(c, role) {
  const g = c.geometry
  const pros = []
  const cons = []
  if ((g.forced ?? 0) === 0 && (g.fallback ?? 0) === 0) pros.push('無 forced／fallback 硬失敗。')
  else {
    if (g.forced) cons.push(`殘留衝突 forced ${g.forced}。`)
    if (g.fallback) cons.push(`兜底 fallback ${g.fallback}。`)
  }
  pros.push(`直線 ${g.straight}/${g.segments}（直線率 ${(g.straightness * 100).toFixed(1)}%）。`)
  pros.push(`轉折 ${g.bends}（單折 ${g.singleBend}／雙折 ${g.doubleBend}／多折 ${g.multiBend}）。`)
  if (g.balance >= 0.9) pros.push(`畫面平衡 ${(g.balance * 100).toFixed(0)}%。`)
  else cons.push(`畫面平衡偏低（${(g.balance * 100).toFixed(0)}%）。`)
  if (g.colinear) cons.push(`共線重疊 ${g.colinear}。`)
  if (role === 'weak') {
    // 非優勝者多寫一點缺點錨點
    if (!cons.length) cons.push('指標未居同組之首。')
  }
  if (!pros.length) pros.push('幾何指標可讀。')
  if (!cons.length) cons.push('仍有可再壓轉折或提高直線率的空間。')
  return { strengths: pros.slice(0, 4), weaknesses: cons.slice(0, 3) }
}

function reasonFor(c, scope) {
  const g = c.geometry
  return [
    `${scope}選 ${c.label}：直線率 ${(g.straightness * 100).toFixed(1)}%、轉折 ${g.bends}、平衡 ${(g.balance * 100).toFixed(0)}%。`,
    `forced ${g.forced}／fallback ${g.fallback}／共線 ${g.colinear}。`,
    `格網 ${c.grid.cols}×${c.grid.rows}。`,
  ]
}

function exportCity(cityId) {
  const r = spawnSync(process.execPath, [join(__dirname, 'llmCompare.mjs'), 'export', cityId], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `export exit ${r.status}`).trim().slice(0, 400))
  }
  // export 可能夾雜 warn 行——取最後一個可 parse 的 JSON 物件
  const text = (r.stdout || '').trim()
  const start = text.indexOf('{')
  if (start < 0) throw new Error('export 無 JSON')
  return JSON.parse(text.slice(start))
}

async function runOne(cityId) {
  const outFile = join(OUT, `${cityId}.json`)
  const exported = exportCity(cityId)
  const { candidates, fingerprint } = exported
  if (!candidates?.length) throw new Error('無候選')

  if (!force && existsSync(outFile)) {
    try {
      const saved = JSON.parse(await readFile(outFile, 'utf8'))
      if (JSON.stringify(saved.fingerprint) === JSON.stringify(fingerprint)) {
        return { skip: true, reason: 'exists' }
      }
    } catch { /* rebuild */ }
  }

  const orig = candidates.filter((c) => c.variant === 'orig')
  const rot = candidates.filter((c) => c.variant === 'rot')
  const winnerOrig = bestOf(orig)
  const winnerRot = bestOf(rot)
  const winner = bestOf(candidates)
  if (!winner || !winnerOrig || !winnerRot) throw new Error('無法選出三個最佳')

  const analyses = candidates.map((c) => {
    const isWin = c.id === winner.id || c.id === winnerOrig.id || c.id === winnerRot.id
    return { id: c.id, ...pointsFor(c, isWin ? 'strong' : 'weak') }
  })

  const summary = [
    `共 ${candidates.length} 個候選（原始 ${orig.length}／旋轉 ${rot.length}）。`,
    `全體最佳 ${winner.label}；原始最佳 ${winnerOrig.label}；旋轉最佳 ${winnerRot.label}。`,
    '依 forced／fallback → 直線率 → 轉折 → 平衡 → 共線 排序選出（batch-metric）。',
  ]

  await mkdir(OUT, { recursive: true })
  await writeFile(outFile, JSON.stringify({
    city: cityId,
    fingerprint,
    model: MODEL,
    candidates,
    analyses,
    winner: winner.id,
    winnerOrig: winnerOrig.id,
    winnerRot: winnerRot.id,
    winnerReason: reasonFor(winner, '全體最佳'),
    winnerOrigReason: reasonFor(winnerOrig, '原始最佳'),
    winnerRotReason: reasonFor(winnerRot, '旋轉最佳'),
    summary,
  }))
  return {
    skip: false,
    winner: winner.id,
    winnerOrig: winnerOrig.id,
    winnerRot: winnerRot.id,
  }
}

async function main() {
  const viewFiles = (await readdir(join(DATA, 'views')))
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
  const cities = onlyCity ? viewFiles.filter((c) => c === onlyCity) : viewFiles
  if (onlyCity && !cities.length) {
    console.error(`找不到城市 ${onlyCity}`)
    process.exit(1)
  }

  let done = 0, skipped = 0, failed = 0
  const t0 = Date.now()
  for (const c of cities) {
    if (limit && done >= limit) break
    try {
      const r = await runOne(c)
      if (r.skip) {
        skipped++
        continue
      }
      done++
      console.log(`✓ ${c}  all=${r.winner}  orig=${r.winnerOrig}  rot=${r.winnerRot}`)
    } catch (err) {
      failed++
      console.error(`✗ ${c}  ${err?.message ?? err}`)
    }
  }
  console.log(`\n完成：寫入 ${done}、跳過 ${skipped}、失敗 ${failed}／共 ${cities.length}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
}

main().catch((e) => { console.error(e); process.exit(1) })
