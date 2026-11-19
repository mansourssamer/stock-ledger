"""Compares the old app's figures with the new app's: python3 tests/compare.py ref.json new.json"""
import json, sys, math
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
problems, checked = [], 0
def cmp(x, y, path):
    global checked
    if isinstance(x, dict) and isinstance(y, dict):
        for k in x:
            if k not in y: problems.append(f'{path}.{k} missing in new'); continue
            cmp(x[k], y[k], f'{path}.{k}')
        return
    if isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y): problems.append(f'{path}: {len(x)} items vs {len(y)}'); return
        for i, (p, q) in enumerate(zip(x, y)): cmp(p, q, f'{path}[{i}]')
        return
    checked += 1
    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool):
        if not math.isclose(x, y, rel_tol=1e-9, abs_tol=1e-9): problems.append(f'{path}: {x!r} vs {y!r}')
    elif x != y and not (x is None and y is None):
        problems.append(f'{path}: {x!r} vs {y!r}')
cmp(a, b, '')
print(f'{checked} values compared, {len(problems)} differences')
for p in problems[:40]: print('  ', p)
sys.exit(1 if problems else 0)
