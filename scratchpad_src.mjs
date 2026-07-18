import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { computeCityRwdViews } from './src/stores/viewGeometry.js'
import { buildRwdMap } from './src/stores/rwdMap.js'
function dirs(pts){const o=[];for(let i=0;i+1<pts.length;i++){const dx=Math.abs(pts[i+1][0]-pts[i][0]),dy=Math.abs(pts[i+1][1]-pts[i][1]);let d='X';if(dy<0.75)d='H';else if(dx<0.75)d='V';else if(Math.abs(dx-dy)<0.75)d='/';o.push(d)}return o}
function isForbidden(ds){if(!ds.includes('/'))return false;for(let i=0;i+1<ds.length;i++){const a=ds[i],b=ds[i+1];if((a==='H'&&b==='V')||(a==='V'&&b==='H'))return true}return false}
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.name.endsWith('.geojson')&&!e.name.endsWith('-lm.geojson'))out.push(p)}return out}
const files=await walk('data/metro/systems')
let withMerge={bad:0,routed:0,notRouted:0}, noMerge={bad:0}
const forbiddenExamples=[]
for(const f of files){
  let gj;try{gj=JSON.parse(await readFile(f,'utf8'))}catch{continue}
  globalThis.__CAP=[];try{computeCityRwdViews(gj)}catch{continue}
  if(!globalThis.__CAP.length)continue
  const cap=globalThis.__CAP[0];const{segsRaw,pos,opts}=cap
  const{x0,y0,sx,sy,nx,ny}=opts.lattice;const fx=2.6,fy=1
  const np=new Map();for(const[id,[x,y]]of pos)np.set(id,[x0+(x-x0)*fx,y0+(y-y0)*fy])
  const base={unit:Math.min(sx*fx,sy*fy)*2,lattice:{x0,y0,sx:sx*fx,sy:sy*fy,nx,ny}}
  globalThis.__CAP=null
  const rM=buildRwdMap(segsRaw,np,base)
  const rN=buildRwdMap(segsRaw,np,{...base,__noMerge:true})
  for(const L of rM.lines){const ds=dirs(L.pts);if(isForbidden(ds)){withMerge.bad++;if(L.routed)withMerge.routed++;else{withMerge.notRouted++;if(forbiddenExamples.length<20)forbiddenExamples.push(`${f.split('/').pop()} ${ds.join('')} routed=${!!L.routed} bends=${L.bends}`)}}}
  for(const L of rN.lines){const ds=dirs(L.pts);if(isForbidden(ds))noMerge.bad++}
}
console.log('WITH merge: forbidden lines=%d (A*/routed=%d, from candidates/notRouted=%d)',withMerge.bad,withMerge.routed,withMerge.notRouted)
console.log('NO merge:   forbidden lines=%d',noMerge.bad)
console.log('\nnon-A* forbidden examples (from candidates — these are the real bug):')
for(const e of forbiddenExamples)console.log('  '+e)
