# Linkbook

An AI-native operations layer for 1–10 person creative studios. Sits on top of QuickBooks, Harvest, Dropbox Sign, Airtable, and Gmail. **Source of truth always lives in the source system.**

The full product spec is in [`flight-os-spec.md`](./flight-os-spec.md). This README covers how to run it.

## Status

**v1, mocked integrations, two backends.** Both a TypeScript and a Python implementation of the API are in the repo. They share a single SQLite schema, a single React frontend, and a single test scenario set. Either runs the full system end-to-end against in-process mocks of the five integrations.

| | TypeScript | Python |
|---|---|---|
| Stack | Fastify 4 + Drizzle + Zod + Pino | FastAPI + SQLAlchemy 2 + Pydantic v2 + structlog |
| Tests | 29 (Vitest) | 29 (pytest) |
| Status | Production-ready minus integrations | Production-ready minus integrations |
| Location | `apps/api/` | `apps/api_py/` |

The two ports are cross-verified — for the same seed, both produce identical responses on `/inbox`, `/actions`, `/dashboard/cash`, `/dashboard/projects`, `/dashboard/clients`, `/dashboard/pipeline` (same A/R aging buckets to the cent, same RAG colors per project, same agent-drafted actions).

The Python backend is the long-term direction; the TypeScript backend stays in the repo until we've run the Python one in production for a stretch.

**Real integration code paths** (OAuth flows, webhook signature verification, token refresh) are wired in the Python backend — without API keys they short-circuit with a clear "not configured" error; the dev path stays on mocks. Real Agentspan, KMS encryption, Postgres, and durable jobs (Conductor) are deferred.

## Stack at a glance

- **Backend (TS)** — Fastify 4, Drizzle ORM (SQLite via better-sqlite3), Zod, Pino. In-process timer for the 30s send-delay queue with restart recovery from the DB.
- **Backend (Python)** — FastAPI, SQLAlchemy 2 typed-mapped, Pydantic v2, structlog. Asyncio task per row for the 30s queue with the same restart recovery.
- **Frontend** — React 18 + Vite, vanilla CSS with a single design-system file. Talks to whichever backend is on `:3000`.
- **Shared types (TS)** — `packages/types` (Zod + inferred TS) is the single source of truth for the event taxonomy and action catalog used by the TS API.
- **Shared types (Python)** — `apps/api_py/src/linkbook/types.py` (Pydantic v2 + Literals) mirrors the TS schema. Kept in lockstep manually until the TS backend is removed; afterwards we'll codegen the FE types from Pydantic.

## Repo layout

```
linkbook/
  flight-os-spec.md             # the spec
  package.json, pnpm-workspace.yaml, tsconfig.base.json

  packages/
    types/                      # @linkbook/types — Event/Action/Proposal Zod schemas
    db/                         # @linkbook/db — Drizzle SQLite schema + migrations
      drizzle/                  # generated migrations

  apps/
    api/                        # @linkbook/api — Fastify (TypeScript)
      src/
        server.ts               # boot + plugins + graceful shutdown
        config.ts               # Zod-validated env
        principal.ts            # current_principal() — §5.8 rule 2
        ranking.ts              # priority_score formula (§1.3)
        idempotency.ts          # action key + 24h dedupe (§2.4)
        ingestion.ts            # webhook funnel → events → agent fan-out
        agents/                 # cash-chaser, project-concierge, time-sentinel, reconciler, triage
        actions/                # execute, queue (30s soft-undo), undo
        integrations/           # qbo, harvest, dropboxsign, airtable, gmail clients
          _http/                # HTTP transport abstraction
          _mocks/               # mock store + per-source HTTP handlers
        routes/                 # inbox, actions, dashboard, integrations, dev, webhooks/*
      test/                     # vitest — unit, integration, e2e

    api_py/                     # linkbook-api — FastAPI (Python 3.12+)
      src/linkbook/
        app.py                  # FastAPI factory + lifespan (boot/shutdown)
        config.py               # Pydantic-settings env validation
        types.py                # Pydantic mirror of @linkbook/types
        ranking.py              # priority_score formula
        idempotency.py          # action key + dedupe lookup
        ingestion.py            # ingest_event() — single funnel
        agents/                 # cash_chaser, project_concierge, time_sentinel, reconciler, triage, runtime
        actions/                # execute, queue, undo
        integrations/           # http transport + per-source clients
          mocks/                # mock store + handlers
          oauth.py              # OAuth flows (QBO, Harvest, DropboxSign, Airtable PKCE, Google PKCE)
          token_manager.py      # auto-refresh tokens before expiry
          webhook_verify.py     # HMAC verification per source
        routes/                 # inbox, actions, events, dashboard, integrations, dev, webhooks/*
        seed.py                 # idempotent seed
        db/                     # SQLAlchemy 2 models + engine + migrate
      tests/                    # pytest — unit, integration, e2e

    web/                        # @linkbook/web — React 18 + Vite SPA
```

