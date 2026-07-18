import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { computeCityRwdViews } from './src/stores/viewGeometry.js'
import { buildRwdMap } from './src/stores/rwdMap.js'
function dirs(pts){const o=[];for(let i=0;i+1<pts.length;i++){const dx=Math.abs(pts[i+1][0]-pts[i][0]),dy=Math.abs(pts[i+1][1]-pts[i][1]);let d='X';if(dy<0.75)d='H';else if(dx<0.75)d='V';else if(Math.abs(dx-dy)<0.75)d='/';o.push(d)}return o}
// forbidden: sequence contains a '/' (45) AND somewhere an axis-adjacent-different-axis (H next to V) right angle
function isForbidden(ds){
  const has45=ds.includes('/')
  if(!has45)return false
  for(let i=0;i+1<ds.length;i++){const a=ds[i],b=ds[i+1];if((a==='H'&&b==='V')||(a==='V'&&b==='H'))return true}
  return false
}
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.name.endsWith('.geojson')&&!e.name.endsWith('-lm.geojson'))out.push(p)}return out}
function analyze(f,fx,fy){
  globalThis.__CAP=[]
  const gj=JSON.parse(f)
  computeCityRwdViews(gj)
  const cap=globalThis.__CAP[0];const{segsRaw,segs,pos,opts}=cap
  const{x0,y0,sx,sy,nx,ny}=opts.lattice
  const np=new Map();for(const[id,[x,y]]of pos)np.set(id,[x0+(x-x0)*fx,y0+(y-y0)*fy])
  const latOpt={unit:Math.min(sx*fx,sy*fy)*2,lattice:{x0,y0,sx:sx*fx,sy:sy*fy,nx,ny}}
  globalThis.__CAP=null
  const r=buildRwdMap(segsRaw,np,latOpt) // internally merges
  const bad=[]
  for(const L of r.lines){const ds=dirs(L.pts);if(isForbidden(ds))bad.push(ds.join(''))}
  return {segs:r.stats.segs, bad}
}
// Taipei detail
const tp=await readFile('data/metro/systems/asia/taiwan/as-twn-taipei.geojson','utf8')
for(const[fx,fy]of[[1,1],[2.6,1],[3.5,0.8]]){
  const a=analyze(tp,fx,fy)
  console.log(`Taipei fx=${fx}: forbidden(45+右角) lines=${a.bad.length}`, a.bad.slice(0,10))
}
// broad
const files=await walk('data/metro/systems')
let totBad=0,cityBad=0
for(const f of files){let s;try{s=await readFile(f,'utf8')}catch{continue}
  let a;try{a=analyze(s,2.6,1)}catch{continue}
  if(a.bad.length){cityBad++;totBad+=a.bad.length;if(cityBad<=15)console.log(`  ${f.split('/').pop()}: ${a.bad.length} forbidden`, a.bad.slice(0,3))}}
console.log(`\nBROAD (wide 2.6x): cities with forbidden shapes=${cityBad}/${files.length}, total forbidden lines=${totBad}`)
