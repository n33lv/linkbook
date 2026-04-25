# Linkbook

An AI-native operations layer for 1–10 person creative studios. Sits on top of QuickBooks, Harvest, Dropbox Sign, Airtable, and Gmail. Source of truth always lives in the source system.

The full product spec is in [`flight-os-spec.md`](./flight-os-spec.md). This README covers how to run it.

## Status

**v1, mocked integrations.** The full system runs end-to-end against in-process mocks of QuickBooks, Harvest, Dropbox Sign, Airtable, and Gmail. The agent runtime, event ingestion, ranking (§1.3), idempotency (§2.4), 30s undo queue (§2.5), hallucination guard (§5.3), composite kickoff with partial-failure recovery, and audit log are all real. Real OAuth flows, real Agentspan, KMS encryption, Postgres, and durable jobs are deferred.

## Stack

- **Backend** — TypeScript, Fastify 4, Drizzle ORM (SQLite via better-sqlite3), Zod, Pino. Single process for v1; in-process timer for the 30s send-delay queue with restart recovery from the DB. Conductor will replace the in-process timer later.
- **Frontend** — React 18 + Vite, vanilla CSS with a single design-system file. No router (hash-less single-page), no state library; the API does all the work.
- **Shared types** — `packages/types` (Zod schemas + inferred TS) is the single source of truth for the event taxonomy and action catalog.

## Repo layout

```
linkbook/
  flight-os-spec.md           # the spec
  package.json, pnpm-workspace.yaml, tsconfig.base.json
  packages/
    types/                    # @linkbook/types — Event/Action/Proposal Zod schemas
    db/                       # @linkbook/db — Drizzle SQLite schema + migrations
      drizzle/                # generated migrations
  apps/
    api/                      # @linkbook/api — Fastify server
      src/
        server.ts             # boot + plugins + graceful shutdown
        config.ts             # Zod-validated env
        principal.ts          # current_principal() — §5.8 rule 2
        ranking.ts            # priority_score formula (§1.3)
        idempotency.ts        # action key + 24h dedupe (§2.4)
        ingestion.ts          # webhook funnel → events → agent fan-out
        agents/               # cash-chaser, project-concierge, time-sentinel, reconciler, triage
        actions/              # execute, queue (30s soft-undo), undo
        integrations/         # qbo, harvest, dropboxsign, airtable, gmail clients
          _http/              # HTTP transport abstraction
          _mocks/              # mock store + per-source HTTP handlers
        routes/               # inbox, actions, dashboard, integrations, dev, webhooks/*
      test/                   # vitest — unit, integration, e2e
    web/                      # @linkbook/web — React/Vite SPA
```

## Prerequisites

- **Node 22 LTS** recommended. Node 18+ works but you'll see engine warnings.
- **pnpm 9.12+** (declared as `packageManager` in root `package.json`).
  - Easiest: `corepack enable && corepack prepare pnpm@9.12.0 --activate`
  - Or just use `npx pnpm@9.12.0 …` in commands below.

## First-time setup

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

The seed creates 14 clients across 3 tiers, 9 active projects, 22 invoices spanning A/R aging buckets, time entries for the last 14 days, and the seven Inbox events from the UI sketch. It exercises every agent (Cash Chaser drafts a firm reminder, Project Concierge drafts a 4-leg kickoff, Time Sentinel drafts a self-nudge, Reconciler stays manual at low confidence per §5.3).

## Running locally

In two terminals:

```bash
# Terminal 1 — API on :3000
pnpm --filter @linkbook/api start
# (or `pnpm dev` from root for tsx watch mode against src/)

# Terminal 2 — Web on :5173
pnpm --filter @linkbook/web dev
```

Then open http://localhost:5173. The Vite dev server proxies `/inbox`, `/actions`, `/dashboard/*`, `/integrations`, `/dev/*`, `/webhooks/*`, `/healthz` to `:3000`.

## Tests

```bash
# from apps/api
pnpm --filter @linkbook/api test
```

Three layers:
- **Unit** — ranking formula, idempotency hash, agent fallback (§5.3 fallback-to-Manual after two malformed responses), reconciler threshold (§5.3 0.85).
- **Integration** — webhooks → ingestion → agent proposal → DB row, against the mocked HTTP boundary.
- **End-to-end** — full server in a child process: Cash Chaser approve → 30s queue → fire → Gmail mock receives the email → audit log captures request + response. Concierge 4-leg kickoff (happy path + partial-failure resume). Hallucination-guard cancellation. Restart recovery: rewind a queued_30s row's `queued_until` into the past, stop the server, boot a fresh one against the same DB, observe the queued action fires.

29 tests, ~7s.

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
Connection list, source health, "Run probe" for the Harvest→QBO sync watchdog (§4.1).

## Architecture notes

