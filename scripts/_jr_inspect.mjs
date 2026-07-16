import { query } from './overpass.mjs'
async function inspect(name, ids){
  const q = `[out:json][timeout:180];
rel(id:${ids.join(',')})->.r;
.r out body;
node(r.r);
out body;`
  const r = await query(q, { cacheName: `jr_inspect_${name}.json` })
  const nodes = new Map()
  for (const e of r.elements) if (e.type==='node') nodes.set(e.id, e)
  for (const e of r.elements) if (e.type==='relation') {
    const stops = e.members.filter(m=>m.type==='node' && /stop/.test(m.role))
    console.log(`\n[${name}] rel ${e.id} "${e.tags.name}" ref=${e.tags.ref} colour=${e.tags.colour}`)
    console.log(`  members: ${e.members.length}, node-stop members: ${stops.length}`)
    console.log('  first 6 stops:', stops.slice(0,6).map(m=>{
      const n=nodes.get(m.ref); return (n?.tags?.name||'?')+`(${n?.tags?.ref||''})`
    }).join(' , '))
    // roles present
    const roles={}; for(const m of e.members) roles[m.type+':'+m.role]=(roles[m.type+':'+m.role]||0)+1
    console.log('  role histogram:', JSON.stringify(roles))
  }
}
await inspect('yamanote', [1972960,1972920])
await inspect('osaka', [10073683,10073682])
