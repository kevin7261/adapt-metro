import json
d = json.load(open('.tmp-llmalign/export4.json'))
pos = {v['i']: (v['c'], v['r']) for v in d['verts']}
print('hv', d['hv'], 'rounds', d['rounds'], 'segsTotal', d['segsTotal'])

# degree of each vertex over all segs
deg = {}
segs = d['offSegs'] + d['hvSegs']
adj = {}
for s in segs:
    deg[s['a']] = deg.get(s['a'], 0) + 1
    deg[s['b']] = deg.get(s['b'], 0) + 1
    adj.setdefault(s['a'], []).append(s['b'])
    adj.setdefault(s['b'], []).append(s['a'])

# locks from hvSegs
collock = set()
rowlock = set()
for s in d['hvSegs']:
    if s['dir'] == 'V':
        collock.add(s['a']); collock.add(s['b'])
    else:
        rowlock.add(s['a']); rowlock.add(s['b'])

offs = sorted(d['offSegs'], key=lambda s: min(abs(s['dx']), abs(s['dy'])))
for s in offs[:70]:
    a, b = s['a'], s['b']
    la = ('C' if a in collock else '') + ('R' if a in rowlock else '')
    lb = ('C' if b in collock else '') + ('R' if b in rowlock else '')
    print(f"{a}{la or '-'}deg{deg[a]} {pos[a]} -> {b}{lb or '-'}deg{deg[b]} {pos[b]} dx {s['dx']} dy {s['dy']}")
