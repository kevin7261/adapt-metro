// 成方餵 HC（shape-feeds-HC）在 CLI 腳本端的鏡像——llmEval.mjs／llmGrid.mjs 共用。
//
// 為什麼需要：D3Tab 的 RWD 管線在「⑨LLM 成方已成方（square===true）且套用中」時，
// 下游鏈（論文後處理 → movewise 循環）吃的是**成方後的佈局**、並以 setFrozen 凍結
// 成方頂點（見 bakeHcCells.mjs 的同段落與 memory llmshape-freeze-square）。CLI 腳本
// 若仍從 grid.cellOf（格網化後）起算，壓縮出的網格尺寸（fingerprint 的 cols/rows）
// 就與網頁**永遠不同**（東京 JR stroke：網頁 20×15 vs CLI 22×18）——評價/互動一產生
// 就 stale、重跑也治不好。這裡把成方段落抽成共用，兩端同一條管線。
//
// 開關（與 LLM_SPAN_CAP 同機制，vite trigger 依網頁當下狀態經 env 傳入）：
//   LLM_SHAPE_FEED=1 → 強制開（網頁成方套用中）
//   LLM_SHAPE_FEED=0 → 強制關（網頁成方被關掉／恢復）
//   未設（手動 CLI）→ 自動：成方檔存在且 square===true 就開——與網頁預設一致
//   （square 成功時 shapeLlmApplied 預設 true，見 D3Tab）。
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setFrozen } from '../src/stores/hillClimb.js'
import { applyShapeGreens } from '../src/stores/paper/shape.js'
import { getShapePresets } from '../src/stores/paper/shapePresets.js'

// 成方護欄成員：規定 ring 站＋綠折點＋成方路線邊上所有站（同 bakeHcCells expandMembers）
function expandMembers(skeleton, preset, greens) {
  const out = new Set([...(preset.stations ?? []), ...greens.map((g) => g.id)])
  if (preset.routeId && skeleton.edges) {
    for (const e of skeleton.edges) {
      if (e.routes?.has(preset.routeId)) for (const id of e.path) out.add(id)
    }
  }
  return out
}

/**
 * 依成方狀態決定下游鏈的起點佈局與凍結護欄（會呼叫 setFrozen 設定全域護欄）。
 * @param {string} DATA data/metro 絕對路徑
 * @param {string} cityId
 * @param {'orig'|'rot'} variant
 * @param {object} skeleton buildConnectSkeleton 的結果
 * @param {Map} gridBase grid.cellOf（格網化後佈局）
 * @returns {{skeleton, baseCells, shapeOn: boolean}} 成方開＝{成方骨架, 成方佈局, true}；關＝原樣
 */
export async function applyShapeFeed(DATA, cityId, variant, skeleton, gridBase) {
  const mode = process.env.LLM_SHAPE_FEED // '1' | '0' | undefined（自動）
  const off = () => { setFrozen(null); return { skeleton, baseCells: gridBase, shapeOn: false } }
  if (mode === '0') return off()
  const p = join(DATA, 'straighten-shape', `${cityId}.${variant}.json`)
  if (!existsSync(p)) return off()
  let shape
  try { shape = JSON.parse(await readFile(p, 'utf8')) } catch { return off() }
  if (shape.square !== true) return off() // 成方沒跑出來＝網頁也不餵
  const greens = shape.greens ?? []
  const sk = greens.length ? applyShapeGreens(skeleton, greens) : skeleton
  const baseCells = new Map(shape.cellAfter.map(([id, c, r]) => [id, [c, r]]))
  const presets = getShapePresets(cityId) ?? []
  if (presets.length) {
    // 同 D3Tab：ring 站集＝全部環的 stations 聯集；members 逐環累積聯集
    const ringIds = presets.flatMap((pp) => pp.stations ?? [])
    const frozen = new Set([...ringIds, ...greens.map((g) => g.id)])
    for (const pp of presets) for (const id of expandMembers(sk, pp, greens)) frozen.add(id)
    setFrozen({ ringIds, members: frozen })
  } else setFrozen(null)
  return { skeleton: sk, baseCells, shapeOn: true }
}
