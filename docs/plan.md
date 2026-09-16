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

| # | Phase | Status | Contents |
|---|---|---|---|
| 0 | Scaffold | ✅ done | package/tsconfig/eslint, `docker-compose.yml` (postgres + rabbitmq + 3 services + one-shot migrate), Dockerfile, `docs/plan.md`, the six ADRs |
| 1 | Schema + repo | ✅ done | Drizzle schema, first migration, `ScanRepository` + port, `generateUniqueId` |
| 2 | Submit + read | ✅ done | `POST /v1/scans` (+ `Idempotency-Key`), `GET /v1/scans/:id`, Zod middleware, SSRF guard, error handler. **Scan + outbox row commit together** |
| 3 | Messaging | ✅ done | amqp wrapper (dead-letter config mandatory in the options type), `ScanRequestedV1`, outbox relay, consumer with CAS claim. **Event flows end to end** |
| 4 | Pipeline | ✅ done | Check port + registry + 2 simulated checks, scorer, status transitions. **Working system** |
| 5 | Hardening | ⚠️ partial — dead-letter type + AbortController timeout only; retry ladder cut | Bounded redelivery, DLQ consumer → `dlq_event`, per-check timeouts, partial results, API-key auth |
| 6 | List endpoint | ❌ cut for time | Pagination + sort + filter |
| 7 | README | ✅ done | Setup, architecture, decisions, trade-offs — a **first-class deliverable**, not a footnote |
| 8 | Stretch | ❌ cut for time — CHECK_MODE=real throws rather than faking | Real RDAP + TLS adapters · redirect-chain check · DLQ replay script |

**This table is the task list and its live status.** Each phase ends green, lint-clean and
committed; the status column is updated in the same commit, so `git log` and this table never
disagree.

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

---

## Story `url-threat-scanner` — Cases

The TDD checklist. Enumerated before implementation, because domain knowledge is cheapest to
extract at planning time — a missing "what happens on X + Y?" is a plan line here, not a bug found
in review later. `[P]` marks a case that came out of the pre-mortem rather than the spec.

### Submission
- Given a valid URL, when submitted, then `201` with a scan id and the scan persists as `pending`.
- Given a valid URL, when submitted, then the scan row and its outbox row commit in ONE transaction.
- Given an invalid URL / missing body, when submitted, then `400 { error }` and nothing persists.
- Given no API key, when submitted, then `401` and nothing persists.
- Given an `Idempotency-Key` already used by that client, when resubmitted with the same body, then
  `200` with the ORIGINAL scan id and no second outbox row.
- Given an `Idempotency-Key` already used by that client, when resubmitted with a DIFFERENT body,
  then `409`.
- `[P]` Given two identical submissions racing concurrently with the same key, when both commit,
  then exactly one scan exists — the unique index arbitrates, not a read-then-write.

### SSRF guard
- Rejects non-`http(s)` schemes (`file:`, `gopher:`, `javascript:`).
- Rejects credentials-in-URL (`https://user:pass@host`).
- Rejects private / loopback / link-local literals: `127.0.0.1`, `10.0.0.1`, `192.168.1.1`,
  `169.254.169.254` (cloud metadata), `[::1]`, `[fd00::1]`.
- `[P]` Rejects obfuscated loopback encodings: `2130706433`, `0x7f.0.0.1`, `017700000001`.
- `[P]` Rejects a public hostname that RESOLVES to a private address (DNS rebinding) — the guard
  must re-check after resolution, not only on the literal.

### Outbox + relay
- Given unpublished outbox rows, when the relay drains, then they publish and are marked published.
- `[P]` Given the broker rejects/times out the publish, then `published_at` stays NULL and the row
  is retried on the next drain — **the mark must not happen before the publisher confirm**.
  (`channel.publish()` returning `true` is flow control, NOT a delivery guarantee.)
- `[P]` Given two relay instances draining concurrently, then no outbox row is published twice —
  `FOR UPDATE SKIP LOCKED` inside the same transaction as the mark.
