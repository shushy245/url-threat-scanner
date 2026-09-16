# URL Threat Scanner

A backend service that accepts suspicious URLs from Above Security's sensor, runs security checks
asynchronously, and makes per-check results and an overall threat score queryable by scan id.

Submission is decoupled from analysis by design: `POST` commits and returns immediately, and the
checks run in a separate worker process. A sensor on a user's machine must never wait on a WHOIS
lookup, and a slow check must never be able to slow down ingestion.

---

## Quick start

```bash
docker compose up
```

That is the whole setup. Compose brings up Postgres, RabbitMQ, a one-shot migration job, and the
three service processes; `api`, `relay` and `worker` all gate on the migration via
`service_completed_successfully`, so the schema can never race the application. `.env.docker` is
committed deliberately — it holds only local credentials that mirror Compose, which is what makes
the one-command setup actually work.

The API listens on `http://localhost:3000`. Postgres is published on host port **5433** (not 5432,
which is commonly already bound by a local Postgres). RabbitMQ's management UI is on
`http://localhost:15672`.

### Submit a scan

```bash
curl -X POST http://localhost:3000/v1/scans \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-key' \
  -H 'Idempotency-Key: 11111111-1111-1111-1111-111111111111' \
  -d '{"url":"https://example.com/login?token=secret"}'
```

```json
{ "id": "scan_...", "createdAt": "...", "updatedAt": "..." }
```

### Read it back

```bash
curl http://localhost:3000/v1/scans/scan_... -H 'x-api-key: dev-key'
```

Poll it: the scan moves `pending → in_progress → completed` (or `failed`).

---

## API

| Method | Path | Success | Notes |
|---|---|---|---|
| `POST` | `/v1/scans` | `201` | New scan accepted. Returns only `{ id, createdAt, updatedAt }` — the values the client cannot know. |
| `POST` | `/v1/scans` | `200` | Replay of an `Idempotency-Key` already honoured for that client; returns the **original** scan id. |
| `GET` | `/v1/scans/:id` | `200` | The scan with its per-check outcomes, threat score and verdict. |
| `GET` | `/health` | `200` | Liveness. Never touches the database. |
| `GET` | `/ready` | `200`/`503` | Readiness. Does touch the database. |

Errors are always `{ "error": string }` — human-readable and safe to surface.

| Status | When |
|---|---|
| `400` | Malformed body, or a URL the SSRF guard rejects. Nothing is persisted. |
| `401` | Missing or unknown `x-api-key`. |
| `404` | Unknown scan id — including a scan owned by a different client (see ADR-0009). |
| `409` | An `Idempotency-Key` reused with a **different** request body. |

`Idempotency-Key` is optional but recommended: the sensor retries, and without a key a retry creates
a second scan. The key is scoped per client and hashed against the *normalized* URL, so a retry that
differs only in fragment or host casing is still recognised as the same request.

---

## Architecture

```
  sensor
    │  POST /v1/scans
    ▼
 ┌──────┐   one transaction    ┌────────────┐
 │ api  │────────────────────► │  Postgres  │
 └──────┘  scan + outbox row   └────────────┘
                                 ▲        │ unpublished rows
                                 │        ▼
                            ┌─────────┐  ┌───────┐   ScanRequested   ┌──────────┐
                            │ worker  │  │ relay │──────────────────►│ RabbitMQ │
                            └─────────┘  └───────┘                   └──────────┘
                                 ▲                                        │
                                 └────────────────────────────────────────┘
                                              consume, run checks
```

**Three deployables** (ADR-0006) — `api`, `relay`, `worker`. They scale on different signals:
ingestion is cheap and spiky, check execution is slow and I/O-bound. One process would couple them
and let a slow check starve the API.

**The publish is never a second write** (ADR-0001). `POST` opens one transaction that inserts the
scan *and* an outbox row, then commits. The API never talks to RabbitMQ at all, so a broker outage
cannot fail a submission or lose an event. The relay drains unpublished outbox rows
(`FOR UPDATE SKIP LOCKED`, batched), publishes with persistent delivery and **publisher confirms**,
and marks them published only after the confirm. `channel.publish()` returning `true` is flow
control, not a delivery guarantee — marking on that return value is the bug this design exists to
avoid.

**Delivery is at-least-once, so the consumer is idempotent by construction.** If a publish confirms
but the mark-published commit fails, the event republishes. The worker claims work with a single
compare-and-swap:

