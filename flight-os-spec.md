# Linkbook — v1 Specification (Single-Tenant)

*An AI-native operations layer for 1–10 person creative studios. Sits on top of QuickBooks, Harvest, Dropbox Sign, Airtable, and Gmail. Underlying tools remain the source of truth.*

> **Scope notes for v1:**
> - **Single-tenant.** One studio per deployment. Multi-tenancy is deferred.
> - **Single-user.** Google SSO for sign-in. No internal roles, no per-resource permissions, no Member/Owner split. Whoever logs in sees everything. Multi-user is deferred.
> - **No auto-execution.** Every write to an integrated system is initiated by a human click or is a human-in-the-loop (HITL) approval of an agent proposal. Agents observe and propose; they do not execute on their own. *Internal bookkeeping (Inbox state, priority scores, auto-resolve when source state changes) is not a write to an integrated system — see §2.3.*
> - **Source of truth always lives in the source system** (QuickBooks, Harvest, Dropbox Sign, Airtable, Gmail). Linkbook is a read-through view + action launcher. Our local store is a cache, not a system of record.

---

## 0. Product shape

Three surfaces, one backbone:

1. **Inbox** — the daily artifact. Ranked feed of things that need a human.
2. **Actions** — one-click cross-tool execution, with a structured proposal/approval model.
3. **Dashboard** — five canned analytics views that read across all integrations.

Backbone: **Integration Layer** (read events, write actions) + **Agent Runtime** on Agentspan (observers, proposers, executors).

**Wedge persona:** Studio Principal at "Flight Design Co." (an illustrative example studio — unrelated to the product name). v1 is built for a single user — the principal/operator who runs the studio's ops day-to-day.

---

## 1. Inbox

### 1.1 What's an Inbox item

Every item is a typed `Event` with a normalized envelope:

```
event_id, source (qbo|harvest|dropboxsign|airtable|gmail|linkbook),
type, subject_ref (e.g. invoice:1234), occurred_at, ingested_at,
priority_score (0-100), state, suggested_actions[], dedupe_key, thread_id
```

### 1.2 The v1 event taxonomy (closed set, ~20 types)

**Money in (QuickBooks + Harvest):**
- `invoice.overdue` (>= 1 day past due)
- `invoice.aging_30 / aging_60 / aging_90`
- `invoice.paid`
- `invoice.draft_ready_to_send` (Harvest invoice in Draft > 24h)
- `payment.received_unapplied` (QBO payment without matching invoice)

**Money out:**
- `bill.due_in_3_days`
- `expense.uncategorized` (QBO expense missing category > 7 days)

**Time:**
- `time.missing_yesterday` (signed-in user logged < 4 hrs on a workday)
- `time.budget_threshold_80` / `_100` / `_120` (project hours vs. budget)
- `time.uninvoiced_over_threshold` (>$2.5k uninvoiced billable on retainer client)

**Contracts:**
- `contract.sent_unsigned_5d`
- `contract.signed` (triggers project kickoff suggestion)
- `contract.declined`

**Project (Airtable):**
- `project.status_stale` (no Airtable update > 14d on Active project)
- `project.milestone_due_soon` (3-day window)
- `project.milestone_overdue`

**Client comms (Gmail, narrow scope — see §4.5):**
- `email.client_reply_awaiting_response_3d` *(only on threads tagged to a Linkbook project)*

**System:**
- `integration.disconnected`, `action.failed`, `agent.needs_approval`

That's it for v1. Anything else is logged but not surfaced.

### 1.3 Ranking

Single `priority_score` computed at ingest, recomputed on a 15-min cadence:

```
score = w_money * money_at_stake_normalized
      + w_urgency * recency_decay(due_date)
      + w_client_tier * client_tier_weight
      + w_blocking * is_blocking_other_work
      + w_neglect * days_unread_in_inbox
      - w_snoozed * snooze_decay
```

Weights are constants in v1, not user-tunable. Tuned from internal dogfood + design partner data. **No ML ranking in v1** — deterministic, debuggable, "Why is this on top?" must show the formula breakdown on hover.