- Given RabbitMQ is down, when a URL is submitted, then the API still returns `201` and the event
  drains once the broker returns.

### Consumer idempotency
- Given a `ScanRequested` event, when consumed, then the scan moves `pending → in_progress`.
- **Given the SAME event delivered twice, then exactly one set of `scan_check` rows exists** — the
  single most important test in the suite.
- `[P]` Given the CAS claim returns zero rows, then distinguish the two causes: scan row *present
  but not pending* → already handled, ack and drop; scan row *absent* → genuine fault, dead-letter.
  Collapsing both into "ack and drop" silently discards real work.
- Given a malformed / unknown-version event payload, then it dead-letters rather than crashing the
  consumer.
- Given redeliveries past `MAX_REDELIVERIES`, then the message lands in `dlq_event` and the scan is
  `failed`.

### Check pipeline
- Given all checks pass, then the scan completes with a low score and a `clean` verdict.
- Given a failing check, then its outcome is `fail` and the score rises by that check's weight.
- Given one check throws, then it records outcome `error`, the OTHER checks still record, and the
  scan still **completes** — a WHOIS outage must not blackhole every scan.
- `[P]` Given EVERY check errors, then the score is not `NaN` — excluding errored checks from the
  denominator divides by zero when the denominator is empty. Explicit branch required.
- `[P]` Given a check hangs past `CHECK_TIMEOUT_MS`, then it records `error` AND the underlying work
  is actually aborted — a bare `Promise.race` returns early but leaves the work running and the
  timer holding the event loop open. AbortController + `clearTimeout` in a `finally`.
- Given simulated checks with a seeded `Random` and a fixed `Clock`, then results are deterministic.

### Query
- `GET /v1/scans/:id` returns the scan with its per-check outcomes; unknown id → `404`, not `500`.
- `GET /v1/scans` paginates by keyset, sorts server-side, and filters by status/verdict/domain.

### Cross-cutting
- `[P]` Submitted URLs may carry session tokens in the query string. Logs must record a **redacted**
  URL — never the raw query. Doctrine: log sensitive operations, never sensitive values.
- Graceful shutdown: `SIGTERM` closes the channel so in-flight messages requeue rather than being
  lost with the process.

Pre-mortem — the 5 bugs most likely to bite, written as red-first cases:

1. Marking the outbox row published before the broker confirms. channel.publish() returning true is flow control, not a delivery guarantee — the trap is that it looks like success. Without a ConfirmChannel and an awaited confirm, a broker hiccup drops the event forever and the scan sits pending for eternity.
2. "Zero rows from the CAS claim" is ambiguous. Row present but not pending means already handled → ack and drop. Row absent means a genuine fault → dead-letter. Collapsing both into "ack and drop" silently discards real work, and it's the natural way to write it.
3. Timeouts that don't cancel. A bare Promise.race returns early but leaves the check running and the timer holding the event loop open. Needs AbortController plus clearTimeout in a finally.
4. NaN threat score. "Errored checks are excluded from the denominator" divides by zero when every check errors. That NaN goes straight into a numeric column.
5. Concurrency: two relay instances double-publishing — the drain must hold FOR UPDATE SKIP LOCKED in the same transaction as the mark.

---

## Phase 9 — SSRF guard verification findings (open, fix before sign-off)

Findings from an adversarial verification pass over `src/utils/url.utils.ts` as committed in
`dd3d65e` — 28 adversarial URLs and 14 bare addresses probed against the built module, not a code
read alone. The module is sound where it counts: every `inet_aton` encoding is blocked
(`2130706433`, `0x7f000001`, `017700000001`, `127.1`, `0x7f.0.0.1`), and `http://①②⑦.0.0.1/`
— Unicode digit lookalikes — normalizes to `127.0.0.1` and blocks.

Ordered by severity. Each line is a task; `sev` is the honest exploitability, not the scare value.

