// 專案另存／匯入——單一 JSON 含畫面 session＋各城 geojson＋straighten／LLM 結果，
// 匯入後可回復圖層鏈與佈局（不必重算）。格式 version 2。
import { assetUrl } from './assetUrl.js'
import { layerData, layerExport } from '../stores/layerData.js'
import { buildSnapshot, applySnapshot } from '../stores/persist.js'
import { setDataOverlay, clearDataOverlay } from './dataOverlay.js'
import { METRO_DIRS } from './metroDataPaths.js'
import { RWD_COMPACTS } from './rwdCompacts.js'

export const PROJECT_KIND = 'adapt-metro-project'
export const PROJECT_VERSION = 2

const VARIANTS = ['orig', 'rot', 'orig-shape', 'rot-shape']

async function tryFetchJson(rel) {
  try {
    const res = await fetch(assetUrl(rel), { cache: 'no-store' })
    const ct = res.headers.get('content-type') ?? ''
    if (!res.ok || !ct.includes('json')) return null
    return await res.json()
  } catch { return null }
}

function metroCityIds(store) {
  const ids = new Set()
  for (const l of store.layers) {
    if (l.type === 'metro' && !l.highway && !l.railway && l.id) ids.add(l.id)
  }
  return [...ids]
}

async function collectCityBundle(cityId, store) {
  const metro = store.layers.find((l) => l.id === cityId)
  const system = layerData[cityId]
    ?? (metro?.file ? await tryFetchJson(metro.file.replace(/^\//, '').replace(/^.*data\/metro\//, 'data/metro/')) : null)
    ?? null
  // layer.file 可能是 assetUrl 後的完整路徑
  let systemFc = system
  if (!systemFc && metro?.file) {
    try {
      const res = await fetch(metro.file, { cache: 'no-store' })
      if (res.ok) systemFc = await res.json()
    } catch { /* */ }
  }

  const cells = {}
  for (const v of VARIANTS) {
    for (const shapelike of [false, true]) {
      const rel = `data/metro/${METRO_DIRS.hccells}/${cityId}.${v}${shapelike ? '.shapelike' : ''}.json`
      const j = await tryFetchJson(rel)
      if (j) cells[`${v}${shapelike ? '.shapelike' : ''}`] = j
    }
  }

  const llmAlign = {}
  for (const v of ['orig', 'rot']) {
    for (const suffix of ['', '.prompt']) {
      const rel = `data/metro/${METRO_DIRS.llmviews}/${cityId}.${v}${suffix}.json`
      const j = await tryFetchJson(rel)
      if (j) llmAlign[`${v}${suffix}`] = j
    }
  }

  const llmShape = {}
  for (const v of ['orig', 'rot']) {
    const rel = `data/metro/${METRO_DIRS.llmshapes}/${cityId}.${v}.json`
    const j = await tryFetchJson(rel)
    if (j) llmShape[v] = j
  }

  const llmEval = {}
  const llmGrid = {}
  for (const v of VARIANTS) {
    for (const c of RWD_COMPACTS) {
      const ev = await tryFetchJson(`data/metro/${METRO_DIRS.llmevals}/${cityId}.${v}.${c}.json`)
      if (ev) llmEval[`${v}.${c}`] = ev
      const gr = await tryFetchJson(`data/metro/${METRO_DIRS.llmgrids}/${cityId}.${v}.${c}.json`)
      if (gr) llmGrid[`${v}.${c}`] = gr
    }
  }

  const llmCompare = await tryFetchJson(`data/metro/${METRO_DIRS.llmcompares}/${cityId}.json`)

  return {
    systemFile: metro?.file?.includes('data/metro/')
      ? metro.file.replace(/^.*data\/metro\//, 'data/metro/')
      : `data/metro/${METRO_DIRS.systems}/…/${cityId}.geojson`,
    system: systemFc,
    cells,
    llmAlign,
    llmShape,
    llmEval,
    llmGrid,
    llmCompare: llmCompare || undefined,
  }
}

/** 下載完整專案 JSON（另存） */
export async function downloadProject(store, { filename } = {}) {
  const cities = {}
  for (const id of metroCityIds(store)) {
    cities[id] = await collectCityBundle(id, store)
  }
  const exports = {}
  for (const l of store.layers) {
    if (layerExport[l.id]) exports[l.id] = layerExport[l.id]
  }
  const bundle = {
    kind: PROJECT_KIND,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    projectName: store.projectName || 'adapt-metro.project.json',
    session: buildSnapshot(store),
    layerExports: exports,
    cities,
  }
  const name = filename || store.projectName?.replace(/\.geolibre\.json$/, '.project.json') || 'adapt-metro.project.json'
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name.endsWith('.json') ? name : `${name}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return name
}

function seedCityOverlay(cityId, bundle) {
  if (!bundle) return
  if (bundle.system) {
    // 供 layerData 與追蹤路徑
    layerData[cityId] = bundle.system
  }
  for (const [key, j] of Object.entries(bundle.cells ?? {})) {
    const shapelike = key.endsWith('.shapelike')
    const v = shapelike ? key.replace(/\.shapelike$/, '') : key
    setDataOverlay(
      `data/metro/${METRO_DIRS.hccells}/${cityId}.${v}${shapelike ? '.shapelike' : ''}.json`,
      j,
    )
  }
  for (const [key, j] of Object.entries(bundle.llmAlign ?? {})) {
    setDataOverlay(`data/metro/${METRO_DIRS.llmviews}/${cityId}.${key}.json`, j)
  }
  for (const [v, j] of Object.entries(bundle.llmShape ?? {})) {
    setDataOverlay(`data/metro/${METRO_DIRS.llmshapes}/${cityId}.${v}.json`, j)
  }
  for (const [key, j] of Object.entries(bundle.llmEval ?? {})) {
    setDataOverlay(`data/metro/${METRO_DIRS.llmevals}/${cityId}.${key}.json`, j)
  }
  for (const [key, j] of Object.entries(bundle.llmGrid ?? {})) {
    setDataOverlay(`data/metro/${METRO_DIRS.llmgrids}/${cityId}.${key}.json`, j)
  }
  if (bundle.llmCompare) {
    setDataOverlay(`data/metro/${METRO_DIRS.llmcompares}/${cityId}.json`, bundle.llmCompare)
  }
}

/** 從專案 JSON 回復畫面（匯入） */
export async function importProject(store, bundle) {
  if (!bundle || bundle.kind !== PROJECT_KIND) {
    throw new Error('不是 adapt-metro 專案檔（缺 kind）')
  }
  clearDataOverlay('data/metro/')
  for (const [cityId, city] of Object.entries(bundle.cities ?? {})) {
    seedCityOverlay(cityId, city)
  }
  for (const [id, data] of Object.entries(bundle.layerExports ?? {})) {
    layerExport[id] = data
  }
  applySnapshot(store, bundle.session)
  if (bundle.projectName) store.projectName = bundle.projectName
  return {
    cities: Object.keys(bundle.cities ?? {}).length,
    layers: store.layers.length,
  }
}

export async function importProjectFile(store, file) {
  const text = await file.text()
  const bundle = JSON.parse(text)
  return importProject(store, bundle)
}
