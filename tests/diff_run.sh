#!/bin/sh
# Same steps through the old app and the new one, then compare.   tests/diff_run.sh OLD_APP_DIR erp.db workdir [scenario_maker]
set -e
APP=$1; DB=$2; W=$3; MAKER=${4:-tests/scenario_make.py}
mkdir -p "$W"
python3 "$MAKER" "$DB" > "$W/scen.json"
python3 tests/scenario_py.py "$APP" "$DB" "$W/scen.json" "$W/old.db" > "$W/old_log.json"
node tests/scenario_js.mjs "$DB" "$W/scen.json" "$W/new.db" > "$W/new_log.json"
python3 - "$W" <<'PY'
import json, sys
w = sys.argv[1]
a = json.load(open(w + '/old_log.json')); b = json.load(open(w + '/new_log.json'))
bad = 0
for i, (x, y) in enumerate(zip(a, b)):
    if x['ok'] != y['ok']:
        bad += 1
        print(f"  step {i} {x['op']}: old {'done' if x['ok'] else 'refused'}, new {'done' if y['ok'] else 'refused'} {y.get('why', '')}")
print(f"{len(a)} steps, {sum(1 for x in a if x['ok'])} done / {sum(1 for x in a if not x['ok'])} refused in the old app, {bad} outcome differences")
PY
python3 tests/compare_db.py "$DB" "$W/old.db" "$W/new.db"
