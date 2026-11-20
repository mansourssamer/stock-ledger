"""Compares two buying plans value by value (floats to a millionth).   python3 tests/buying_compare.py old.json new.json"""
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
bad, n = [], 0
def cmp(x, y, path):
    global n
    if isinstance(x, dict) and isinstance(y, dict):
        for k in sorted(set(x) | set(y)): cmp(x.get(k), y.get(k), f'{path}.{k}')
    elif isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y): bad.append(f'{path}: {len(x)} vs {len(y)} items'); return
        for i, (p, q) in enumerate(zip(x, y)): cmp(p, q, f'{path}[{i}]')
    else:
        n += 1
        if isinstance(x, bool) or isinstance(y, bool):
            if x != y: bad.append(f'{path}: {x!r} vs {y!r}')
        elif isinstance(x, (int, float)) and isinstance(y, (int, float)):
            if abs(x - y) > 1e-6 * max(1, abs(x)): bad.append(f'{path}: {x!r} vs {y!r}')
        elif x != y: bad.append(f'{path}: {x!r} vs {y!r}')
cmp(a, b, 'plan')
print(f'{n} values compared, {len(bad)} differences, {len(a["rows"])} models')
for x in bad[:30]: print('  ', x)
sys.exit(1 if bad else 0)
