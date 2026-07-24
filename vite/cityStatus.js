// 世界地圖分頁圓點顏色的資料來源：/data/metro/city_status.json（{ id: boolean }）。
//   dev／preview：每次請求即時從磁碟計算（重烤 cells 後立刻反映＝即時更新）。
//   build：closeBundle 時算一次寫進 dist（本番無 server，取建置當下快照）。
// 必須排在 serveDataDir() 之前，才能攔截這個路徑（dev 沒有實體檔）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { computeCityStatus } from './cityStatusCompute.js'

const URL_PATH = '/data/metro/city_status.json'

export function cityStatus() {
  const root = process.cwd()
  const handler = (req, res, next) => {
    if ((req.url ?? '').split('?')[0] !== URL_PATH) return next()
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-cache')
    try {
      res.end(JSON.stringify({ status: computeCityStatus(root) }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err?.message ?? err) }))
    }
  }
  return {
    name: 'city-status',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
    // 本番快照：dist/data/metro/city_status.json
    closeBundle() {
      try {
        const dest = resolve(root, 'dist', 'data', 'metro')
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, 'city_status.json'), JSON.stringify({ status: computeCityStatus(root) }))
      } catch { /* dist 尚未建立時略過 */ }
    },
  }
}
