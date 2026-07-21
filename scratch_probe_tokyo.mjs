import { query } from './scripts/overpass.mjs'
// route=train relations intersecting Tokyo core bbox, grouped by operator/network
const q = `[out:json][timeout:180];
relation["type"="route"]["route"="train"](35.54,139.56,35.84,140.01);
out tags;`
const res = await query(q, { cacheName: 'probe_tokyo_train.json' })
const byOp = new Map()
for (const e of res.elements) {
  const t = e.tags || {}
  const op = t.operator || t.network || '(none)'
  if (!byOp.has(op)) byOp.set(op, { n: 0, master: 0, ex: [] })
  const g = byOp.get(op); g.n++
  if (g.ex.length < 2) g.ex.push(t.name || t.ref || e.id)
}
const rows = [...byOp.entries()].sort((a,b)=>b[1].n-a[1].n)
for (const [op,g] of rows) console.log(String(g.n).padStart(3), op, '  e.g.', g.ex.join(' / '))
console.log('total relations', res.elements.length, '| operators', byOp.size)