The `w_neglect` term exists so that an item the user passed over once doesn't decay against their will — if it was important enough to surface and they didn't act, it gets *more* prominent over time, not less. Snoozing explicitly suppresses this (the `w_snoozed` penalty dominates while a snooze is active).

### 1.4 States

`unread → read → {done | snoozed | dismissed}`. Plus `waiting` (a proposed action is pending external confirmation, e.g., invoice sent, awaiting payment). State changes are one-way except `snoozed → unread` on wake. Dismissed items are hidden but kept queryable in search; they do not return.

### 1.5 Grouping & threading

Threading by `subject_ref`. An invoice that goes overdue, then ages to 30, then 60 = one thread, three events, collapsed by default to the latest. Project events thread by project. **No cross-thread grouping in v1** (no "All overdue invoices" virtual thread — that lives in the Dashboard).

### 1.6 1-click actions per event

Each event type ships with 1–3 default actions. The button executes the action via §2.

| Event | Primary action | Secondary |
|---|---|---|
| `invoice.overdue` | Send polite reminder email (templated, editable) | Mark as in-dispute / Snooze 7d |
| `invoice.aging_60` | Send firm reminder + cc principal | Schedule call task |
| `invoice.draft_ready_to_send` | Send invoice via Harvest | Edit in Harvest |
| `payment.received_unapplied` | Apply to oldest matching invoice | Open in QBO |
| `time.missing_yesterday` | Open Harvest to log time | Snooze |
| `time.budget_threshold_80` | Draft client scope-creep email | Increase budget in Airtable |
| `contract.sent_unsigned_5d` | Send Dropbox Sign reminder | Call client (creates task) |
| `contract.signed` | Kickoff: create project record in Harvest + Airtable + Drive folder + draft welcome email (no Linkbook-side project record — see §5.1) | Skip |
| `project.status_stale` | Ping project lead | Mark project paused |
| `email.client_reply_awaiting_response_3d` | Draft reply (LLM, editable) | Snooze / Dismiss |

### 1.7 Empty state

Three tiers: (a) **First-run, no integrations** — large CTA to connect; (b) **Connected, no events** — "You're caught up. Last sync 2 min ago." with summary chips (3 invoices outstanding, 2 active projects, $12.4k MTD revenue) acting as Dashboard shortcuts; (c) **Connected, syncing** — skeleton state with progress per integration.

### 1.8 Delivery

- **In-app**: always.
- **Email digest**: 8am local daily, top 10 items, plus immediate email for any `priority_score >= 85`.
- **Slack**: optional; same threshold as immediate email; DM to the signed-in user only, no channels in v1.
- **Push / mobile**: deferred.

User can mute by event type. Cannot mute by subject in v1 (use Snooze).

### 1.9 Search & filter

Filters: `source`, `type`, `state`, `subject_type` (invoice/project/contract/client), `client`, `date_range`. Free-text search hits subject ref, client name, and event title — **not full-text on item bodies in v1.**

---

## 2. Actions

### 2.1 Action model

An `Action` is a typed, idempotent, side-effecting operation against one or more integrations.

```
action_id, type, params, drafted_by (user|agent:<name>@<version>),
mode (manual|proposed), status (drafted|approved|executing|succeeded|failed|undone),
idempotency_key, preview, executed_writes[], created_at, executed_at, undo_token
```

### 2.2 v1 action catalog (closed set)

**Invoicing & payments**
- `invoice.send` (Harvest)
- `invoice.remind` (Gmail, templated)
- `invoice.mark_paid_manual` (QBO + Harvest)
- `payment.apply` (QBO)

**Contracts**
- `contract.send_reminder` (Dropbox Sign)
- `contract.create_from_template` (Dropbox Sign)

**Projects**
- `project.kickoff` (composite: Airtable record + Harvest project + Drive folder + kickoff email draft)
- `project.mark_complete` (composite: Airtable status + Harvest archive + final invoice draft)
- `project.update_status` (Airtable)