```sql
UPDATE scan SET status = 'in_progress' WHERE id = $1 AND status = 'pending' RETURNING *
```

That one statement is both the idempotency guard and the stale-update guard. Zero rows returned is
deliberately disambiguated rather than collapsed: row present but not `pending` means already
handled → ack and drop; row absent means a genuine fault → dead-letter. Collapsing both into "ack
and drop" would silently discard real work.

A unique index on `(scan_id, check_id)` is defence in depth behind that claim, and a partial unique
index on `(client_id, idempotency_key)` is what makes the submit path correct — the handler attempts
the insert and handles the unique violation rather than checking-then-inserting, so the *database*
arbitrates concurrent double-submits, which a read-then-write provably cannot.

---

## Key design decisions

Each is an ADR in [`docs/adr/`](docs/adr/) with its full context, alternatives and consequences.

| ADR | Decision |
|---|---|
| [0001](docs/adr/adr-0001-rabbitmq-transactional-outbox.md) | RabbitMQ with a transactional outbox, over a Postgres `SKIP LOCKED` job table. Records a reversal rather than hiding it. |
| [0002](docs/adr/adr-0002-one-message-per-scan.md) | One message per scan, checks concurrent inside it — per-check messages strand scans in `in_progress` on fan-in races. |
| [0003](docs/adr/adr-0003-idempotency-key.md) | `Idempotency-Key` header, not URL-keyed result reuse — a security audit trail must not collapse two observations into one. |
| [0004](docs/adr/adr-0004-security-posture.md) | SSRF guard and API-key auth ship; rate limiting deliberately deferred. |
| [0005](docs/adr/adr-0005-simulated-checks.md) | Checks simulated behind the real checks' port, selected by `CHECK_MODE`. |
| [0006](docs/adr/adr-0006-three-deployables.md) | Three processes, versioned event schemas. |
| [0007](docs/adr/adr-0007-runtime-stack.md) | Express 5, `node-postgres`, CommonJS output. |
| [0008](docs/adr/adr-0008-scan-status-union.md) | Scan status is a discriminated union; `unknown` is not `clean`. |
| [0009](docs/adr/adr-0009-auth-lookup-and-cross-client-reads.md) | Digest-keyed auth lookup; cross-client reads return `404`, not `403`. |
| [0010](docs/adr/adr-0010-liveness-and-readiness.md) | Liveness and readiness are separate endpoints. |

Two worth pulling out, because they are security rather than architecture:

**A URL scanner is an SSRF engine by construction.** The guard rejects non-`http(s)` schemes,
credentials in the URL, and private/loopback/link-local/cloud-metadata targets — including every
`inet_aton` encoding of them (`2130706433`, `0x7f.0.0.1`, `017700000001`, `127.1`) and IPv4-mapped
IPv6. It re-checks **after DNS resolution** and on **every redirect hop**, because a guard that only
inspects the literal is defeated by a public hostname that resolves to `127.0.0.1`.

**Submitted URLs routinely carry session and reset tokens in the query string.** Every log line
records a redacted URL — query keys kept, values dropped. Logging one verbatim would turn our own
logs into a credential store.

---

## Data model

Four tables. `scan` (the audit record and its status machine), `scan_check` (one row per check per
scan), `outbox_event` (the atomic publish log, with a partial index on `published_at IS NULL` so the
relay's drain touches only the unpublished tail), and `dlq_event` (the table a failed
message would be persisted to for **manual, deliberate** replay — automatic replay just re-fills the
DLQ). The table exists; see the trade-offs below for what does and does not write to it.

Ids are prefixed and lexicographically time-sortable (`scan_...`): the prefix names the type in logs
and DB rows, and the sortable body gives keyset pagination a stable cursor and keeps inserts local in
the B-tree instead of scattering like a UUIDv4.

Verdict is deliberately four-valued. `unknown` — every check errored — is distinct from `clean`,
because a security product must never report "safe" when it means "could not tell".

---

## Testing

```bash
npm test              # all
npm run test:unit     # pure logic, fakes for every dependency
npm run test:integration   # the one place a real Postgres runs
```

Written driver-first, outside-in. The unit tier carries the adversarial SSRF cases, the scorer
(exhaustively, including the every-check-errored case that naively divides by zero), and id
generation. Simulated checks take an injected `Clock` and `Random`, so a requirement for randomized
results does not make the test suite flaky.

