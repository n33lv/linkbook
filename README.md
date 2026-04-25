# Linkbook

An AI-native operations layer for 1–10 person creative studios. Sits on top of QuickBooks, Harvest, Dropbox Sign, Airtable, and Gmail. **Source of truth always lives in the source system.**

The full product spec is in [`flight-os-spec.md`](./flight-os-spec.md). This README covers how to run it.

## Status

**v1, mocked integrations.** The full system runs end-to-end against in-process mocks of the five integrations.

- **Tests:** 29 passing (pytest), ~2s
- **Stack:** FastAPI + SQLAlchemy 2 + Pydantic v2 + structlog
- **Location:** `apps/api_py/`

The agent runtime, event ingestion, ranking (§1.3), idempotency (§2.4), 30s undo queue with restart recovery (§2.5), hallucination guard (§5.3), composite kickoff with partial-failure recovery, and audit log (§2.6) are all real.

**Real integration code paths** — OAuth flows (QBO, Harvest, Dropbox Sign, Airtable PKCE, Google PKCE), webhook signature verification, automatic token refresh — are wired in. Without API keys they short-circuit with a clear "not configured" error and the dev path stays on mocks. Real Agentspan, KMS encryption, Postgres, and durable jobs (Conductor) are deferred.

## Stack

- **Backend** — FastAPI, SQLAlchemy 2 (typed-mapped) on SQLite, Pydantic v2 for env + payload validation, structlog. Asyncio task per row for the 30s send-delay queue with restart recovery from the DB.
- **Frontend** — React 18 + Vite, vanilla CSS with a single design-system file. Talks to the API on `:3000`.
- **Shared types** — `apps/api_py/src/linkbook/types.py` (Pydantic v2 + Literals). Single source of truth for the event taxonomy and action catalog.

## Repo layout

```
linkbook/
  flight-os-spec.md             # the spec
  package.json                  # workspace root for the React frontend
  pnpm-workspace.yaml

  apps/
    api_py/                     # linkbook-api — FastAPI (Python 3.12+)
      pyproject.toml
      src/linkbook/
        app.py                  # FastAPI factory + lifespan (boot/shutdown)
        config.py               # Pydantic-settings env validation
        types.py                # Event/Action/Proposal schemas + ACTION_CATALOG
        ranking.py              # priority_score formula (§1.3)
        idempotency.py          # action key + 24h dedupe (§2.4)
        ingestion.py            # ingest_event() — single funnel
        agents/                 # cash_chaser, project_concierge, time_sentinel, reconciler, triage, runtime
        actions/                # execute, queue (30s soft-undo), undo
        integrations/
          http.py               # HTTP transport abstraction
          mocks/                # mock store + per-source HTTP handlers
          qbo.py, harvest.py, dropboxsign.py, airtable.py, gmail.py
          oauth.py              # OAuth flows (QBO, Harvest, DropboxSign, Airtable PKCE, Google PKCE)
          token_manager.py      # auto-refresh tokens before expiry
          webhook_verify.py     # HMAC verification per source
        routes/                 # inbox, actions, events, dashboard, integrations, dev, webhooks/*
        seed.py                 # idempotent seed
        db/                     # SQLAlchemy 2 models + engine + migrate
      tests/                    # pytest — unit, integration, e2e

    web/                        # React 18 + Vite SPA
```

## Prerequisites

- **Python 3.12+** (tested on 3.14)
- **uv** for Python tooling — `brew install uv` on macOS
- **pnpm 9.12+** for the frontend — `corepack enable && corepack prepare pnpm@9.12.0 --activate`

## First-time setup

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

The seed creates 14 clients across 3 tiers, 9 active projects, 22 invoices spanning A/R aging buckets, time entries for the last 14 days, and the seven Inbox events from the UI sketch. It exercises every agent (Cash Chaser drafts a firm reminder, Project Concierge drafts a 4-leg kickoff, Time Sentinel drafts a self-nudge, Reconciler stays manual at low confidence per §5.3).

Set the env vars once in `.env` (see `.env.example`) so you don't have to repeat them.

## Running locally

```bash
# Terminal 1 — API on :3000
cd apps/api_py
DATABASE_URL=file:./linkbook.db <env> .venv/bin/uvicorn linkbook.app:app \
  --port 3000 --host 127.0.0.1 --reload

# Terminal 2 — Web on :5173
cd apps/web
pnpm install
pnpm dev
```

Then open http://127.0.0.1:5173. The Vite dev server proxies `/inbox`, `/actions`, `/dashboard/*`, `/integrations`, `/dev/*`, `/webhooks/*`, `/healthz` to `:3000`.

## Tests

```bash
cd apps/api_py
.venv/bin/pytest -q
```

Three layers:

- **Unit** — ranking formula, idempotency hash, agent fallback (§5.3 fallback-to-Manual after two malformed responses), reconciler threshold (§5.3 0.85).
- **Integration** — webhooks → ingestion → agent proposal → DB row, against the mocked HTTP boundary.
- **End-to-end** — Cash Chaser approve → 30s queue → fire → Gmail mock receives the email → audit log captures request + response. Concierge 4-leg kickoff (happy path + partial-failure resume). Hallucination-guard cancellation. Restart recovery: rewind a queued_30s row's `queued_until` into the past, restart the server, observe the queued action fires.

