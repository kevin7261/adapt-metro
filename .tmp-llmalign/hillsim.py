#!/usr/bin/env python3
"""Faithful Python port of makeMover.validMove + a greedy countHVD hill-climb.
Produces target positions (per-vertex Chebyshev displacement <= CAP) that are
guaranteed admissible under the same 4 hard rules, so apply won't reject them."""
import json, sys, math

exp = json.load(open(sys.argv[1]))
COLS, ROWS = exp['cols'], exp['rows']
CAP = int(sys.argv[3]) if len(sys.argv) > 3 else 3
orig = {v['i']: (v['c'], v['r']) for v in exp['verts']}
pos = {v['i']: [v['c'], v['r']] for v in exp['verts']}
segs = [{'a': s['a'], 'b': s['b']} for s in exp['offSegs']] + \
       [{'a': s['a'], 'b': s['b']} for s in exp['hvSegs']]
inc = {i: [] for i in pos}
for si, s in enumerate(segs):
    inc[s['a']].append(si)
    inc[s['b']].append(si)

def other(s, u):
    return s['b'] if s['a'] == u else s['a']

def nbrs_of(v):
    out = set()
    for si in inc[v]:
        out.add(other(segs[si], v))
    out.discard(v)
    return out

owner = {}
for i, p in pos.items():
    owner[(p[0], p[1])] = i

def orient(p, q, r):
    return (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0])

def onseg(p, a, b):
    return orient(a, b, p) == 0 and min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and \
        min(a[1], b[1]) <= p[1] <= max(a[1], b[1])

def segs_intersect(a, b, c, d):
    if max(a[0], b[0]) < min(c[0], d[0]) or max(c[0], d[0]) < min(a[0], b[0]) or \
       max(a[1], b[1]) < min(c[1], d[1]) or max(c[1], d[1]) < min(a[1], b[1]):
        return False
    o1, o2 = orient(a, b, c), orient(a, b, d)
    o3, o4 = orient(c, d, a), orient(c, d, b)
    if ((o1 > 0 and o2 < 0) or (o1 < 0 and o2 > 0)) and \
       ((o3 > 0 and o4 < 0) or (o3 < 0 and o4 > 0)):
        return True
    if o1 == 0 and onseg(c, a, b): return True
    if o2 == 0 and onseg(d, a, b): return True
    if o3 == 0 and onseg(a, c, d): return True
    if o4 == 0 and onseg(b, c, d): return True
    return False

def order_key(u, at):
    pu = at(u)
    items = []
    for si in inc[u]:
        o = at(other(segs[si], u))
        if o[0] == pu[0] and o[1] == pu[1]:
            continue
        items.append((math.atan2(o[1]-pu[1], o[0]-pu[0]), si))
    items.sort()
    return [it[1] for it in items]

def cyclic_equal(a, b):
    if len(a) != len(b): return False
    if not a: return True
    if a[0] not in b: return False
    start = b.index(a[0])
    for i in range(1, len(a)):
        if a[i] != b[(start+i) % len(b)]:
            return False
    return True

def valid_move(v, P):
    c, r = P
    if c < 0 or r < 0 or c >= COLS or r >= ROWS: return False
    o = owner.get((c, r))
    if o is not None and o != v: return False
    cur = pos[v]
    nbrs = nbrs_of(v)
    for u in nbrs:
        pu = pos[u]
        dxo, dyo = cur[0]-pu[0], cur[1]-pu[1]
        dxn, dyn = c-pu[0], r-pu[1]
        if (dxo > 0 and dxn < 0) or (dxo < 0 and dxn > 0): return False
        if (dyo > 0 and dyn < 0) or (dyo < 0 and dyn > 0): return False
    incset = set(inc[v])
    for si, s in enumerate(segs):
        if si in incset: continue
        if onseg(P, pos[s['a']], pos[s['b']]): return False
    for u in nbrs:
        pu = pos[u]
        for w, pw in pos.items():
            if w == v or w == u: continue
            if onseg(pw, P, pu): return False
        for si, s in enumerate(segs):
            if si in incset: continue
            if s['a'] == u or s['b'] == u: continue
            if segs_intersect(P, pu, pos[s['a']], pos[s['b']]): return False
    def at_cur(idd): return pos[idd]
    def at_new(idd): return P if idd == v else pos[idd]
    for u in [v] + list(nbrs):
        if len(inc[u]) < 3: continue
        if not cyclic_equal(order_key(u, at_cur), order_key(u, at_new)):
            return False
    return True

def is_hvd(p, q):
    dc, dr = p[0]-q[0], p[1]-q[1]
    if dc == 0 and dr == 0: return False
    if dc == 0 or dr == 0: return True
    return abs(dc) == abs(dr)

def local_hvd(v, P):
    n = 0
    for si in inc[v]:
        q = pos[other(segs[si], v)]
        if is_hvd(P, q): n += 1
    return n

def total_hvd():
    n = 0
    for s in segs:
        if is_hvd(pos[s['a']], pos[s['b']]): n += 1
    return n

def apply_move(v, P):
    cur = pos[v]
    if owner.get((cur[0], cur[1])) == v:
        del owner[(cur[0], cur[1])]
    pos[v] = [P[0], P[1]]
    owner[(P[0], P[1])] = v

start_hvd = total_hvd()
# greedy sweeps
verts = list(pos.keys())
R = 2  # per-move radius
for sweep in range(30):
    changed = False
    for v in verts:
        cur = pos[v]
        base = local_hvd(v, cur)
        best = None
        for dc in range(-R, R+1):
            for dr in range(-R, R+1):
                if dc == 0 and dr == 0: continue
                tc, tr = cur[0]+dc, cur[1]+dr
                # cap total displacement from original
                if max(abs(tc-orig[v][0]), abs(tr-orig[v][1])) > CAP: continue
                g = local_hvd(v, (tc, tr)) - base
                if g <= 0: continue
                if not valid_move(v, (tc, tr)): continue
                d = abs(dc)+abs(dr)
                if best is None or g > best[0] or (g == best[0] and d < best[1]):
                    best = (g, d, tc, tr)
        if best:
            apply_move(v, [best[2], best[3]])
            changed = True
    if not changed:
        break

end_hvd = total_hvd()
moves = {}
for i in pos:
    if pos[i][0] != orig[i][0] or pos[i][1] != orig[i][1]:
        moves[str(i)] = [pos[i][0], pos[i][1]]
out = {"model": "Opus 4.8", "moves": moves,
       "note": sys.argv[4] if len(sys.argv) > 4 else ""}
if len(sys.argv) > 5:
    out["prompt"] = sys.argv[5]
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(f"start_hvd={start_hvd} sim_end_hvd={end_hvd} moves={len(moves)} sweeps<=30 CAP={CAP}")
