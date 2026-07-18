#!/usr/bin/env python3
"""Round-2+ proposer: net-gain moves. For every vertex, scan all cells within
Chebyshev distance <=3 and score the net change of aligned incident segments;
propose the best strictly-positive move per vertex, greedily by gain."""
import json, sys
from collections import defaultdict

exp = json.load(open(sys.argv[1]))
verts = {v['i']: (v['c'], v['r']) for v in exp['verts']}
occ = {(c, r) for c, r in verts.values()}

adj = defaultdict(list)
for s in exp['hvSegs'] + exp['offSegs']:
    adj[s['a']].append(s['b'])
    adj[s['b']].append(s['a'])

def aligned(p, q):
    dx, dy = q[0] - p[0], q[1] - p[1]
    if dx == 0 and dy == 0:
        return False
    return dx == 0 or dy == 0 or abs(dx) == abs(dy)

def score(v, pos):
    return sum(1 for n in adj[v] if aligned(pos, verts[n]))

def quadrant_ok(v, tc, tr):
    c, r = verts[v]
    for n in adj[v]:
        nc, nr = verts[n]
        dxo, dyo = c - nc, r - nr
        dxn, dyn = tc - nc, tr - nr
        if (dxo > 0 and dxn < 0) or (dxo < 0 and dxn > 0):
            return False
        if (dyo > 0 and dyn < 0) or (dyo < 0 and dyn > 0):
            return False
    return True

MAXD = 3
cands = []
for v, (c, r) in verts.items():
    base = score(v, (c, r))
    best = None
    for dc in range(-MAXD, MAXD + 1):
        for dr in range(-MAXD, MAXD + 1):
            if dc == 0 and dr == 0:
                continue
            tc, tr = c + dc, r + dr
            if tc < 0 or tr < 0 or tc >= exp['cols'] or tr >= exp['rows']:
                continue
            if (tc, tr) in occ:
                continue
            if not quadrant_ok(v, tc, tr):
                continue
            gain = score(v, (tc, tr)) - base
            d = max(abs(dc), abs(dr))
            if gain > 0 and (best is None or (gain, -d) > (best[0], -best[1])):
                best = (gain, d, tc, tr)
    if best:
        cands.append((best[0], -best[1], v, best[2], best[3]))

cands.sort(reverse=True)
moves = {}
newocc = set(occ)
frozen = set()
for gain, negd, v, tc, tr in cands:
    if v in frozen:
        continue
    if (tc, tr) in newocc:
        continue
    # re-check gain with current positions (neighbors may have moved)
    if score(v, (tc, tr)) - score(v, verts[v]) <= 0:
        continue
    newocc.discard(verts[v])
    newocc.add((tc, tr))
    verts[v] = (tc, tr)
    moves[str(v)] = [tc, tr]
    frozen.add(v)
    for n in adj[v]:
        frozen.add(n)  # avoid simultaneous moves of both seg ends

out = {"model": "Fable 5", "moves": moves,
       "note": sys.argv[3] if len(sys.argv) > 3 else "淨增益掃描：每點在±3格內找入射段對齊數淨增的最佳落點，鄰點同輪互斥"}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(f"proposed {len(moves)} moves")
