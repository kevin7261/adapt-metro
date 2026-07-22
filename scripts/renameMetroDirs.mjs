// 一次性：把 data/metro/ 舊目錄名改成與圖層階段對齊的新名，並改寫 repo 內路徑字串。
//   node scripts/renameMetroDirs.mjs
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { METRO_DIRS } from '../src/lib/metroDataPaths.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const METRO = join(ROOT, 'data', 'metro')

const RENAMES = [
  ['systems', METRO_DIRS.systems],
  ['views', METRO_DIRS.views],
  ['straighten', METRO_DIRS.hcviews],
  ['rwd-maps', METRO_DIRS.rwdviews],
  ['hccells', METRO_DIRS.hccells],
  ['llmviews', METRO_DIRS.llmviews],
  ['llmshapes', METRO_DIRS.llmshapes],
  ['llmevals', METRO_DIRS.llmevals],
  ['llmgrids', METRO_DIRS.llmgrids],
  ['llmcompares', METRO_DIRS.llmcompares],
  ['tracks-center', METRO_DIRS.tracksCenter],
  ['tracks', METRO_DIRS.tracks],
  ['landmarks', METRO_DIRS.landmarks],
]

function sh(cmd) {
  console.log('>', cmd)
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
}

function renameDirs() {
  for (const [from, to] of RENAMES) {
    const a = join(METRO, from)
    const b = join(METRO, to)
    if (!existsSync(a)) {
      if (existsSync(b)) console.log(`skip ${from} (already ${to})`)
      else console.log(`skip ${from} (missing)`)
      continue
    }
    if (existsSync(b)) {
      console.warn(`WARN: both ${from} and ${to} exist — leave as-is`)
      continue
    }
    try {
      sh(`git mv "data/metro/${from}" "data/metro/${to}"`)
    } catch {
      sh(`mv "data/metro/${from}" "data/metro/${to}"`)
    }
  }
}

// 只改「路徑字面」——依長字串優先，避免 tracks 吃掉 tracks-center。
const REPLACEMENTS = [
  ['data/metro/metro-tracks-center/', `data/metro/${METRO_DIRS.tracksCenter}/`],
  ['data/metro/metro-tracks/', `data/metro/${METRO_DIRS.tracks}/`],
  ['data/metro/metro-landmarks/', `data/metro/${METRO_DIRS.landmarks}/`],
  ['data/metro/metro-maps/', `data/metro/${METRO_DIRS.systems}/`],
  ['data/metro/straighten/', `data/metro/${METRO_DIRS.hcviews}/`],
  ['data/metro/rwd-maps/', `data/metro/${METRO_DIRS.rwdviews}/`],
  ['data/metro/straighten-cells/', `data/metro/${METRO_DIRS.hccells}/`],
  ['data/metro/straighten-llm/', `data/metro/${METRO_DIRS.llmviews}/`],
  ['data/metro/straighten-shape/', `data/metro/${METRO_DIRS.llmshapes}/`],
  ['data/metro/rwd-llmeval/', `data/metro/${METRO_DIRS.llmevals}/`],
  ['data/metro/rwd-llmgrid/', `data/metro/${METRO_DIRS.llmgrids}/`],
  ['data/metro/rwd-compare/', `data/metro/${METRO_DIRS.llmcompares}/`],
  ['data/metro/map-adjust/', `data/metro/${METRO_DIRS.views}/`],
  // catalog 相對路徑（無 data/metro 前綴）
  ['"metro-maps/', `"${METRO_DIRS.systems}/`],
  ["'metro-maps/", `'${METRO_DIRS.systems}/`],
  ['`metro-maps/', `\`${METRO_DIRS.systems}/`],
  ['join(BASE, \'systems\')', `join(BASE, '${METRO_DIRS.systems}')`],
  ['join(BASE, "metro-maps")', `join(BASE, "${METRO_DIRS.systems}")`],
  ['join(DATA, \'llmviews\')', `join(DATA, '${METRO_DIRS.llmviews}')`],
  ['join(DATA, "straighten-llm")', `join(DATA, "${METRO_DIRS.llmviews}")`],
  ['join(BASE, \'views\')', `join(BASE, '${METRO_DIRS.views}')`],
  ['join(BASE, \'hcviews\')', `join(BASE, '${METRO_DIRS.hcviews}')`],
  ['join(BASE, \'rwdviews\')', `join(BASE, '${METRO_DIRS.rwdviews}')`],
  ["'straighten'", `'${METRO_DIRS.hcviews}'`],
  ['"straighten"', `"${METRO_DIRS.hcviews}"`],
  ["'rwd-maps'", `'${METRO_DIRS.rwdviews}'`],
  ['"rwd-maps"', `"${METRO_DIRS.rwdviews}"`],
  ["dataDir: 'map-adjust'", `dataDir: '${METRO_DIRS.views}'`],
  ['dataDir: "map-adjust"', `dataDir: "${METRO_DIRS.views}"`],
  ["DIR = 'data/metro/straighten-cells'", `DIR = 'data/metro/${METRO_DIRS.hccells}'`],
]

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.vue', '.md', '.json', '.html', '.css', '.txt', '.yml', '.yaml',
])
const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', '_cache',
  METRO_DIRS.systems, METRO_DIRS.tracks, METRO_DIRS.tracksCenter, METRO_DIRS.landmarks,
  METRO_DIRS.views, METRO_DIRS.hcviews, METRO_DIRS.rwdviews,
  // 巨型結果檔稍後用專用 rewrite；先改程式與 index
  METRO_DIRS.llmviews, METRO_DIRS.llmshapes, METRO_DIRS.llmcompares,
  METRO_DIRS.llmevals, METRO_DIRS.llmgrids, METRO_DIRS.hccells,
  'maps',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (TEXT_EXT.has(extname(name))) out.push(p)
  }
  return out
}

function rewriteFile(p) {
  let s = readFileSync(p, 'utf8')
  const orig = s
  for (const [a, b] of REPLACEMENTS) {
    if (s.includes(a)) s = s.split(a).join(b)
  }
  if (s !== orig) {
    writeFileSync(p, s)
    return true
  }
  return false
}

function rewriteIndexAndReports() {
  const files = [
    join(METRO, 'index.json'),
    join(METRO, 'README.md'),
    join(METRO, 'verify_report.json'),
    join(METRO, 'verify_report.md'),
    join(METRO, 'official_sites.json'),
    join(ROOT, 'README.md'),
  ]
  let n = 0
  for (const f of files) {
    if (existsSync(f) && rewriteFile(f)) {
      console.log('rewrote', f.replace(ROOT + '/', ''))
      n++
    }
  }
  return n
}

function rewriteGalleryFilePaths() {
  // 畫廊 JSON 內 "file": "metro-maps/..." → metro-maps/...
  let n = 0
  for (const dir of [METRO_DIRS.views, METRO_DIRS.hcviews, METRO_DIRS.rwdviews]) {
    const abs = join(METRO, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.json')) continue
      const p = join(abs, name)
      if (rewriteFile(p)) n++
    }
  }
  return n
}

renameDirs()
console.log('rewriting source/docs…')
let changed = 0
for (const p of walk(ROOT)) {
  if (rewriteFile(p)) {
    changed++
    console.log(' ', p.replace(ROOT + '/', ''))
  }
}
changed += rewriteIndexAndReports()
console.log('rewriting gallery file: fields…')
const g = rewriteGalleryFilePaths()
console.log(`done. source files touched≈${changed}, gallery files≈${g}`)
