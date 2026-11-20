"""Compares the report data of both apps page by page (numbers to a millionth). Keys only one
side has (display texts, dates as objects) are listed once, not counted as differences.
    python3 tests/report_compare.py ref.json new.json"""
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
bad, n, onesided = [], 0, set()
def cmp(x, y, path):
    global n
    if isinstance(x, dict) and isinstance(y, dict):
        for k in sorted(set(x) | set(y)):
            if k not in x or k not in y:
                onesided.add(('only old ' if k in x else 'only new ') + path.split('.')[0] + ' ' + k); continue
            cmp(x[k], y[k], f'{path}.{k}')
    elif isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y): bad.append(f'{path}: {len(x)} vs {len(y)} items'); return
        for i, (p, q) in enumerate(zip(x, y)): cmp(p, q, f'{path}[{i}]')
    else:
        n += 1
        if isinstance(x, bool) or isinstance(y, bool):
            if bool(x) != bool(y): bad.append(f'{path}: {x!r} vs {y!r}')
        elif isinstance(x, (int, float)) and isinstance(y, (int, float)):
            if abs(x - y) > 1e-6 * max(1, abs(x)): bad.append(f'{path}: {x!r} vs {y!r}')
        elif x != y: bad.append(f'{path}: {x!r} vs {y!r}')
for page in a:
    if page not in b: onesided.add('page not built yet: ' + page); continue
    cmp(a[page], b[page], page)
print(f'{n} values compared on {len([p for p in a if p in b])} pages, {len(bad)} differences')
for x in bad[:40]: print('  ', x)
if '-v' in sys.argv:
    for x in sorted(onesided): print('   ·', x)
sys.exit(1 if bad else 0)