- **No background workers in v1.** The 30s send-delay queue is `setTimeout` per row, persisted to `actions.queued_until` so it survives restart (`recoverQueueOnBoot` re-arms timers; rows whose deadline has elapsed fire with random jitter to avoid a thundering herd).
- **One funnel for ingestion.** Every webhook normalizer calls `ingestEvent(ctx, …)`. That function: computes priority via §1.3, dedupes on `(type, subject_ref, dedupe_key)`, inserts the event, then fans out to all agents in `Promise.allSettled`. Each agent gates on `event.type` internally.
- **Idempotency, two layers.**
  - Events: unique index on `(type, subject_ref, dedupe_key)`. CDC re-runs are no-ops.
  - Actions: `idempotency_key = sha256(type, subject_ref, semantic_payload_allowlist)`. Agents check `findDuplicateInWindow(key, 24h)` before drafting; cancelled / failed / undone rows don't block fresh proposals.
- **Hallucination guard.** Before sending a reminder, `executeAction` calls `qbo.getInvoice(id)`; if status flipped to paid/voided externally, the action is cancelled and pending events on that subject auto-resolve. Returns `{ ok: true, status: 'cancelled', reason }` so the UI can surface "Auto-resolved · invoice paid externally" instead of a generic error.
- **Audit log captures both request and response.** Every successful and failed dispatcher returns a `DispatchTrace`; `executeAction` writes it to `audit_events` with redaction of secret-shaped keys (recursive). Per-leg audit rows for composite actions (§2.6).
- **CAS state transitions.** The 30s queue uses a compare-and-swap on `actions.status` so a timer firing and an undo arriving simultaneously can't both win — exactly one happens.

## Environment variables

See [`.env.example`](./.env.example) for the canonical list. Key ones:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | 3000 | API listen port |
| `DATABASE_URL` | `file:./linkbook.db` | SQLite path; `file:` prefix optional |
| `USE_INTEGRATION_MOCKS` | `true` | Flip off for real APIs (later) |
| `SEND_DELAY_MS` | 30000 | Override the 30s queue for tests |
| `RANK_W_*` | see file | Ranking weights — tunable from real data |
| `LLM_DAILY_KILL_SWITCH_USD` | 20 | Runaway protector (§5.7) |

## Spec → code map

| Spec | Code |
|---|---|
| §1.2 event taxonomy | `packages/types/src/events.ts` |
| §1.3 priority score | `apps/api/src/ranking.ts` |
| §1.4 event states | `packages/db/src/schema/events.ts` (CHECK constraint) |
| §2.1 action shape | `packages/types/src/actions.ts` + `packages/db/src/schema/actions.ts` |
| §2.2 action catalog | `packages/types/src/actions.ts` (`actionCatalog`) |
| §2.4 idempotency | `apps/api/src/idempotency.ts` |
| §2.5 30s soft-undo | `apps/api/src/actions/queue.ts` |
| §2.5 reversal classes | `apps/api/src/actions/undo.ts` |
| §2.6 audit log | `apps/api/src/db/actions-repo.ts` (`writeAudit`) |
| §3.1 dashboards | `apps/api/src/routes/dashboard.ts` |
| §4.1 Harvest→QBO sync probe | `apps/api/src/routes/integrations.ts` |
| §5.1 read-through cache, no project owned | `packages/db/src/schema/projects.ts` |
| §5.3 agents | `apps/api/src/agents/*.ts` |
| §5.3 fallback-to-Manual | `apps/api/src/agents/runtime.ts` (`proposeWithFallback`) |
| §5.3 reconciler 0.85 threshold | `packages/types/src/proposals.ts` (`RECONCILER_CONFIDENCE_THRESHOLD`) |
| §5.8 future-proofing rules | UUIDs everywhere; `currentPrincipal()` accessor; opaque `connection_id` |

## Known TODOs / deferred

Search the codebase: `grep -rn "TODO(" apps/ packages/`. Categories:

- `TODO(integration:*)` — real API code per source.
- `TODO(jobs)` — Conductor workflows replacing in-process timers + scheduled CDC polls.
- `TODO(agentspan)` — real Agentspan client (current stub returns plausible canned responses).
- `TODO(security)` — KMS envelope encryption replacing plaintext token storage.
- `TODO(auth)` — real Google SSO replacing the env-shimmed dev principal.
- `TODO(routes:*)` — handful of endpoint enhancements.

## Building from clean

```bash
rm -rf node_modules packages/*/node_modules apps/*/node_modules \
       packages/*/dist apps/*/dist apps/api/linkbook.db packages/db/linkbook.db
pnpm install
pnpm -r build
pnpm --filter @linkbook/db migrate
pnpm --filter @linkbook/api seed
pnpm --filter @linkbook/api test  # 29 passing
```
