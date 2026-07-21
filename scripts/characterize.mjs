#!/usr/bin/env node
// Characterization smoke：鎖住台北 viewGeometry 輸出形狀，重構時防回歸。
// 用法：node scripts/characterize.mjs
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeCityViews, computeCityHcViews, computeCityRwdViews,
  HC_VIEW_ORDER, RWD_VIEW_ORDER,
} from '../src/stores/viewGeometry.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const geo = JSON.parse(readFileSync(
  resolve(root, 'data/metro/systems/asia/taiwan/as-twn-taipei.geojson'), 'utf8'))

const views = computeCityViews(geo, { W: 200, H: 150 })
const hc = computeCityHcViews(geo, { W: 200, H: 150 })
const rwd = computeCityRwdViews(geo, { W: 200, H: 150 })

const expect = {
  views: 8,
  hc: 22,
  rwd: 36,
  hcOrder: HC_VIEW_ORDER.length,
  rwdOrder: RWD_VIEW_ORDER.length,
}
const got = {
  views: Object.keys(views.views).length,
  hc: Object.keys(hc.views).length,
  rwd: Object.keys(rwd.views).length,
  hcOrder: expect.hcOrder,
  rwdOrder: expect.rwdOrder,
}

const fails = []
for (const k of Object.keys(expect)) {
  if (got[k] !== expect[k]) fails.push(`${k}: got ${got[k]}, expect ${expect[k]}`)
}
// 每個視圖至少要有 lines 或 dots（空幾何＝演算法回歸）
for (const [id, v] of Object.entries(views.views)) {
  if (!(v.lines?.length || v.dots?.length)) fails.push(`views.${id} empty`)
}
for (const [id, v] of Object.entries(hc.views)) {
  if (!(v.lines?.length || v.dots?.length)) fails.push(`hc.${id} empty`)
}
for (const [id, v] of Object.entries(rwd.views)) {
  if (!(v.lines?.length || v.dots?.length)) fails.push(`rwd.${id} empty`)
}

if (fails.length) {
  console.error('characterize FAILED:')
  for (const f of fails) console.error(' -', f)
  process.exit(1)
}
console.log('characterize OK', got)
