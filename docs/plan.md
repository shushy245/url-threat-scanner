# URL Threat Scanner — Implementation Plan

## Context

Above Security's sensor monitors pages users visit and submits suspicious URLs for analysis. We're
building the backend service that accepts those submissions, runs security checks asynchronously,
and makes results queryable.

This is a take-home for a job interview, but the explicit instruction is to treat it as **real
production code at worldwide scale** — no shortcuts excused by "it's just an assignment." The
deliverable is therefore judged on two axes at once: the running service, and the *legibility of the
reasoning behind it*. Every crossroads gets a concise ADR in `docs/adr/` so the interviewer can read
the decisions without reverse-engineering them from code.

Two constraints shape everything:
- **Backend only.** The API contract is the entire product surface.
- **Time is of the essence.** Checks are **simulated** first behind the same port the real ones will
  implement; real RDAP/TLS adapters land last, only if time remains. This is a deliberate,
  documented decision (ADR-0005), not an omission.

Repo `~/Desktop/above/2026-09-shalev-shushy` is empty (`main`, zero commits).

---

## Stack

TypeScript (strict) · Express · PostgreSQL · Drizzle + drizzle-kit (forward-only) · **RabbitMQ via
amqplib** · Zod at every boundary · Vitest (drivers + builders) · pino structured logging · Docker
Compose · ESLint via `eslint-config-shalev@2.0.0` · husky commit gate.

All per the global doctrine. The one genuinely open stack question was the queue transport — settled
in ADR-0001 below.

---

## The five decisions (each becomes an ADR)

### ADR-0001 — RabbitMQ with a transactional outbox

**Chosen** over a Postgres `SKIP LOCKED` job table and over BullMQ/Redis.

A Postgres-backed queue is a legitimate production pattern (Oban, River, Solid Queue all ship it at
scale), and it has one real advantage: enqueueing in the same transaction as the scan insert means
the dual-write problem never arises. That argument is why it was the initial choice.

It was the wrong call. It buys correctness by *removing the problem* rather than solving it, and the
problem is one this system will actually have: at worldwide scale the queue would contend with OLTP
traffic on the same database, a second consumer of scan events (alerting, enrichment, an ML
pipeline) would have nowhere to attach, and queue infrastructure couldn't scale independently of the
primary store. Those are the conditions a broker exists for.

**Architecture — publish is never a second write:**

1. `POST` opens one transaction: `INSERT scan` + `INSERT outbox_event('ScanRequested')`. Commit.
   Atomic by construction; the API never touches RabbitMQ, so a broker outage cannot fail a
   submission or lose an event.
2. A **relay** process drains unpublished outbox rows (`FOR UPDATE SKIP LOCKED`, batched), publishes
   with persistent delivery + publisher confirms, and marks them published.
3. The **worker** consumes, running the checks.

**Delivery semantics, stated rather than assumed:** the relay is at-least-once — if a publish
confirms but the mark-published commit fails, the event republishes. The consumer is therefore
idempotent by design: it claims work with
`UPDATE scan SET status='in_progress' WHERE id=$1 AND status='pending' RETURNING *`, and a zero-row
result means already-handled → ack and drop. That single compare-and-swap is both the idempotency
guard and the stale-update guard the doctrine requires.

**DLQ:** every queue is declared through an amqplib wrapper whose options type makes dead-letter
config **mandatory — a compile error if omitted**, per doctrine. Redelivery count is read from the
`x-death` header and logged on every receive; past the limit the message dead-letters to
`scan.dead`, whose consumer persists it to a `dlq_event` table for **manual, deliberate** replay.

**Honest caveat:** the relay still polls Postgres, so this does not eliminate polling — it moves it
off the hot path. What we actually gain is fan-out to future consumers, independent scaling, native
routing/DLQ semantics, and broker-level durability. Claiming "no polling" would be false.

**Trade-off:** a third container and a third process, and two moving parts (relay, consumer) where
one would do. The compensating cost of the alternative was the ceiling on everything above.

## In one breath
*We never publish and write in two steps — the scan row and its event commit together in Postgres,
and a relay pushes them to RabbitMQ at-least-once, which is safe because the consumer claims work
with a compare-and-swap that makes reprocessing a no-op.*

### ADR-0002 — One message per scan; checks run concurrently inside it

**Chosen** over one message per `(scan, check)` with fan-in.

The worker claims a scan, runs every check via `Promise.allSettled` with a per-check timeout, and
writes all `scan_check` rows + the score + the terminal status in a single transaction. One status
transition, no aggregation step, no "are all checks done yet?" race.

