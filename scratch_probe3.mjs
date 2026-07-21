import { query } from './scripts/overpass.mjs'
// major Tokyo private railways: filter route=train by operator, tags only (light)
const q = `[out:json][timeout:120];
relation["type"="route"]["route"="train"]["operator"~"東急|京王|小田急|西武|東武|京成|京浜急行|相鉄|相模鉄道|つくば"](35.54,139.56,35.84,140.01);
out tags;`
const res = await query(q, { cacheName: 'probe_tokyo_priv.json' })
const byOp = new Map()
for (const e of res.elements) {
  const t = e.tags || {}
  const op = t.operator || '(none)'
  if (!byOp.has(op)) byOp.set(op, [])
  byOp.get(op).push({ id: e.id, name: t.name, ref: t.ref, col: t.colour, master: t.route_master })
}
for (const [op, rels] of byOp) {
  console.log(`\n${op} (${rels.length}):`)
  for (const r of rels.slice(0, 8)) console.log('  ', r.id, '|', r.ref, '|', r.name, '|', r.col)
}
console.log('\ntotal', res.elements.length, 'operators', byOp.size)