RabbitMQ is faked at the port: the broker's own delivery semantics are Rabbit's to guarantee, not
ours. What has to be proven is that *our* consumer is safe when it redelivers — which is why the
most important test in the suite is that the same event delivered twice produces exactly one set of
`scan_check` rows.

---

## Trade-offs, and what I'd do with more time

The brief was time-boxed, so these are deliberate cuts with named fixes — not things that were
missed.

**Rate limiting is absent on purpose** (ADR-0004). An in-process limiter behind a load balancer is a
dashboard that lies: N instances means N times the configured limit. Done properly it belongs at the
edge or in shared state (Redis token bucket, or the ingress). Shipping the in-process version would
have bought the appearance of protection rather than protection.

**The relay still polls Postgres.** The outbox moves polling off the hot path; it does not eliminate
it. What the broker actually buys is fan-out to future consumers (alerting, enrichment, ML),
independent scaling, and native routing and DLQ semantics. Claiming "no polling" would be false.
`LISTEN/NOTIFY` would cut the idle latency.

**No result cache for popular URLs.** ADR-0003 chose per-submission audit records over URL-keyed
reuse, which means a URL submitted a thousand times is scanned a thousand times. The fix is a cache
*below* the check layer — keyed on URL with a short TTL, invisible to the `POST` contract — not
collapsing two observations into one scan record.

**No list endpoint.** Keyset pagination plus server-side sort and filter is designed for and the ids
are already sortable, but it is not built. It was the right thing to cut: nothing else depends on it.

**Checks are simulated** (ADR-0005). Both sit behind the port the real ones implement, selected by
`CHECK_MODE`, so the real RDAP (`rdap.verisign.com`) and native-TLS adapters are a drop-in rather
than a refactor. The redirect-chain check — the brief's bonus — is the same shape and is where I
would go next.

**The dead-letter queue exists; the consumer that drains it does not.** A message whose handler
fails is dead-lettered to `scan.dead`, where it sits durably — nothing is silently lost, and it can
be inspected in the RabbitMQ management UI. What is missing is the consumer that would persist it to
the `dlq_event` table, so that table is present but never written to, and there is no replay script.

**There is no retry ladder.** A handler failure dead-letters on the first attempt rather than
retrying with backoff. That is bounded and visible, which is the property that matters most, but it
is not retry: a transient blip that a single retry would have absorbed currently costs the message.
Bounded redelivery with backoff is the next piece of hardening, and `MAX_REDELIVERIES` is already
declared for it.

With a longer clock, in order: real check adapters and the redirect chain, the list endpoint, the DLQ
consumer and replay script, per-URL result caching, and OpenTelemetry traces wired to the
correlation id that already flows through every log line.

---

## Configuration

All environment variables are validated with Zod at startup (`src/config.ts`) — the process refuses
to boot on a bad value rather than failing later at the first request.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `RABBITMQ_URL` | — | Broker connection string (required) |
| `CHECK_MODE` | `simulated` | `simulated` or `real` |
| `CHECK_TIMEOUT_MS` | `5000` | Per-check timeout; the work is aborted, not just abandoned |
| `WORKER_PREFETCH` | `10` | Unacked messages per worker |
| `MAX_REDELIVERIES` | `10` | Declared for the retry ladder; **not yet enforced** — see trade-offs |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | Relay drain interval |
| `OUTBOX_BATCH_SIZE` | `100` | Rows per drain |
| `API_KEYS` | — | Comma-separated `clientId:sha256(apiKey)` pairs. Raw keys are never stored. |
| `LOG_LEVEL` | `info` | pino level |

---

## Layout

```
src/
  api/          HTTP shell — routes, Zod middleware, handlers, error handling
  checks/       the check port, simulated checks, the runner and the scorer
  domain/scan/  model (types and enums only), selectors, translator
  repositories/ port + Drizzle implementation; the outbox write lives here
  events/       versioned event schemas
  db/           schema, client, migrations
  utils/        id generation, the SSRF guard and URL normalization, logger
  main.api.ts / main.relay.ts / main.worker.ts    composition roots
docs/
  plan.md       the implementation plan and its test-case checklist
  adr/          the architecture decisions
```

Dependencies are constructed in exactly one place per process — the `main.*.ts` composition root.
No module reads config or builds its own dependencies, which is what lets a test swap the repository
for a fake and exercise the identical wiring.