**Time**
- `time.self_nudge` (Slack DM to the signed-in user — reminder to finish their timesheet)
- `time.log_entry` (Harvest, on user's behalf only)

**Client comms**
- `email.send_draft` (Gmail, from drafted thread)

**Internal**
- `task.create` (Linkbook-native task — not synced anywhere)
- `event.snooze`, `event.dismiss`, `event.mark_done`

### 2.3 Manual and Proposed (HITL only)

Two execution modes. **No auto-execute in v1.** Every write to an integrated system is gated on a human click.

- **Manual**: user opens an Inbox item, clicks the primary action, confirms, executes.
- **Proposed**: an agent has pre-drafted the action with a full preview (recipient, body, target record, exact diff). The Inbox item shows the proposal inline; user one-click approves to execute, edits before approving, or rejects.

**Internal-only state changes** (snoozing/dismissing an Inbox item, recomputing priority, marking an event resolved when the underlying source-system state changes) happen automatically — they don't write to any integrated system, so they are not "actions" in the §2 sense.

**Default mode per action type:** every action in §2.2 ships as either Manual or Proposed. Reminders, kickoff composites, status updates, and email drafts default to Proposed (agent does the drafting). Anything that sends money, creates an invoice, or sends to a client signature defaults to Manual (no agent draft, user composes). Settings allow Manual ↔ Proposed toggle per action type; there is no Auto setting in v1.

**Auto-resolve, not auto-execute:** if the source system's state changes such that an Inbox item is no longer relevant (e.g., invoice gets paid externally, contract gets signed), Linkbook closes the Inbox item automatically. This is bookkeeping on our side, not a write to the source system. The Inbox item shows a small "auto-resolved" badge with the reason (e.g., "QuickBooks reported payment on 2026-04-22"), and resolved items remain queryable in search so the user can audit what closed and why.

### 2.4 Idempotency & write semantics

Every action carries a deterministic `idempotency_key = hash(type, subject_ref, semantic_payload)`. Server rejects duplicate keys within 24h with the prior result. For composite actions, each leg has its own key; partial-failure recovery resumes from the failed leg.

**What's in `semantic_payload`.** Per action type, we declare an explicit allowlist of fields that count as semantic — only those are hashed. Cosmetic differences (whitespace, signature, greeting wording, agent rationale text) are excluded. Examples:

| Action type | Semantic fields (hashed) | Cosmetic (ignored) |
|---|---|---|
| `invoice.remind` | recipient, invoice_id, tone tier (polite/firm/final) | body wording, subject line, agent rationale |
| `email.send_draft` | recipient, thread_id, attachment ids | body wording (any edits below the rewrite threshold) |
| `payment.apply` | payment_id, target_invoice_id, amount | — |
| `contract.send_reminder` | signature_request_id, recipient | reminder body |
| `project.kickoff` | project subject_ref, contract id (per leg: target tool's record id) | — |

A user editing the body of an agent-drafted reminder produces the **same** idempotency key — so they can't accidentally double-send by tweaking copy. A user changing the recipient or tone tier produces a **new** key. If the user genuinely needs to send a second reminder on the same invoice with the same tone, they bump the tone tier (or the 24h window expires).

**Write failure handling:** retries with exponential backoff (3 attempts, jitter, 1m → 5m → 30m). After final failure: action moves to `failed`, an `action.failed` event hits the Inbox with the integration error verbatim and a "Retry" / "Open in <tool>" pair. **No silent retries beyond 30 minutes.**

### 2.5 Undo

Every action declares a reversal at definition time. v1 reversal classes:

- **True undo** (delete-the-write): Airtable status, task creation, time entry.
- **Compensating action**: invoice send → "Send correction email" template; payment apply → "Unapply payment" (QBO supports it).
- **No undo** (button is greyed, action requires double-confirm): contract send, email send (after 30s send-delay window), invoice send to client.

Undo window: 30s soft-undo (action queued, not yet sent) for email/Slack; 24h compensating-undo for everything reversible; permanent record otherwise.

**Send-delay queue (how 30s soft-undo actually works).** Gmail and Slack send APIs are synchronous — there is no native "delayed send" we can cancel. So Linkbook holds the message locally for 30s before calling the integration. Action state machine for these types:

```
drafted → approved → queued_30s → executing → succeeded
                          ↓ (user clicks Undo)
                       cancelled
```

While in `queued_30s` the Inbox item shows a countdown with a prominent Undo button. If the user closes the tab, the queued send still fires when its timer elapses (the queue is server-side, not browser-side). On `executing` failure, normal §2.4 retry semantics apply. The 30s delay is a fixed system constant in v1, not user-configurable.

### 2.6 Audit log

Append-only `audit_event` table. Every action write captures: actor (`user` for human-initiated, `agent:<name>@<version>` for HITL-approved-from-proposal — note the human still clicked, the agent name records who drafted it), action_id, idempotency_key, request payload, integration response (status + body, redacted), timestamp, originating event_id. Surfaced in UI as a per-subject "History" tab. Retained 13 months in v1.

---

## 3. Dashboard

Five fixed views in v1. No custom dashboard builder.

### 3.1 The five views

1. **Cash** — outstanding A/R aging buckets (0/30/60/90), MTD/QTD revenue (cash + accrual toggle), top 5 outstanding invoices, average time-to-payment (rolling 90d).
2. **Pipeline** — contracts sent/signed/declined (last 90d), expected revenue from signed-but-not-invoiced work, conversion rate.
3. **Utilization** — billable % per Harvest user (week/month), capacity heatmap, retainer hours used vs. allocated per client. (Reads Harvest's user roster — these are people who log time, not Linkbook sign-ins.)
4. **Project health** — every Active project with: % of budget consumed, days since last status update, milestone status, hours this week. Red/amber/green per project (rules, not ML).
5. **Clients** — per-client lifetime revenue, hours, margin (revenue minus loaded cost using a flat $/hr cost rate set in onboarding), last engagement date.

### 3.2 Data freshness

Every view shows `Last synced HH:MM` per data source. SLA: ≤ 15 min for webhook-driven sources, ≤ 60 min for QBO (poll), ≤ 5 min for Airtable. "Refresh now" button forces a sync.

### 3.3 Drill-down

Every aggregate is clickable → filtered list → row-level → "Open in <native tool>". **No pivot/slice in v1.** Drill paths are predefined.

### 3.4 Export

CSV export on every list view. PDF snapshot of any dashboard view (single click, branded with studio name) — useful for monthly principal review.

### 3.5 Customization

Studio config, set in onboarding: fiscal year start, billable target %, client tiers (max 3), retainer-vs-project tagging. **No widget rearrangement, no custom metrics in v1.**

---

## 4. Integrations

Five for v1. Each has a normalized contract (events, actions, auth, sync).

### 4.1 QuickBooks Online

- **Auth:** OAuth2, Intuit's flow, refresh token rotation (mandatory — they expire after 100 days inactive; we ping every 30d).
- **Sync:** **Poll-based**, not webhook. QBO webhooks are unreliable and require IPP review; we use the **Change Data Capture (CDC) endpoint** every 5 minutes for invoices/payments/bills/customers, every 60 minutes for accounts/items.
- **Events ingested:** invoice created/updated/voided/paid, payment received, bill due, expense uncategorized.
- **Actions exposed:** apply payment, mark invoice paid, void invoice (manual only). **Invoice creation is intentionally out of scope for v1** — it would triple the integration surface (tax codes, item lists, account mappings, classes, sales tax) and is the highest accountant-trust risk we could take. Where Linkbook needs an invoice (e.g., Project Concierge composite, project completion), we draft it in *Harvest*, which the studio already uses for invoice creation; Harvest's existing QBO sync handles the downstream propagation. **This makes Harvest→QBO sync a critical dependency** — see "Harvest→QBO sync verification" below and §5.4 step 3a.
- **Harvest→QBO sync verification:** because Linkbook routes invoice creation through Harvest, a misconfigured Harvest→QBO sync silently breaks the accountant-trust line we're protecting here. Two protections: (1) onboarding sends a probe — a $0 test invoice in Harvest that we watch propagate to QBO within 10 min, surfacing item-mapping/tax-code errors before the user finishes setup; (2) every Linkbook-drafted Harvest invoice is tracked with a sync-watchdog — if it doesn't appear in QBO within 6h, an `integration.harvest_qbo_sync_lag` event hits the Inbox with the Harvest invoice ID and a link to Harvest's sync settings.
- **Schema normalization:** map QBO `Customer` → Linkbook `Client`, `Invoice` → `Invoice`, `Payment` → `Payment`. Sandbox companies, multi-currency, and class tracking are **flagged as unsupported** in onboarding; user is warned if their realm uses them. Bookkeeper-locked fields (account mappings) are read-only — we never write to chart of accounts.
- **Failure semantics:** rate limit is 500 req/min/realm; we cap at 60% headroom. On 401, surface re-auth as a blocking Inbox item. On 5xx, retry. **Hard rule: we never write to QBO journal entries, never touch closed-period transactions.** This is the accountant trust line.

### 4.2 Harvest

- **Auth:** OAuth2 (Personal Access Token fallback for solo accounts).
- **Sync:** Webhooks for time entries, invoices, projects + 30-min reconciliation poll to catch webhook drops.
- **Events:** time entry created, invoice sent/paid, project budget threshold crossed, project archived.
- **Actions:** send invoice, create project, log time entry, archive project.
- **Normalization:** Harvest `Project` is the canonical project; Airtable project links by Harvest project_id stored as a field.

### 4.3 Dropbox Sign

- **Auth:** OAuth2 + API key for events.
- **Sync:** Webhooks (signature_request_*).
- **Events:** sent, viewed, signed, declined, expired.
- **Actions:** send reminder, send template-based contract, void.
- **Normalization:** signature_request_id is the subject_ref; we link to Airtable project via filename convention or user-tagged metadata at send time.

### 4.4 Airtable

- **Auth:** OAuth (new Airtable OAuth, not legacy API key).
- **Sync:** Webhooks (Airtable webhooks API, base-scoped).
- **Schema challenge:** every studio's base is different. We solve this with a **mapping wizard** in onboarding: user picks their Projects table, then we infer fields by LLM-suggested mapping (Status, Client, Owner, Due Date, Budget Hours), user confirms. We persist the mapping. We **do not** require schema changes to their base, and we **do not** ship a Linkbook-blessed Airtable template — forcing migration off years of existing project history would kill PLG conversion. The cost is real (mapping wizard is harder to build) but non-negotiable for the wedge.
- **Events:** record created/updated/deleted in mapped tables.
- **Actions:** update status field, add comment, create record. We will not restructure their base.

### 4.5 Gmail (scoped)

- **Auth:** Google OAuth, restricted scopes (`gmail.modify` + `gmail.send`).
- **Sync:** Pub/Sub watch + history API.
- **Scope discipline:** we **only** observe threads matching one of: (a) `from:` or `to:` a known client email (clients ingested from QBO + Harvest + Airtable) — this is the default and covers the common case, or (b) thread tagged with a `Linkbook/*` Gmail label by the user — the explicit escape hatch for prospects, partners, or one-off threads the user wants Linkbook to surface. Everything else is invisible to Linkbook. Both modes stated explicitly in onboarding and Settings.
- **Thread-level inclusion rules** (the part that bites if left fuzzy):
  - A thread enters scope the moment **any** message on it has a known-client address in `from:`/`to:`/`cc:`. Once in scope, **subsequent messages on that thread are also in scope**, including replies between internal staff. This is the trade-off: client threads are usually the ones that matter, and split-scope on a single thread produces incoherent agent behavior. The user can demote a thread with the `Linkbook/exclude` label (see below).
  - **Shared/free-mail domains** (`gmail.com`, `yahoo.com`, `hotmail.com`, `icloud.com`, plus a maintained list) match on **full email address only**, never on domain. A client at `jane@gmail.com` does not pull in every Gmail user the studio has ever emailed.
  - **Per-thread exclude:** the user can apply a `Linkbook/exclude` label to any thread to remove it from scope retroactively. Linkbook stops fetching new messages on it and tombstones any cached content within 24h.
- **Persistence boundary:** we persist message **headers** (from, to, cc, subject, date, message-id, thread-id, label-ids) and a **content hash** for in-scope threads. Message **bodies and attachments are fetched on-demand** when the user opens the Inbox item or an agent needs them to draft a reply, and are not persisted beyond a 7-day rolling cache (encrypted at rest, keyed by thread-id, evicted on `Linkbook/exclude`). This keeps the legal/exfiltration surface minimal: a database compromise yields metadata, not 18 months of client correspondence.
- **Events:** `email.client_reply_awaiting_response_3d` is the only emitted event in v1.
- **Actions:** send draft (from existing Gmail draft we composed), apply label.

**Deferred to v1.1+:** Slack as a full integration (v1 uses outbound webhook only), Stripe, Notion, Figma, Calendar, native mobile.

---

## 5. Cross-cutting

### 5.1 Data model (single-tenant, single-user)

One studio, one user, one database. Core entities: `clients`, `projects`, `invoices`, `events`, `actions`, `audit_events`, `integration_connections`, `mappings`. Standard Postgres, no row-level security, no `tenant_id` or `user_id` plumbing. Schema stays clean enough that tenancy and user scoping can be retrofitted later without rewriting joins.

**Local store is a cache, not a system of record.** All entity rows we hold are projections of source-system state. Every cached row carries `source`, `source_id`, `last_synced_at`, and `source_etag_or_version`. On read, the UI shows `Last synced HH:MM` per source so the user always knows freshness. On write, we issue the call to the source system, then update our cache from the source's response — never the other way around.

**Hard rule: Linkbook never owns a project entity.** Harvest is canonical for billing/time. Airtable is canonical for operational state (status, owner, milestones, notes). Linkbook holds a *read-through join* of the two — never a third source of truth. The moment we let users update project state in Linkbook without writing through to one of the source systems, we own data reconciliation forever and the studio gains a third place to maintain. Resist this even when product pressure makes it tempting.

Identity reconciliation: a `client` entity is a Linkbook-side merge of QBO Customer + Harvest Client + Airtable Client + email domains, keyed by fuzzy match on name + domain + manual confirm during onboarding. Reconciliation conflicts surface as an onboarding task, not silent.

### 5.2 Credential vault

Encrypted credential store for integration tokens. KMS-backed envelope encryption with a single deployment-level DEK. Refresh tokens rotated automatically. **Never logged, never returned via API.** Standard secrets-management hygiene; no per-tenant key isolation needed in v1.

### 5.3 Agents (Agentspan runtime)

Five agents, each scoped, each versioned, each with explicit observe/propose/execute permissions:

| Agent | Trigger | Observes | Proposes (HITL) |
|---|---|---|---|
| **Cash Chaser** | New `invoice.overdue` / aging events | invoice + client history | Reminder email (tone scaled to age) |
| **Project Concierge** | `contract.signed` | contract metadata, client record | Kickoff composite (Airtable + Harvest + Drive + welcome email) |
| **Time Sentinel** | Daily 5pm cron | day's time entries | Self-nudge ("you logged 2.5h yesterday, finish your timesheet?") |
| **Reconciler** | New QBO payment | unmatched payments + open invoices | Payment-apply proposal with confidence score and the matched invoice for one-click approval (only when confidence ≥ 0.85; otherwise emit `payment.received_unapplied` for manual handling — see below) |
| **Triage** | Every new event | event + recent thread | Priority score, recommended action — these populate the Inbox item; user always confirms before any write |

No agent writes to a source system. Every proposal terminates at a human click in the Inbox. Triage's priority-score and the Inbox auto-resolve logic from §2.3 are internal-only and don't count as writes.

Each agent has a system prompt versioned in code, an evals suite (golden set of 20+ cases per agent, run on every prompt change), and a **fallback to Manual** if the LLM returns malformed structured output twice. Agents call **only** the §2 action catalog — no free-form tool use. All agent proposals carry a confidence score and a one-line rationale shown in the UI ("Proposing: Reminder. Why: invoice 14 days overdue, client typically pays after 1st reminder.").

**Hallucination guards:** every action proposal is validated against the actual subject_ref state at execution time (e.g., we re-fetch the invoice before sending a reminder; if status changed to paid, action is cancelled and event resolved).

**Reconciler confidence threshold (≥ 0.85).** Below this, no proposal is shown — the event surfaces as a plain `payment.received_unapplied` for the user to resolve manually. This is deliberate: a low-confidence Reconciler proposal trains users to reflexively approve, which is the failure mode that lets a misapplied payment slip into QBO and confuse the bookkeeper. The 0.85 number is a starting value to tune from design-partner data; like the ranking weights in §1.3, it's listed in the "still genuinely undecided" section. Confidence is a function of: amount match (exact / within 1% / partial), customer-name match, memo-line cues, and time-proximity to the most recent invoice for that customer.

### 5.4 First-run / onboarding (target: ~15 min of active user time; first Inbox renders mid-flow)

Linear, gated, no skipping the critical path. Designed so the user sees a populated Inbox (the "aha") *before* the longest-tail steps — Gmail scope review and full client reconciliation — rather than after.

1. **Sign up** (Google SSO).
2. **Studio setup** (studio name, fiscal year, billable target %).
3. **Connect QuickBooks** *(first because it's gnarliest; if it fails, fail fast).*
   - **3a. Harvest→QBO sync probe** — runs as soon as Harvest is connected (step 4). We push a $0 test invoice from Harvest and watch it land in QBO within 10 min; if it doesn't, we surface item-mapping/tax-code errors with a link to Harvest's sync settings. Blocking only if we can't reach either API; warning otherwise. (See §4.1.)
4. **Connect Harvest.**
5. **Connect Dropbox Sign.**
6. **Connect Airtable + map Projects table** (LLM-assisted mapping wizard).
7. **First Inbox renders** — backfill kicks off async (**180 days** of invoices and payments so A/R aging looks complete on day one — the most-asked-about Cash dashboard view; **90 days** of everything else: contracts, time entries, project updates). User sees a partial top 10 immediately, fills in as backfill progresses (typical full backfill: 5–20 min for QBO depending on realm size, faster for the others). **This is the "aha" moment.** It happens *before* Gmail and reconciliation.
8. **Connect Gmail** (with scope explainer covering §4.5 — known-client default, `Linkbook/*` opt-in label, `Linkbook/exclude` per-thread excise, on-demand body fetch with 7-day cache). Email backfill (90d) starts after consent.
9. **Client reconciliation** — show merged client list from QBO + Harvest + Airtable + email domains, user resolves conflicts (typical: 5–15 conflicts). Inbox is already usable; this just sharpens client-tier weighting.
10. **Tier your top clients** (drag into 3 tiers).

Each step has a "Skip for now" except QBO + Harvest (the wedge requires both). Backfill happens async with a progress bar; user is not blocked. If onboarding drops off, we email a resume link. **What "first value" means:** populated Inbox at step 7, typically 4–8 minutes of active user time after sign-up. The full 10-step path with reconciliation and tiering takes ~15 min on top of that.

### 5.5 Authentication and access (v1)

Google SSO only. One user. No roles, no per-resource permissions, no invite flow. Whoever signs in with the Google account that owns the integration connections sees everything. Multi-user, roles, and ACLs are deferred entirely.

### 5.6 Observability

Every integration call, agent invocation, and action execution emits a structured log + trace span (OpenTelemetry). Internal dashboards for: sync lag, action success rate, agent proposal acceptance rate, time-to-resolution per event type. **Customer-facing status page** for integration health from day one.

### 5.7 Rate limits & cost

- **LLM cost: instrument first, cap later.** No per-day soft cap in v1 — guessing the right number against zero usage data optimizes against fake constraints. Hard kill-switch at $20/day as a runaway protector only. Cost telemetry tagged per agent, per event type, per action type from day one. After 30 days of design-partner usage we'll set a real cap based on real numbers.
- **Operator-facing cost visibility.** Internal dashboards aren't enough — at ~$600/mo ceiling the founder needs to see anomalies in real time, not on a Monday review. Settings → "Linkbook Usage" shows: 7-day rolling spend chart with per-agent breakdown, today-so-far counter against the $20 ceiling, and a "biggest cost driver this week" callout (e.g., "Cash Chaser drafting on 47 overdue invoices"). When daily spend crosses 50% of the kill-switch ($10), the user gets an in-app banner — not because they need to act, but because they need to know.
- Caching: client/project/invoice records cached 5 min; LLM responses for identical proposal inputs cached 24h. (This caching is the cheapest cost lever and ships from day one.)
- Integration call quotas tracked per source; user sees "API budget" indicator if approaching limit.

### 5.8 Future-proofing notes (cheap discipline now, painless retrofit later)

We're explicitly single-tenant and single-user in v1. The schema and code choices below cost almost nothing today and save a serious rewrite when the second customer arrives. Treat these as hard rules, not nice-to-haves:

1. **No global-uniqueness assumptions in the schema.** UUIDs everywhere for entity primary keys. Never assume "the user," "the studio," or "the connection" is implicit. Fields like `clients.name` are not unique constraints; `(source, source_id)` is. This means adding a `tenant_id` later is a column add, not a re-keying exercise.
2. **All authentication and authorization flows go through a single `current_principal()` accessor.** Today it returns the signed-in Google user. Tomorrow it can return a `(tenant_id, user_id, role)` tuple. Every other piece of code asks the accessor — no module pulls auth state from anywhere else, no SQL filter is hardcoded against "the" user.
3. **Integration credentials keyed by an opaque `connection_id`, not by integration name.** Today the QBO connection has `connection_id = <some uuid>`. We don't write code that says "look up `the_qbo_connection`." When a tenant later has multiple QBO realms, the connection model already supports it.

That's it. Three rules, written down once, enforced at code review.

### 5.9 Explicitly deferred from v1

**Multi-tenancy** (single studio per deployment is the v1 assumption — revisit when a second customer is onboarding). **Multi-user, roles, invites, per-resource permissions** (single signed-in user is the v1 assumption — revisit when the design partner has a second person who needs access). **Auto-execution of writes** (every write is human-initiated or HITL-approved in v1). Mobile, Slack-as-bidirectional-integration, custom dashboards, multi-currency, multi-entity studios, benchmarking, marketplace of agents/templates, public API, client portal.

---

## Decisions locked

The seven open questions from the prior pass are now resolved into the spec:

1. **Gmail scope** → known-client threads by default + `Linkbook/*` label as an explicit opt-in escape hatch (§4.5).
2. **Airtable** → mapping wizard, no template (§4.4). Forcing migration would kill PLG.
3. **QBO write surface** → no invoice creation in v1 (§4.1). Where Linkbook needs an invoice, it drafts in Harvest and lets Harvest's existing QBO sync propagate (with onboarding sync probe + sync-watchdog event, §4.1).
4. **LLM cost** → instrument first, don't cap. $20/day kill-switch as a runaway protector only (§5.7).
5. **Backfill depth** → 180 days for invoices/payments, 90 days for everything else (§5.4).
6. **Project source-of-truth** → Linkbook never owns a project entity. Hard rule (§5.1). Harvest = billing, Airtable = operational state, Linkbook = read-through join.
7. **Tenancy + user retrofit** → three discipline rules in §5.8 (UUIDs, `current_principal()` accessor, opaque `connection_id`). Cheap now, painless later.

What's still genuinely undecided and best resolved by building rather than discussing:

- **Default Inbox ranking weights** (`w_money`, `w_urgency`, `w_client_tier`, `w_blocking`). Pick reasonable starting values, dogfood with the design partner, tune from real "why is this on top" feedback.
- **Cash Chaser tone scaling** — the exact prose progression from "polite reminder" → "firm reminder" → "this is now 60+ days" is a writing exercise that needs the design partner's voice, not a spec decision.
- **The 20-event taxonomy will probably be wrong by 2–3 events** in the first month of real usage. Build it as easy to add/remove event types — that flexibility matters more than getting the initial list perfect.
