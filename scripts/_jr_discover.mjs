import { query } from './overpass.mjs'
const q = `[out:json][timeout:180];
(
  relation["route"="train"]["name"~"山手線|大阪環状線"];
  relation["route_master"="train"]["name"~"山手線|大阪環状線"];
);
out tags;`
const r = await query(q, { cacheName: 'jr_discover.json' })
for (const e of r.elements) {
  const t = e.tags || {}
  console.log(e.type, e.id, '| route:', t.route||t.route_master, '| ref:', t.ref,
    '| name:', t.name, '| name:en:', t['name:en'], '| colour:', t.colour, '| operator:', t.operator)
}
console.log('total:', r.elements.length)
