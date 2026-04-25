#!/usr/bin/env bash
# Boot both backends against fresh seeded DBs; diff key endpoints.
set -e

PYDIR=/Users/neel/workspace/linkbook/apps/api_py
TSDIR=/Users/neel/workspace/linkbook/apps/api

# Clean
pkill -f 'dist/server.js' 2>/dev/null || true
pkill -f 'uvicorn' 2>/dev/null || true
sleep 0.5
rm -f $PYDIR/cv.db $TSDIR/cv.db

# Build TS
cd $TSDIR
npx pnpm --filter @linkbook/api build > /dev/null 2>&1

# Migrate + seed Python
cd $PYDIR
DATABASE_URL=file:./cv.db DEV_PRINCIPAL_EMAIL=neel@flightdesign.co DEV_PRINCIPAL_NAME=Neel STUDIO_NAME='Flight Design Co.' STUDIO_FISCAL_YEAR_START=01-01 STUDIO_BILLABLE_TARGET_PCT=70 STUDIO_LOADED_COST_RATE=85 .venv/bin/python -m linkbook.db.migrate > /dev/null
DATABASE_URL=file:./cv.db DEV_PRINCIPAL_EMAIL=neel@flightdesign.co DEV_PRINCIPAL_NAME=Neel STUDIO_NAME='Flight Design Co.' STUDIO_FISCAL_YEAR_START=01-01 STUDIO_BILLABLE_TARGET_PCT=70 STUDIO_LOADED_COST_RATE=85 .venv/bin/python -m linkbook.seed > /dev/null 2>&1

# Migrate + seed TS
cd $TSDIR
rm -f cv.db
DATABASE_URL=file:./cv.db node ../../packages/db/dist/migrate.js > /dev/null
DATABASE_URL=file:./cv.db node dist/seed.js > /dev/null 2>&1

# Boot both
cd $PYDIR
DATABASE_URL=file:./cv.db DEV_PRINCIPAL_EMAIL=neel@flightdesign.co DEV_PRINCIPAL_NAME=Neel STUDIO_NAME='Flight Design Co.' STUDIO_FISCAL_YEAR_START=01-01 STUDIO_BILLABLE_TARGET_PCT=70 STUDIO_LOADED_COST_RATE=85 PORT=4001 .venv/bin/uvicorn linkbook.app:app --port 4001 --host 127.0.0.1 > /tmp/py.log 2>&1 &
PY_PID=$!

cd $TSDIR
DATABASE_URL=file:./cv.db PORT=4000 node dist/server.js > /tmp/ts.log 2>&1 &
TS_PID=$!

sleep 3

echo === counts ===
TS_INBOX=$(curl -s http://127.0.0.1:4000/inbox | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps({"events":len(d["events"]),"counts":d["counts"]}))')
PY_INBOX=$(curl -s http://127.0.0.1:4001/inbox | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps({"events":len(d["events"]),"counts":d["counts"]}))')
echo "TS: $TS_INBOX"
echo "PY: $PY_INBOX"
[ "$TS_INBOX" = "$PY_INBOX" ] && echo MATCH || echo DIFF

echo
echo === actions ===
TS_ACT=$(curl -s http://127.0.0.1:4000/actions | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps({"stats":d["stats"],"types":sorted([a["type"] for a in d["actions"]])}))')
PY_ACT=$(curl -s http://127.0.0.1:4001/actions | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps({"stats":d["stats"],"types":sorted([a["type"] for a in d["actions"]])}))')
echo "TS: $TS_ACT"
echo "PY: $PY_ACT"
[ "$TS_ACT" = "$PY_ACT" ] && echo MATCH || echo DIFF

echo
echo === cash ar_aging ===
TS_AR=$(curl -s http://127.0.0.1:4000/dashboard/cash | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d["ar_aging"]))')
PY_AR=$(curl -s http://127.0.0.1:4001/dashboard/cash | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d["ar_aging"]))')
echo "TS: $TS_AR"
echo "PY: $PY_AR"
[ "$TS_AR" = "$PY_AR" ] && echo MATCH || echo DIFF

echo
echo === projects ===
TS_PR=$(curl -s http://127.0.0.1:4000/dashboard/projects | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(sorted([{"name":p["name"],"rag":p["rag"]} for p in d["projects"]], key=lambda x:x["name"])))')
PY_PR=$(curl -s http://127.0.0.1:4001/dashboard/projects | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(sorted([{"name":p["name"],"rag":p["rag"]} for p in d["projects"]], key=lambda x:x["name"])))')
echo "TS: $TS_PR"
echo "PY: $PY_PR"
[ "$TS_PR" = "$PY_PR" ] && echo MATCH || echo DIFF

echo
echo === clients (count) ===
TS_C=$(curl -s http://127.0.0.1:4000/dashboard/clients | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["clients"]))')
PY_C=$(curl -s http://127.0.0.1:4001/dashboard/clients | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["clients"]))')
echo "TS: $TS_C"
echo "PY: $PY_C"
[ "$TS_C" = "$PY_C" ] && echo MATCH || echo DIFF

# clean up
kill -TERM $TS_PID $PY_PID 2>/dev/null
wait 2>/dev/null
rm -f $PYDIR/cv.db $TSDIR/cv.db