## Prerequisites

- **Node 22 LTS** for the TypeScript backend (Node 18+ works with engine warnings).
- **Python 3.12+** for the Python backend. Tested on 3.14.
- **pnpm 9.12+** (declared as `packageManager` in root `package.json`). Easiest: `corepack enable && corepack prepare pnpm@9.12.0 --activate`.
- **uv** for Python tooling. `brew install uv` on macOS.

## First-time setup

### TypeScript backend

```bash
# 1. install workspace deps (better-sqlite3 builds a native binding)
pnpm install

# 2. copy env (defaults work for dev)
cp .env.example apps/api/.env

# 3. build all packages (types → db → api → web)
pnpm -r build

# 4. apply DB migrations + seed mock data
pnpm --filter @linkbook/db migrate
pnpm --filter @linkbook/api seed
```

### Python backend

```bash
cd apps/api_py

# 1. create venv + install deps (editable, with dev extras)
uv venv --python 3.14
uv pip install -e ".[dev]"

# 2. apply schema
DATABASE_URL=file:./linkbook.db \
DEV_PRINCIPAL_EMAIL=neel@flightdesign.co \
DEV_PRINCIPAL_NAME=Neel \
STUDIO_NAME='Flight Design Co.' \
STUDIO_FISCAL_YEAR_START=01-01 \
STUDIO_BILLABLE_TARGET_PCT=70 \
STUDIO_LOADED_COST_RATE=85 \
.venv/bin/python -m linkbook.db.migrate

# 3. seed
DATABASE_URL=file:./linkbook.db \
<same env as above> \
.venv/bin/python -m linkbook.seed
```

The seed (same data on both backends) creates 14 clients across 3 tiers, 9 active projects, 22 invoices spanning A/R aging buckets, time entries for the last 14 days, and the seven Inbox events from the UI sketch. It exercises every agent (Cash Chaser drafts a firm reminder, Project Concierge drafts a 4-leg kickoff, Time Sentinel drafts a self-nudge, Reconciler stays manual at low confidence per §5.3).

## Running locally

Pick a backend; the frontend talks to whichever is on `:3000`.

### TypeScript

```bash
# Terminal 1 — API on :3000
pnpm --filter @linkbook/api start
# (or `pnpm dev` from root for tsx watch mode)

# Terminal 2 — Web on :5173
pnpm --filter @linkbook/web dev
```

### Python

```bash
# Terminal 1 — API on :3000
cd apps/api_py
DATABASE_URL=file:./linkbook.db <env> .venv/bin/uvicorn linkbook.app:app \
  --port 3000 --host 127.0.0.1 --reload

# Terminal 2 — Web on :5173
cd ../web
pnpm dev
```

Then open http://127.0.0.1:5173. The Vite dev server proxies `/inbox`, `/actions`, `/dashboard/*`, `/integrations`, `/dev/*`, `/webhooks/*`, `/healthz` to `:3000`.

## Tests

```bash
# TypeScript
pnpm --filter @linkbook/api test

# Python
cd apps/api_py
.venv/bin/pytest -q
```

Three layers, the same scenario coverage on both sides:

- **Unit** — ranking formula, idempotency hash, agent fallback (§5.3 fallback-to-Manual after two malformed responses), reconciler threshold (§5.3 0.85).
- **Integration** — webhooks → ingestion → agent proposal → DB row, against the mocked HTTP boundary.
- **End-to-end** — Cash Chaser approve → 30s queue → fire → Gmail mock receives the email → audit log captures request + response. Concierge 4-leg kickoff (happy path + partial-failure resume). Hallucination-guard cancellation. Restart recovery: rewind a queued_30s row's `queued_until` into the past, restart the server, observe the queued action fires.

29 tests on each side, ~7s on TS, ~2s on Python.

## Cross-verifying the two backends

There's a script in `apps/api_py/cross_verify.sh` that boots both backends against fresh seeded DBs and diffs the canonical endpoints. Used while we keep both in lockstep:

