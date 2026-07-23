// 全球重算暫停——metroRecompute 寫入暫停檔，bake／views 每城之間檢查。
// 檔案：專案根 .metro-recompute-pause（存在＝暫停；刪除＝繼續）
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const PAUSE_FILE = join(process.cwd(), '.metro-recompute-pause')

/** 若暫停檔存在則每 400ms 輪詢，直到被刪除。回傳是否曾進入暫停。 */
export async function waitIfPaused() {
  if (!existsSync(PAUSE_FILE)) return false
  console.log('PAUSED')
  while (existsSync(PAUSE_FILE)) await sleep(400)
  console.log('RESUMED')
  return true
}
