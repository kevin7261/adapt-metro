#!/usr/bin/env python3
"""Greedy move proposer for llmAlign auto rounds.

Reads an export JSON, proposes short (<=3) single-axis or diagonal-snapping
moves that turn offSegs into H/V/D without breaking existing hvSegs locks.
"""
import json, sys
from collections import defaultdict

exp = json.load(open(sys.argv[1]))
verts = {v['i']: (v['c'], v['r']) for v in exp['verts']}
occ = {(c, r) for c, r in verts.values()}

# locks per vertex: col locked by V/D segs, row locked by H/D segs
col_lock = defaultdict(int)
row_lock = defaultdict(int)
deg = defaultdict(int)
for s in exp['hvSegs']:
    a, b, d = s['a'], s['b'], s['dir']
    deg[a] += 1; deg[b] += 1
    if d == 'V':
        col_lock[a] += 1; col_lock[b] += 1
    elif d == 'H':
        row_lock[a] += 1; row_lock[b] += 1
    else:  # D locks both axes relative to partner
        col_lock[a] += 1; col_lock[b] += 1
        row_lock[a] += 1; row_lock[b] += 1
for s in exp['offSegs']:
    deg[s['a']] += 1; deg[s['b']] += 1

MAXD = 3
moves = {}
moved = set()
newocc = set(occ)

def try_move(v, tc, tr):
    c, r = verts[v]
    if (tc, tr) == (c, r):
        return False
    if abs(tc - c) > MAXD or abs(tr - r) > MAXD:
        return False
    if tc < 0 or tr < 0 or tc >= exp['cols'] or tr >= exp['rows']:
        return False
    if (tc, tr) in newocc:
        return False
    if tc != c and col_lock[v]:
        return False
    if tr != r and row_lock[v]:
        return False
    newocc.discard((c, r))
    newocc.add((tc, tr))
    verts[v] = (tc, tr)
    moves[str(v)] = [tc, tr]
    moved.add(v)
    # after moving, freeze both axes to avoid double-moves breaking things
    col_lock[v] += 1
    row_lock[v] += 1
    return True

# sort offsegs by how close they are to alignment
def cost(s):
    dx, dy = abs(s['dx']), abs(s['dy'])
    return min(dx, dy, abs(dx - dy))

for s in sorted(exp['offSegs'], key=cost):
    a, b = s['a'], s['b']
    if a in moved and b in moved:
        continue
    (ca, ra), (cb, rb) = verts[a], verts[b]
    dx, dy = cb - ca, rb - ra
    if dx == 0 or dy == 0 or abs(dx) == abs(dy):
        continue  # already fixed by earlier move
    # candidate targets: (mover, tc, tr) — prefer moving the lighter endpoint
    cands = []
    for mv, ot in ((a, b), (b, a)):
        cm, rm = verts[mv]; co, ro = verts[ot]
        # make V: col -> other's col
        cands.append((abs(co - cm), col_lock[mv], deg[mv], mv, co, rm))
        # make H: row -> other's row
        cands.append((abs(ro - rm), row_lock[mv], deg[mv], mv, cm, ro))
        # make D: shrink longer axis to t = min(|dx|,|dy|)
        ddx, ddy = co - cm, ro - rm
        t = min(abs(ddx), abs(ddy))
        if t > 0:
            if abs(ddx) > t:  # shrink x: move col
                tc = co - (t if ddx > 0 else -t)
                cands.append((abs(tc - cm), col_lock[mv], deg[mv], mv, tc, rm))
            else:
                tr = ro - (t if ddy > 0 else -t)
                cands.append((abs(tr - rm), row_lock[mv], deg[mv], mv, cm, tr))
    cands.sort(key=lambda x: (x[0], x[1], x[2]))
    for dist, lk, dg, mv, tc, tr in cands:
        if mv in moved or dist == 0 or dist > MAXD or lk:
            continue
        if try_move(mv, tc, tr):
            break

out = {
    "model": "Fable 5",
    "moves": moves,
    "note": sys.argv[3] if len(sys.argv) > 3 else "貪婪：把接近對齊的未對齊段以≤3格單軸/對角吸附收成 H/V/45°，鎖定已對齊段兩端座標",
}
if len(sys.argv) > 4:
    out["prompt"] = sys.argv[4]
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(f"proposed {len(moves)} moves")
