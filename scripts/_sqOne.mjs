
import { writeFileSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const city=process.argv[2], variant=process.argv[3]
function run(c){return execSync(c,{encoding:'utf8',maxBuffer:80e6,cwd:ROOT})}
function ex(){return JSON.parse(run('node scripts/llmShape.mjs export '+city+' '+variant))}
function apply(p){return JSON.parse(run('node scripts/llmShape.mjs apply '+city+' '+variant+' '+p))}
run('node scripts/llmShape.mjs reset '+city+' '+variant)
// import planRing from squareAll by eval
const mod = await import('./_shapeSquareAll.mjs').catch(()=>null)