```bash
cd apps/api_py
./cross_verify.sh
```

## What's wired

### Inbox (`/inbox`)
Ranked feed of events that need a human (§1). Source-tagged rows, priority score with cold/warm/hot color, inline agent proposal cards with rationale + confidence bar + Approve/Reject, queued-send countdown ring with Undo, filter pills, priority rail (vertical thermometer of the day's queue).

### Actions queue (`/actions`)
Master/detail. Stripe color encodes status (drafted/queued_30s/failed/succeeded). Click to expand: payload preview, agent rationale, leg list, audit timeline, Approve/Reject/Undo buttons that respect reversal class.

### Dashboard (5 views)
- **Cash** — A/R aging buckets (0–30/30–60/60–90/90+), QTD revenue (cash basis), avg time-to-payment, top 5 outstanding.
- **Pipeline** — contract funnel (sent/signed/declined), expected revenue, open contracts.
- **Utilization** — billable %, capacity heatmap (5 people × 14 days).
- **Projects** — RAG status table with budget bars and days-since-status.
- **Clients** — lifetime revenue, open A/R, tier.

### Settings → Integrations
Connection list, source health, "Run probe" for the Harvest→QBO sync watchdog (§4.1). Connect/callback OAuth routes per source, mocked in dev.

## Architecture notes

- **No background workers in v1.** The 30s send-delay queue is `setTimeout` (TS) / `asyncio.create_task` (Python) per row, persisted to `actions.queued_until` so it survives restart. On boot, `recover_queue_on_boot` re-arms timers; rows whose deadline has elapsed fire with random jitter to avoid a thundering herd.
- **One funnel for ingestion.** Every webhook normalizer calls `ingest_event(...)`. That function: computes priority via §1.3, dedupes on `(type, subject_ref, dedupe_key)`, inserts the event, then fans out to all agents in `Promise.allSettled` (TS) / `asyncio.gather(..., return_exceptions=True)` (Python). Each agent gates on `event.type` internally.
- **Idempotency, two layers.**
  - Events: unique index on `(type, subject_ref, dedupe_key)`. CDC re-runs are no-ops.
  - Actions: `idempotency_key = sha256(type, subject_ref, semantic_payload_allowlist)`. Agents check `find_duplicate_in_window(key, 24h)` before drafting; cancelled / failed / undone rows don't block fresh proposals.
- **Hallucination guard.** Before sending a reminder, `execute_action` calls `qbo.get_invoice(id)`; if status flipped to paid/voided externally, the action is cancelled and pending events on that subject auto-resolve. Returns `{ ok: true, status: 'cancelled', reason }` so the UI can surface "Auto-resolved · invoice paid externally" instead of a generic error.
- **Audit log captures both request and response.** Every successful and failed dispatcher returns a `DispatchTrace`; `execute_action` writes it to `audit_events` with recursive redaction of secret-shaped keys. Per-leg audit rows for composite actions (§2.6).
- **CAS state transitions.** The 30s queue uses a compare-and-swap on `actions.status` so a timer firing and an undo arriving simultaneously can't both win — exactly one happens.
- **OAuth + token refresh.** `integrations/oauth.py` (Python) builds authorization URLs and handles code-for-token exchange per source; `integrations/token_manager.py` auto-refreshes any token within 5 minutes of expiry. Webhook receivers verify HMAC signatures (Harvest, Dropbox Sign, Airtable) when not in mocks mode.

## Environment variables

See [`.env.example`](./.env.example) for the canonical list. Key ones:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | 3000 | API listen port |
| `DATABASE_URL` | `file:./linkbook.db` | SQLite path; `file:` prefix optional |
| `USE_INTEGRATION_MOCKS` | `true` | Flip off for real APIs (later) |
| `SEND_DELAY_MS` | 30000 | Override the 30s queue (tests use 80) |
| `RANK_W_*` | see file | Ranking weights — tunable from real data |
| `LLM_DAILY_KILL_SWITCH_USD` | 20 | Runaway protector (§5.7) |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI` | — | Real-mode QBO OAuth |
| `HARVEST_CLIENT_ID`, `HARVEST_CLIENT_SECRET`, `HARVEST_REDIRECT_URI` | — | Real-mode Harvest OAuth |
| `DROPBOXSIGN_CLIENT_ID`, `DROPBOXSIGN_CLIENT_SECRET`, `DROPBOXSIGN_API_KEY` | — | Real-mode Dropbox Sign |
| `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET`, `AIRTABLE_REDIRECT_URI` | — | Real-mode Airtable PKCE OAuth |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_PUBSUB_TOPIC` | — | Real-mode Gmail PKCE OAuth + Pub/Sub |

## Spec → code map

| Spec | TypeScript | Python |
|---|---|---|
| §1.2 event taxonomy | `packages/types/src/events.ts` | `apps/api_py/src/linkbook/types.py` |
| §1.3 priority score | `apps/api/src/ranking.ts` | `apps/api_py/src/linkbook/ranking.py` |
| §1.4 event states | `packages/db/src/schema/events.ts` (CHECK) | `apps/api_py/src/linkbook/db/models.py` (CHECK) |
| §2.1 action shape | `packages/types/src/actions.ts` | `apps/api_py/src/linkbook/types.py` |
| §2.2 action catalog | `packages/types/src/actions.ts` (`actionCatalog`) | `apps/api_py/src/linkbook/types.py` (`ACTION_CATALOG`) |
| §2.4 idempotency | `apps/api/src/idempotency.ts` | `apps/api_py/src/linkbook/idempotency.py` |
| §2.5 30s soft-undo | `apps/api/src/actions/queue.ts` | `apps/api_py/src/linkbook/actions/queue.py` |
| §2.5 reversal classes | `apps/api/src/actions/undo.ts` | `apps/api_py/src/linkbook/actions/undo.py` |
| §2.6 audit log | `apps/api/src/db/actions-repo.ts` | `apps/api_py/src/linkbook/actions/execute.py` |
| §3.1 dashboards | `apps/api/src/routes/dashboard.ts` | `apps/api_py/src/linkbook/routes/dashboard_routes.py` |
| §4.1 Harvest→QBO sync probe | `apps/api/src/routes/integrations.ts` | `apps/api_py/src/linkbook/routes/integrations_routes.py` |
| §4.x OAuth + token refresh | (TODO) | `apps/api_py/src/linkbook/integrations/oauth.py`, `token_manager.py` |
| §4.x webhook verification | (TODO) | `apps/api_py/src/linkbook/integrations/webhook_verify.py` |
| §5.1 read-through cache, no project owned | `packages/db/src/schema/projects.ts` | `apps/api_py/src/linkbook/db/models.py` (`Project`) |
| §5.3 agents | `apps/api/src/agents/*.ts` | `apps/api_py/src/linkbook/agents/*.py` |
| §5.3 fallback-to-Manual | `apps/api/src/agents/runtime.ts` (`proposeWithFallback`) | `apps/api_py/src/linkbook/agents/runtime.py` (`propose_with_fallback`) |
| §5.3 reconciler 0.85 threshold | `packages/types/src/proposals.ts` | `apps/api_py/src/linkbook/types.py` (`RECONCILER_CONFIDENCE_THRESHOLD`) |
| §5.8 future-proofing rules | UUIDs everywhere; `currentPrincipal()` accessor | UUIDs everywhere; `current_principal` accessor |

## Known TODOs / deferred

Search the codebase: `grep -rn "TODO(" apps/ packages/`. Categories:

- `TODO(integration:*)` — real API wiring per source. OAuth + webhook signature verification scaffolding exists in Python; per-source production paths still need real-keyed validation.
- `TODO(jobs)` — Conductor workflows replacing in-process timers + scheduled CDC polls.
- `TODO(agentspan)` — real Agentspan client (current stub returns plausible canned responses keyed on agent + event type).
- `TODO(security)` — KMS envelope encryption replacing plaintext token storage.
- `TODO(auth)` — real Google SSO replacing the env-shimmed dev principal.

## Building from clean

### TypeScript

```bash
rm -rf node_modules packages/*/node_modules apps/*/node_modules \
       packages/*/dist apps/*/dist apps/api/linkbook.db packages/db/linkbook.db
pnpm install
pnpm -r build
pnpm --filter @linkbook/db migrate
pnpm --filter @linkbook/api seed
pnpm --filter @linkbook/api test  # 29 passing
```

### Python

```bash
cd apps/api_py
rm -rf .venv linkbook.db
uv venv --python 3.14
uv pip install -e ".[dev]"
DATABASE_URL=file:./linkbook.db <env> .venv/bin/python -m linkbook.db.migrate
DATABASE_URL=file:./linkbook.db <env> .venv/bin/python -m linkbook.seed
.venv/bin/pytest -q  # 29 passing
```
