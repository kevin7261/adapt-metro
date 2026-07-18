import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { computeCityRwdViews } from './src/stores/viewGeometry.js'
import { buildRwdMap } from './src/stores/rwdMap.js'
const T22=Math.tan(Math.PI/8)
function legDir(A,B){const dx=Math.abs(B[0]-A[0]),dy=Math.abs(B[1]-A[1]);if(dy<0.75)return'H';if(dx<0.75)return'V';if(Math.abs(dx-dy)<0.75)return'45';if(Math.abs(dy-T22*dx)<0.75)return'22';if(Math.abs(dx-T22*dy)<0.75)return'67';return'X'}
// end-to-end 全城 dirs=8
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.name.endsWith('.geojson')&&!e.name.endsWith('-lm.geojson'))out.push(p)}return out}
const files=await walk('data/metro/systems')
let ok=0,err=0
for(const f of files){try{const gj=JSON.parse(await readFile(f,'utf8'));const v=computeCityRwdViews(gj);if(v?.views&&Object.keys(v.views).length)ok++;else err++}catch{err++}}
console.log('end-to-end dirs=8:',ok+'/'+files.length,'err='+err)
// 16 方向測台北+紐約
for(const [f,city] of [['data/metro/systems/asia/taiwan/as-twn-taipei.geojson','台北'],['data/metro/systems/americas/united-states/am-usa-new-york-city.geojson','紐約']]){
  globalThis.__CAP=[]
  const gj=JSON.parse(await readFile(f,'utf8'));computeCityRwdViews(gj)
  const cap=globalThis.__CAP[0];globalThis.__CAP=null
  const{segs,pos,opts}=cap;const{x0,y0,sx,sy,nx,ny}=opts.lattice;const fx=2.6,fy=1
  const np=new Map();for(const[id,[x,y]]of pos)np.set(id,[x0+(x-x0)*fx,y0+(y-y0)*fy])
  for(const d of [8,16]){
    const r=buildRwdMap(segs,np,{__t:1,unit:Math.min(sx*fx,sy*fy)*2,dirs:d,lattice:{x0,y0,sx:sx*fx,sy:sy*fy,nx,ny}})
    const c={H:0,V:0,'45':0,'22':0,'67':0,X:0}
    for(const L of r.lines)for(let i=0;i+1<L.pts.length;i++)c[legDir(L.pts[i],L.pts[i+1])]++
    console.log(`${city} dirs=${d}: 45°=${c['45']} 22.5°=${c['22']} 67.5°=${c['67']} X=${c.X} forced=${r.stats.forced} colinear=${r.stats.colinear}`)
  }
}
