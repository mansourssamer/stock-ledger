"""Run before publishing: lists every app file in sw.js and sets CACHE to a fingerprint
of their contents, so phones download a new version exactly when something changed.

    python3 tools/stamp_sw.py
"""
import hashlib, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ['index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
         'vendor/firebase.js', 'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm', 'vendor/jszip.min.js']
FILES += sorted(os.path.relpath(os.path.join(d, f), ROOT) for d, _, fs in os.walk(os.path.join(ROOT, 'js')) for f in fs if f.endswith('.js'))

h = hashlib.sha256()
for f in FILES:
    h.update(f.encode())
    h.update(open(os.path.join(ROOT, f), 'rb').read())
version = h.hexdigest()[:10]
p = os.path.join(ROOT, 'sw.js')
s = open(p).read()
s = re.sub(r"const CACHE = '[^']*';", f"const CACHE = 'stock-ledger-{version}';", s)
shell = "['./', " + ', '.join(f"'./{f}'" for f in FILES) + "]"
s = re.sub(r"const SHELL = \[[^\]]*\];", f"const SHELL = {shell};", s, flags=re.S)
open(p, 'w').write(s)
print('sw.js →', version, f'({len(FILES)} files)')