| # | sev | Finding | Fix |
|---|---|---|---|
| 9.1 | **high** | `isBlockedIpAddress` has **zero call sites** — `grep` over `src` finds none outside its own test. The DNS-rebinding defence is written and tested but not in the request path; `submit-scan.handler.ts` imports `validateSubmittedUrl`/`isValidTarget`/`redactUrl` only. | Call it after DNS resolution and again on every redirect hop, per ADR-0004. |
| 9.2 | **high** | `http://localhost/` is **allowed**. So are `http://metadata.google.internal/` and `http://127.0.0.1.nip.io/` (public DNS, resolves to loopback by design). Architecturally these are meant to be caught post-DNS — but with 9.1 open, the most obvious SSRF target in existence passes end to end. No test covers any of these hostnames. | Add a literal-stage hostname denylist (`localhost`, `*.localhost`, `metadata.google.internal`, `*.internal`) so the defence does not rest entirely on 9.1. |
| 9.3 | medium | **Dead branch that looks like a control** — `url.utils.ts:168`: `if (first === 0x00_64 && fifth === 0) return undefined;` sits directly above `return undefined`, so it does nothing. It reads as intended NAT64 handling, and `http://[64:ff9b::7f00:1]/` (NAT64 well-known prefix wrapping 127.0.0.1) is **allowed**. | Implement it — unwrap the low 32 bits exactly as the `::ffff:` path above does — or delete it. Dead code resembling a security control is worse than none, because a reader credits it. |
| 9.4 | low | `http://[::127.0.0.1]/` (IPv4-**compatible** IPv6, the deprecated sibling of `::ffff:`) normalizes to `[::7f00:1]` and is **allowed**; `findBlockedIpv6Label` unwraps only the `::ffff:` form. Verified not exploitable on this stack before flagging it: `net.connect({host:'::7f00:1'})` → `EHOSTUNREACH`, i.e. the form is not routed. A completeness gap, not a live bypass. | Fold into the 9.3 fix. |
| 9.5 | medium | **The post-DNS guard fails open.** `isBlockedIpAddress` returns `false` for `''`, `'not-an-ip'`, and `'127.0.0.1 '` (trailing space) — anything unparseable is reported as not-blocked. | Trim, then reject non-IP input explicitly. A security primitive defaults closed; `return false` on "I could not parse this" is the wrong default. |
| 9.6 | medium | **A trailing dot splits the domain key.** `http://example.com./` yields `domain = 'example.com.'` where `http://example.com/` yields `'example.com'` — same site, two values. Fragments the `scan_domain_idx` filter and every per-domain aggregation on the list endpoint. | Strip the trailing dot in `normalize`. One line. |
| 9.7 | low | `PARSED_BLOCKED_RANGES` uses `parseIpv4(address) ?? 0`, so a typo'd CIDR row silently becomes base `0` and stops enforcing — the silent-fallback failure mode, in the one table where it is least acceptable. | Throw at module init on an unparseable row. Fail loudly at startup, never quietly at request time. |
| 9.8 | note | `redactUrl` correctly strips embedded credentials (`https://u:p@x.com/…` → `https://x.com/…`) but **no test locks that in**; path tokens (`/reset/TOKEN123`) are preserved by design. | Add the credential-stripping test. State the path-token trade-off in the README rather than leaving it silent. |

**Test-style deviation (prose-strength only — this repo has no lint wiring):** `url.utils.test.ts`
asserts with raw `expect` in test bodies through a `reasonFor` helper, where the doctrine puts
assertions behind a driver's `assert.*` methods (Behaviour-Driven Development — assertions live in
the driver so a contract change touches one file, not thirty). Recorded rather than silently
accepted; not worth a rewrite inside the time budget.

**Coverage gaps worth closing if 9.1–9.2 are fixed:** `localhost` and internal-hostname literals;
the trailing-dot normalization; `isBlockedIpAddress` on unparseable input; NAT64 and
IPv4-compatible IPv6.

**If the clock beats these:** 9.1 and 9.2 are the only two that change the security posture of the
running service — everything below them is completeness. Shipping with 9.3–9.8 open and *named in
the README's trade-offs* is a defensible position; shipping with 9.1 open and unmentioned is not,
because the ADR claims a post-resolution re-check the code does not perform.
