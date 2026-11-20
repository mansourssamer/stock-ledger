"""Checks every Firestore document the new app would hold for a database stays inside
Firestore's limits: 1 MiB and 40,000 index entries per document (each value inside a map gets an
ascending and a descending entry, and so does each map as a whole). Buckets follow
js/localdb.js: imported rows 200 to a bucket, new rows by day and page (n20261120aa).
    python3 tests/bucket_limits.py new.db"""
import sqlite3, sys, re, json, collections
db = sqlite3.connect(sys.argv[1]); db.row_factory = sqlite3.Row
schema = open('js/schema.js').read()
TABLES = json.loads(re.search(r'export const TABLES = (\{.*\});', schema, re.S).group(1))
ss = lambda s: len(str(s).encode()) + 1
vs = lambda v: 1 if v is None else 8 if isinstance(v, (int, float)) else ss(v)
def bucket_of(t, k):
    if TABLES[t]['key'] != 'id': return 'all'
    if isinstance(k, int): return f'i{k // 200}'
    m = re.match(r'^n\d{8}[a-z]{2}', k)
    if m: return m.group(0)
    m = re.match(r'^n\d{8}', k)
    return m.group(0) if m else 'x'
worst_size = worst_ix = (0, '')
bad = 0; docs = 0; pages = collections.Counter()
for t, d in TABLES.items():
    key = d['key']; cols = [c[0] for c in d['cols'] if c[0] != key]
    try: rows = list(db.execute(f'SELECT * FROM "{t}"'))
    except sqlite3.OperationalError: continue
    buckets = collections.defaultdict(list)
    for r in rows: buckets[bucket_of(t, r[key])].append(r)
    for b, rs in buckets.items():
        docs += 1
        if b.startswith('n'): pages[t] += 1
        size = ss(t) + ss(b) + 16 + 32 + ss('updatedAt') + 8 + ss('rows') + 32 + sum(ss(r[key]) + 32 + sum(ss(c) + vs(r[c] if c in r.keys() else None) for c in cols) for r in rs)
        ix = 2 + 2 + sum(2 + 2 * len(cols) for _ in rs)
        if size > worst_size[0]: worst_size = (size, f'{t}/{b} ({len(rs)} rows)')
        if ix > worst_ix[0]: worst_ix = (ix, f'{t}/{b} ({len(rs)} rows)')
        if size > 1048576 or ix > 40000:
            bad += 1; print(f'  OVER THE LIMIT: {t}/{b}: {len(rs)} rows, {size:,} bytes, {ix:,} index entries')
print(f'{docs} documents; largest {worst_size[0]:,} bytes ({worst_size[1]}); most index entries {worst_ix[0]:,} ({worst_ix[1]}); '
      f'day pages: {dict(pages)}; {bad} over the limit')
