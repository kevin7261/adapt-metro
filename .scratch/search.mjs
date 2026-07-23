import fs from 'fs';
const E = JSON.parse(fs.readFileSync('.scratch/tj.json', 'utf8'));
const lines = JSON.parse(fs.readFileSync('.scratch/lines.json', 'utf8'));
const N = E.verts.length;
const P0 = E.verts.map((v) => [v.c, v.r]);
const name = (i) => E.verts[i].name;
const isX = (i) => E.verts[i].name === '×';
const segs = [];
const segSet = new Set();
for (const L of lines)
  for (const ch of L.chains)
    for (let i = 0; i + 1 < ch.length; i++) {
      const a = ch[i], b = ch[i + 1];
      const k = a < b ? a + '-' + b : b + '-' + a;
      if (!segSet.has(k)) { segSet.add(k); segs.push([a, b]); }
    }
const triples = [];
for (const L of lines)
  for (const ch of L.chains)
    for (let i = 1; i + 1 < ch.length; i++) triples.push([ch[i - 1], ch[i], ch[i + 1], L.name]);

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function kind(P, a, b) {
  const dc = P[b][0] - P[a][0], dr = P[b][1] - P[a][1];
  if (dc === 0 && dr === 0) return 'Z';
  if (dr === 0) return 'H';
  if (dc === 0) return 'V';
  if (Math.abs(dc) === Math.abs(dr)) return 'D';
  return 'O';
}
function hv(P) { let n = 0; for (const [a, b] of segs) { const k = kind(P, a, b); if (k === 'H' || k === 'V') n++; } return n; }
function acute(P) {
  let n = 0; const at = [];
  for (const [a, b, c, ln] of triples) {
    const d = (P[a][0] - P[b][0]) * (P[c][0] - P[b][0]) + (P[a][1] - P[b][1]) * (P[c][1] - P[b][1]);
    if (d > 0) { n++; at.push(ln + '@' + name(b) + '(' + P[b] + ')'); }
  }
  return { n, at };
}
function occl(P) {
  const cell = new Map(); let bad = 0;
  for (let i = 0; i < N; i++) { const k = P[i][0] + ',' + P[i][1]; if (cell.has(k)) bad += 100; cell.set(k, i); }
  for (const [a, b] of segs) {
    const dc = P[b][0] - P[a][0], dr = P[b][1] - P[a][1];
    const g = gcd(Math.abs(dc), Math.abs(dr));
    if (g < 2) continue;
    for (let t = 1; t < g; t++) { const k = (P[a][0] + (dc / g) * t) + ',' + (P[a][1] + (dr / g) * t); if (cell.has(k)) bad++; }
  }
  return bad;
}
const base = { hv: hv(P0), ac: acute(P0), oc: occl(P0) };
console.log('base HV', base.hv, 'acute', base.ac.n, base.ac.at, 'occl', base.oc);

function score(P) { const a = acute(P); return { hv: hv(P), ac: a.n, oc: occl(P) }; }
function better(s, b) {
  if (s.oc > b.oc) return false;
  if (s.ac !== b.ac) return s.ac < b.ac;
  return s.hv > b.hv;
}
const P = P0.map((x) => x.slice());
let cur = score(P);
const applied = {};
const COLS = E.stats.cols, ROWS = E.stats.rows;
for (let iter = 0; iter < 60; iter++) {
  let best = null;
  for (let i = 0; i < N; i++) {
    if (isX(i)) continue;
    for (let dc = -2; dc <= 2; dc++)
      for (let dr = -2; dr <= 2; dr++) {
        if (!dc && !dr) continue;
        const nc = P[i][0] + dc, nr = P[i][1] + dr;
        if (nc < 0 || nr < 0 || nc > COLS + 1 || nr > ROWS + 1) continue;
        const old = P[i];
        P[i] = [nc, nr];
        const s = score(P);
        P[i] = old;
        if (better(s, cur)) {
          const gain = (cur.ac - s.ac) * 10 + (s.hv - cur.hv) - 0.01 * (Math.abs(dc) + Math.abs(dr));
          if (!best || gain > best.gain) best = { i, nc, nr, s, gain };
        }
      }
  }
  if (!best) break;
  P[best.i] = [best.nc, best.nr];
  cur = best.s;
  applied[best.i] = [best.nc, best.nr];
  console.log('move i' + best.i, name(best.i), P0[best.i] + '', '->', best.nc + ',' + best.nr, '| HV', cur.hv, 'ac', cur.ac, 'oc', cur.oc);
}
console.log('FINAL HV', cur.hv, 'acute', cur.ac, 'occl', cur.oc);
console.log(JSON.stringify(applied));