29 tests, ~2s.

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

- **No background workers in v1.** The 30s send-delay queue is `asyncio.create_task` per row, persisted to `actions.queued_until` so it survives restart. On boot, `recover_queue_on_boot` re-arms timers; rows whose deadline has elapsed fire with random jitter to avoid a thundering herd.
- **One funnel for ingestion.** Every webhook normalizer calls `ingest_event(...)`. That function: computes priority via §1.3, dedupes on `(type, subject_ref, dedupe_key)`, inserts the event, then fans out to all agents in `asyncio.gather(..., return_exceptions=True)`. Each agent gates on `event.type` internally.
- **Idempotency, two layers.**
  - Events: unique index on `(type, subject_ref, dedupe_key)`. CDC re-runs are no-ops.
  - Actions: `idempotency_key = sha256(type, subject_ref, semantic_payload_allowlist)`. Agents check `find_duplicate_in_window(key, 24h)` before drafting; cancelled / failed / undone rows don't block fresh proposals.
- **Hallucination guard.** Before sending a reminder, `execute_action` calls `qbo.get_invoice(id)`; if status flipped to paid/voided externally, the action is cancelled and pending events on that subject auto-resolve. Returns `{ ok: True, status: 'cancelled', reason }` so the UI can surface "Auto-resolved · invoice paid externally" instead of a generic error.
- **Audit log captures both request and response.** Every successful and failed dispatcher returns a `DispatchTrace`; `execute_action` writes it to `audit_events` with recursive redaction of secret-shaped keys. Per-leg audit rows for composite actions (§2.6).
- **CAS state transitions.** The 30s queue uses a compare-and-swap on `actions.status` so a timer firing and an undo arriving simultaneously can't both win — exactly one happens.
- **OAuth + token refresh.** `integrations/oauth.py` builds authorization URLs and handles code-for-token exchange per source; `integrations/token_manager.py` auto-refreshes any token within 5 minutes of expiry. Webhook receivers verify HMAC signatures (Harvest, Dropbox Sign, Airtable) when `USE_INTEGRATION_MOCKS=false`.

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

| Spec | Code |
|---|---|
| §1.2 event taxonomy | `apps/api_py/src/linkbook/types.py` |
| §1.3 priority score | `apps/api_py/src/linkbook/ranking.py` |
| §1.4 event states | `apps/api_py/src/linkbook/db/models.py` (CHECK constraint) |
| §2.1 action shape | `apps/api_py/src/linkbook/types.py` |
| §2.2 action catalog | `apps/api_py/src/linkbook/types.py` (`ACTION_CATALOG`) |
| §2.4 idempotency | `apps/api_py/src/linkbook/idempotency.py` |
| §2.5 30s soft-undo | `apps/api_py/src/linkbook/actions/queue.py` |
| §2.5 reversal classes | `apps/api_py/src/linkbook/actions/undo.py` |
| §2.6 audit log | `apps/api_py/src/linkbook/actions/execute.py` |
| §3.1 dashboards | `apps/api_py/src/linkbook/routes/dashboard_routes.py` |
| §4.1 Harvest→QBO sync probe | `apps/api_py/src/linkbook/routes/integrations_routes.py` |
| §4.x OAuth + token refresh | `apps/api_py/src/linkbook/integrations/oauth.py`, `token_manager.py` |
| §4.x webhook signature verification | `apps/api_py/src/linkbook/integrations/webhook_verify.py` |
| §5.1 read-through cache, no project owned | `apps/api_py/src/linkbook/db/models.py` (`Project`) |
| §5.3 agents | `apps/api_py/src/linkbook/agents/*.py` |
| §5.3 fallback-to-Manual | `apps/api_py/src/linkbook/agents/runtime.py` (`propose_with_fallback`) |
| §5.3 reconciler 0.85 threshold | `apps/api_py/src/linkbook/types.py` (`RECONCILER_CONFIDENCE_THRESHOLD`) |
| §5.8 future-proofing rules | UUIDs everywhere; `current_principal` accessor |

## Known TODOs / deferred

Search the codebase: `grep -rn "TODO(" apps/`. Categories:

- `TODO(integration:*)` — real API wiring per source. OAuth + webhook signature verification scaffolding exists; per-source production paths still need real-keyed validation.
- `TODO(jobs)` — Conductor workflows replacing in-process timers + scheduled CDC polls.
- `TODO(agentspan)` — real Agentspan client (current stub returns plausible canned responses keyed on agent + event type).
- `TODO(security)` — KMS envelope encryption replacing plaintext token storage.
- `TODO(auth)` — real Google SSO replacing the env-shimmed dev principal.

## Building from clean

```bash
cd apps/api_py
rm -rf .venv linkbook.db
uv venv --python 3.14
uv pip install -e ".[dev]"
DATABASE_URL=file:./linkbook.db <env> .venv/bin/python -m linkbook.db.migrate
DATABASE_URL=file:./linkbook.db <env> .venv/bin/python -m linkbook.seed
.venv/bin/pytest -q  # 29 passing
```