- **Trade-off:** one slow check delays the whole scan, and a retry re-runs checks that already
  succeeded. Fan-out buys per-check retry and independent scaling per check type; it costs a fan-in
  completion race, which is the classic source of stuck-forever scans. The migration path (job per
  check + a completion counter) is documented; we take the simpler correct thing now.

### ADR-0003 — `Idempotency-Key` header; every distinct submission is its own scan

Two different problems hide behind "do we dedupe": **retry safety** (the sensor's POST timed out and
it retries — don't create a second scan) and **cost** (the same popular URL is submitted constantly
— don't re-run WHOIS). They deserve different answers.

We solve retry safety now and document the cost problem, rather than conflating them into a
URL-keyed cache. The decisive reason is that this is a **security audit trail**: every submission is
a real observation of a real user visiting a real page at a real time, and collapsing distinct
observations into one cached verdict destroys evidence a security product needs. A verdict can also
go stale inside any TTL — the domain that was clean an hour ago is exactly the one that turns.

- `Idempotency-Key` header, optional but honored (Stripe semantics).
- Unique index on `(client_id, idempotency_key)`. The write path **attempts the insert and handles
  the unique violation** rather than checking-then-inserting — the DB arbitrates the concurrent
  double-submit, which a read-then-write cannot do correctly.
- Replay of a key → `200` with the original scan. Same key with a *different* body → `409`, detected
  via a stored hash of the normalized request. Silently returning the first result for a different
  payload is the failure mode that makes idempotency keys dangerous.
- Keys expire on a configurable window (24h default), reaped by a scheduled delete.
- **Trade-off, stated plainly in the README:** popular-URL cost is now unbounded — N submissions of
  the same domain means N WHOIS lookups. The right fix is a short-TTL result cache keyed on the
  normalized URL *underneath* the check layer, so each scan stays its own audit record while the
  expensive lookup is shared. That's the first optimization I'd add with more time, and it's a
  caching concern, not an API-contract concern — which is precisely why it doesn't belong in the
  `POST` semantics.

### ADR-0004 — SSRF guard and API-key auth ship; rate limiting is deliberately deferred

We are a service that fetches attacker-influenced URLs. Without an SSRF guard, the service is a
pivot into the internal network — for a security company this is the part that will be looked at
hardest, and it's cheap.

**Shipping:**
- Normalize + validate at the boundary: reject non-`http(s)` schemes, reject credentials-in-URL,
  reject private / loopback / link-local / metadata-endpoint targets — re-checked **after DNS
  resolution** and **on every redirect hop** (DNS rebinding defeats a pre-resolution check alone).
- API key per sensor client, hashed at rest, client ID on every log line and scan row.

**Deferred, with the reason stated:** distributed rate limiting needs shared state (Redis). An
in-process limiter gives *false confidence* behind a load balancer — it looks like protection and
isn't. Shipping nothing plus a documented reason is the more honest engineering position than
shipping a limiter that doesn't limit.

### ADR-0005 — Simulated checks behind the real checks' port

Every check implements one interface and is registered in a `Record<CheckId, CheckRunner>` lookup
(Open/Closed — a new check is a new table entry, never an edit to a branch chain). Simulated and
real adapters are selected at the composition root by config, so promoting to real RDAP/TLS is a
config flag and one new file, not a rewrite.

**Critical:** the simulated checks take injected `Clock` and `Random` ports. Unseeded randomness
would make "basic tests for the scanning pipeline" flaky — the requirement and the simulation are in
direct tension unless the nondeterminism is injectable.

### ADR-0006 — Three separate deployables; versioned event schemas

`api`, `relay`, and `worker` are separate processes from one codebase, each with its own composition
root. A slow check must not starve the API event loop; the relay's throughput is bound by Postgres
while the worker's is bound by network I/O to external check services, so they scale on different
signals. Cheap now, expensive to retrofit.

Event payloads are **explicit, versioned Zod schemas** in `src/events/` (`ScanRequestedV1`), parsed
on receive — never an implicit TypeScript type shared by import. Producer and consumer are separate
deployables and will be deployed at different times; a shared TS type silently drifts across that
boundary, while a parsed schema fails loudly at the exact moment of incompatibility.

**Trade-off:** three services is more to run and reason about than one. Docker Compose hides that
for the reviewer, but it's real operational surface, and I'd consider folding the relay into the API
deployment (still a separate module) if operating it proved noisy.

---

## Architecture

```
  API                 ┌─────────── ONE transaction ───────────┐
POST /v1/scans ─► Zod ─► SSRF guard ─► INSERT scan + INSERT outbox_event
                                                  │            (never publishes directly)
  RELAY                                           ▼
  drain outbox (FOR UPDATE SKIP LOCKED, batched) ─► publish (persistent + confirms)
                                                  │  ─► mark published   [at-least-once]
                                                  ▼
                                        RabbitMQ  scan.events ──► scan.requested
                                                                    │  (dead-letters to scan.dead)
  WORKER                                                            ▼
  parse ScanRequestedV1 ─► CAS claim: pending → in_progress ─► (0 rows = dup, ack & drop)
                                                  │
                                                  ├─ Promise.allSettled over the check registry
                                                  │    ├─ domain-age     (simulated → RDAP)
                                                  │    ├─ ssl-cert       (simulated → native TLS)
                                                  │    └─ redirect-chain (simulated → fetch, bonus)
                                                  │
                                                  └─ ONE transaction: scan_check rows
                                                     + threat score + terminal status
  scan.dead ──► DLQ consumer ──► dlq_event table (manual replay only)

GET /v1/scans/:id ──► scan + its checks
GET /v1/scans     ──► keyset pagination + server-side sort + filter
```

**Layout** (ports & adapters; functional core, imperative shell):

```
src/
  main.api.ts                    three composition roots — the only places deps are
  main.relay.ts                  built and config is read
  main.worker.ts
  config.ts                      Zod-validated env
  events/
    scan-requested.event.ts      explicit VERSIONED Zod schema, parsed on receive
  api/
    routes/scans.router.ts       thin shell
    handlers/*.handler.ts        thin shell
    handlers/*.handler.utils.ts  pure logic
    middleware/                  validateBody(schema), auth, errorHandler, requestContext
  domain/
    scan/model.ts selectors.ts   types, enums, is* predicates
    scan/score.ts                PURE weighted-severity scorer — the highest-value unit test
    scan/status.ts               legal transitions as a data table
  checks/
    check.port.ts                CheckRunner interface + CheckOutcome DU
    registry.ts                  Record<CheckId, CheckRunner>
    simulated/*.check.ts         ships now
    real/*.check.ts              stretch
  messaging/
    publisher.port.ts            enqueue-side port the outbox relay drives
    amqp.ts                      wrapper: declareQueue options REQUIRE dead-letter config
    consumer.ts                  redelivery count from x-death, logged every receive
  outbox/
    outbox.repository.ts         append (in caller's tx) + drain + markPublished
    relay.ts                     the drain loop
  repositories/                  scan.repository.ts (+ .port.ts)
  db/schema.ts migrations/
  utils/                         generateUniqueId, normalizeUrl, withTimeout, logger
```

**Data model:**
- `scan` — `id` (`scan_<base62-time-sortable>`), `url`, `normalized_url`, `domain`, `client_id`,
  `status`, `threat_score`, `verdict`, `idempotency_key`, `request_hash`, `created_at`,
  `updated_at`, `started_at`, `completed_at`, `error`. Unique index on
  `(client_id, idempotency_key)`; PK ordering gives keyset pagination for free.
- `scan_check` — `id`, `scan_id`, `check_id`, `outcome` (`pass`/`warn`/`fail`/`error`), `score`,
  `details` jsonb, `duration_ms`.
- `outbox_event` — `id` (sortable, gives publish ordering), `aggregate_type`, `aggregate_id`,
  `event_type`, `event_version`, `payload` jsonb, `created_at`, `published_at`. Partial index on
  `(id) WHERE published_at IS NULL` so the drain query only ever touches the unpublished tail.
- `dlq_event` — `id`, `queue`, `event_type`, `payload`, `last_error`, `redelivery_count`,
  `received_at`, `replayed_at`. Manual replay only — automatic replay just refills the DLQ.

**Error semantics (explicit, because it's the part that's usually vague):**
- A *check* failing (WHOIS timeout) → that check gets outcome `error`, is excluded from the score
  denominator, and the scan still **completes** with partial results. A WHOIS outage must not
  blackhole every scan in the system.
- The *pipeline* failing (DB unreachable) → nack with bounded redelivery; past the limit the message
  dead-letters, the DLQ consumer persists it to `dlq_event`, and the scan goes `failed`.
- Status is a one-way lattice enforced by a transition table; `completed`/`failed` are terminal.

**API:** `/v1` prefixed. `POST /v1/scans` → `201 {id, createdAt, updatedAt}` (CQS at the boundary —
never echo the resource), or `200` on an idempotency-key replay, or `409` on key reuse with a
different body. `GET /v1/scans/:id` → the resource directly, no envelope. `GET /v1/scans`
→ keyset pagination + server-side sort + filter by status/verdict/domain, shipped day one because
retrofitting pagination is a breaking change. `GET /health` liveness + readiness with a DB probe.
Errors are always `{ error: string }` with correct status codes.

---

## Build order

Sequenced so the submission is coherent at **any** cut point — each phase ends green and committed.

| # | Phase | Contents |
|---|---|---|
| 0 | Scaffold | `/project-init` (CLAUDE.md, eslint stub, husky, VS Code), `docker-compose.yml` (postgres + rabbitmq + 3 services), Dockerfile, config, logger, `docs/plan.md`, the six ADRs |
| 1 | Schema + repo | Drizzle schema, first migration, `ScanRepository` + port, `generateUniqueId` |
| 2 | Submit + read | `POST /v1/scans` (+ `Idempotency-Key`), `GET /v1/scans/:id`, Zod middleware, SSRF guard, error handler. **Scan + outbox row commit together** |
| 3 | Messaging | amqp wrapper (dead-letter config mandatory in the options type), `ScanRequestedV1`, outbox relay, consumer with CAS claim. **Event flows end to end** |
| 4 | Pipeline | Check port + registry + 2 simulated checks, scorer, status transitions. **Working system** |
| 5 | Hardening | Bounded redelivery, DLQ consumer → `dlq_event`, per-check timeouts, partial results, API-key auth |
| 6 | List endpoint | Pagination + sort + filter |
| 7 | README | Setup, architecture, decisions, trade-offs — a **first-class deliverable**, not a footnote |
| 8 | Stretch | Real RDAP + TLS adapters · redirect-chain check · DLQ replay script |

Phases 0–4 are the spine; if time runs out mid-7, the README still ships by being written against
what exists. Phase 3 is the one that grew when we chose a real broker — it is also the phase that
carries most of what the architecture is meant to demonstrate, so it does not get cut.

**Testing** (TDD, driver-first, per the global doctrine — driver written before the unit):
- *Unit:* the scorer (pure, exhaustive — all outcome combinations, partial results, clamping); the
  status transition table; URL normalization + SSRF guard (the adversarial cases: `127.0.0.1`,
  `169.254.169.254`, `[::1]`, decimal/octal IP encodings, credentials-in-URL, redirect to private).
- *Integration (real Postgres on the Compose DB — the one place a real store runs):* a failed
  publish leaves the outbox row unpublished and it is picked up on the next drain; **redelivering
  the same event twice produces exactly one set of `scan_check` rows** (the idempotency claim — the
  single most important test in the suite); a replayed `Idempotency-Key` returns the original scan
  and enqueues nothing, asserted concurrently since that's the case a read-then-write would fail;
  submit→relay→consume→completed with fake checks; redelivery past the limit lands in `dlq_event`.
- RabbitMQ is faked at the port in these tests — the broker's own delivery is Rabbit's to guarantee,
  not ours; what we must prove is that *our* consumer is safe when it redelivers.
- Simulated checks use injected `Clock`/`Random`, so every pipeline test is deterministic.

**Verification before claiming done:** `docker compose up` → `POST` a URL → poll `GET /v1/scans/:id`
through `pending → in_progress → completed` → confirm per-check outcomes and score → **kill the
worker mid-scan** and confirm the unacked message is redelivered and the scan still completes with
exactly one set of check rows → **stop RabbitMQ**, `POST` several URLs, confirm they all still
return `201` (the outbox absorbs the outage), restart the broker and watch the backlog drain →
submit a private-IP URL and confirm `400`. Observed behaviour, not inferred from green tests.

---

## Working agreement during implementation

You have to explain this work to someone else, so documentation is written for that, not for me:

- **Every ADR ends with a `## In one breath` line** — the single sentence that conveys the decision
  and its reason out loud. If a decision can't survive being compressed to one sentence, it isn't
  understood well enough to defend.
- **Every non-obvious choice made below the ADR threshold** (a column type, an index, an error code)
  gets reported in chat as I make it, in one line, so nothing arrives as a surprise in the diff.
- **I stop and ask** whenever a choice is genuinely yours: a trade-off with no dominant answer, a
  scope cut, or anything that changes the API contract. Mechanical choices I make and report.

## Open items I'm carrying, not resolving now

- **Story ceremony:** this is one story (`url-threat-scanner`); `/story-start` opens it and
  `/story-done` closes it, per the global hard rule.
- **Rate limiting is deliberately absent** (ADR-0004) — if you'd rather ship an in-process limiter
  despite the false-confidence argument, it's ~10 minutes in phase 5.
- The per-URL result cache from ADR-0003 is the named next optimization, not a hidden gap.
