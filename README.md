# URL Threat Scanner

A backend service for Above Security's sensor. It takes a suspicious URL, returns a scan id right
away, runs the security checks in the background, and serves the per-check results and a threat
score by id.

Submission and analysis are separate on purpose: a sensor on a user's machine must never wait on a
WHOIS lookup, and a slow check must never slow down ingestion.

---

## Run it

```bash
docker compose up
```

That's the whole setup. Compose starts Postgres, RabbitMQ, a one-shot migration, and the three
service processes — all three wait for the migration, so the schema can't race the app.

API on `http://localhost:3000` · Postgres on host port **5433** (5432 is usually taken) · RabbitMQ UI
on `http://localhost:15672`.

```bash
# submit
curl -X POST http://localhost:3000/v1/scans \
  -H 'content-type: application/json' -H 'x-api-key: dev-key' \
  -H 'Idempotency-Key: 11111111-1111-1111-1111-111111111111' \
  -d '{"url":"https://example.com/login?token=secret"}'
# → { "id": "scan_...", "createdAt": "...", "updatedAt": "..." }

# read it back — poll: pending → in_progress → completed (or failed)
curl http://localhost:3000/v1/scans/scan_... -H 'x-api-key: dev-key'
```

---

## API

| Endpoint | Code | Meaning |
|---|---|---|
| `POST /v1/scans` | `201` | Accepted. Returns only what the client can't know: `{ id, createdAt, updatedAt }`. |
| `POST /v1/scans` | `200` | Replay of an `Idempotency-Key` already used — returns the **original** scan id. |
| `GET /v1/scans/:id` | `200` | The scan, its check outcomes, threat score and verdict. |
| `GET /health` | `200` | Liveness. Never touches the database. |
| `GET /ready` | `200`/`503` | Readiness. Does touch the database. |

Errors are always `{ "error": string }`. `400` bad body or a URL the SSRF guard rejects (nothing is
saved) · `401` missing/unknown `x-api-key` · `404` unknown id, including someone else's scan · `409`
an `Idempotency-Key` reused with a **different** body.

`Idempotency-Key` is optional but recommended — the sensor retries, and without a key a retry creates
a second scan. It's scoped per client and hashed against the *normalized* URL, so a retry differing
only in casing or fragment still counts as the same request.

---

## Architecture

```
  sensor
    │  POST /v1/scans  (returns 201 immediately)
    ▼
 ┌─────┐   one transaction:   ┌──────────┐
 │ api │ ──── scan row ─────► │ Postgres │ ◄──── GET /v1/scans/:id
 └─────┘    + outbox row      └──────────┘
                                ▲       │ unpublished rows
                 check results  │       ▼
                           ┌────────┐ ┌───────┐  ScanRequested  ┌──────────┐
                           │ worker │ │ relay │ ──────────────► │ RabbitMQ │
                           └────────┘ └───────┘                 └──────────┘
                                ▲                                     │
                                └────── consume, run checks ──────────┘
```

**Three processes, one codebase.** They scale on different signals — ingestion is cheap and spiky,
checks are slow and I/O-bound. One process would let a slow check starve the API.

**The publish is never a second write.** `POST` inserts the scan *and* an outbox row in one
transaction. The API never talks to RabbitMQ, so a broker outage can't fail a submission or lose an
event. The relay drains unpublished rows and marks them published only after the broker *confirms* —
`publish()` returning `true` is flow control, not delivery.

Verified cold against the containers: submitting during a full RabbitMQ outage still returns
`201`, and the backlog drains by itself once the broker is back.

**Delivery is at-least-once, so the worker is idempotent by design.** It claims work with one
statement, which is both the idempotency guard and the stale-update guard:

```sql
UPDATE scan SET status = 'in_progress' WHERE id = $1 AND status = 'pending' RETURNING *
```

Zero rows back is split, not collapsed: row exists but isn't `pending` → already handled, ack and
drop; row missing → a real fault, dead-letter. Collapsing both would silently discard real work.

On submit, the handler attempts the insert and handles the unique violation rather than checking
first, so the *database* settles concurrent double-submits — which a read-then-write can't.

---

## Security

- **A URL scanner is an SSRF engine unless you stop it from being one.** The guard rejects
  non-`http(s)` schemes, credentials in the URL, and private/loopback/link-local/metadata targets —
  including obfuscated encodings (`2130706433`, `0x7f.0.0.1`, `127.1`) and IPv4-mapped IPv6. It
  re-checks **after DNS resolution** and on **every redirect hop**: a guard that only reads the string
  is beaten by a public hostname resolving to `127.0.0.1`.
- **Submitted URLs carry session and reset tokens.** Logs record a redacted URL — query keys kept,
  values dropped. Logging one verbatim would turn our logs into a credential store.
- **API keys are stored hashed**, one per client, with the client id on every log line and scan row.

---

## Data model

`scan` (audit record + status machine) · `scan_check` (one row per check per scan) · `outbox_event`
(the atomic publish log, partial index on `published_at IS NULL`) · `dlq_event` (where a failed
message *would* be saved for manual replay — see trade-offs).

Ids are prefixed and time-sortable (`scan_...`): the prefix names the type in logs, and the sortable
body gives pagination a stable cursor and keeps inserts local in the B-tree.

The verdict is four-valued on purpose. `unknown` — every check errored — is not `clean`, because a
security product must never say "safe" when it means "couldn't tell".

---

## Tests

```bash
npm test                   # 83
npm run test:unit          # 70 — pure logic, fakes for every dependency
npm run test:integration   # 13 — the one place a real Postgres runs
```

Driver-first, outside-in. Postgres is real because the properties under test *are* database
properties. RabbitMQ is faked at the port: its delivery is Rabbit's to guarantee, ours is only that
redelivery is safe — so the key test is that the same event delivered twice produces exactly one set
of `scan_check` rows. Simulated checks take an injected `Clock` and `Random`, so "randomized results"
doesn't mean a flaky suite.

Writing the pipeline test first is what pulled the worker's handler out of `main.worker.ts`, where no
test could reach it (ADR-0013).

---

## Trade-offs, and what I'd do next

Time-boxed, so these are deliberate cuts with named fixes — not misses.

- **No rate limiting** (ADR-0004). In-process limiting behind a load balancer is a dashboard that
  lies: N instances means N × the limit. It belongs at the edge or in Redis.
- **The relay still polls Postgres.** The outbox moves polling off the hot path, not out of the
  system. `LISTEN/NOTIFY` would cut the idle latency.
- **No cache for popular URLs.** Every submission is its own audit record (ADR-0003), so the same URL
  is scanned every time. Fix: a short-TTL cache *below* the check layer, invisible to the API.
- **No list endpoint.** Ids are already sortable and keyset pagination is designed for; nothing else
  depends on it, so it was the right cut.
- **Checks are simulated** (ADR-0005), behind the port the real ones implement and chosen by
  `CHECK_MODE` — so real RDAP and TLS adapters are a drop-in. `CHECK_MODE=real` makes the worker
  **refuse to start** rather than quietly fall back to simulated results. The redirect-chain
  bonus is next.
- **The DLQ exists; the consumer that drains it doesn't.** Failures dead-letter to `scan.dead` and sit
  there durably, visible in the RabbitMQ UI, but nothing writes them to `dlq_event` yet.
- **No retry ladder.** A failure dead-letters on the first attempt instead of retrying with backoff —
  bounded and visible, but a transient blip costs the message. `MAX_REDELIVERIES` is declared for it.
- **One bit of debt.** `src/utils/delay.utils.ts` isn't abortable, so the simulated checks carry a
  private abortable sleep. Consolidating it is a pure refactor.

In order, with more time: real check adapters and the redirect chain, the list endpoint, the DLQ
consumer and replay, per-URL caching, then OpenTelemetry traces on the correlation id that already
flows through every log line.

---

## Configuration

Validated with Zod at startup (`src/config.ts`), so the process refuses to boot on a bad value
instead of failing at the first request.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `RABBITMQ_URL` | — | Broker connection string (required) |
| `CHECK_MODE` | `simulated` | `simulated`; `real` refuses to start until the adapters exist |
| `CHECK_TIMEOUT_MS` | `5000` | Per-check timeout; the work is aborted, not abandoned |
| `WORKER_PREFETCH` | `10` | Unacked messages per worker |
| `MAX_REDELIVERIES` | `10` | Declared for the retry ladder; **not yet enforced** |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | Relay drain interval |
| `OUTBOX_BATCH_SIZE` | `100` | Rows per drain |
| `API_KEYS` | — | Comma-separated `clientId:sha256(apiKey)`. Raw keys are never stored. |
| `LOG_LEVEL` | `info` | pino level |

`.env.docker` is committed on purpose — it holds only local credentials matching Compose, which is
what makes one command enough.

---

## Layout

```
src/
  api/          HTTP shell — routes, Zod middleware, handlers, errors
  checks/       the check port, simulated checks, the runner, the scorer
  domain/scan/  model (types and enums only), selectors, translator
  repositories/ port + Drizzle implementation; the outbox write lives here
  events/       versioned event schemas
  db/           schema, client, migrations
  utils/        id generation, SSRF guard and URL normalization, logger
  main.api.ts · main.relay.ts · main.worker.ts    composition roots
docs/adr/       13 decision records, each a 20-second read
```

Dependencies are built in exactly one place per process — the `main.*.ts` composition root. No module
reads config or builds its own dependencies, which is what lets a test swap in a fake repository and
exercise identical wiring.

---

## Design decisions

All thirteen are in [`docs/adr/`](docs/adr/) — issue, decision, trade-offs, one-sentence summary.
Start with [0001](docs/adr/adr-0001-rabbitmq-transactional-outbox.md) (transactional outbox,
reversing an earlier choice), [0003](docs/adr/adr-0003-idempotency-key.md) (idempotency keys over
URL-keyed caching), [0004](docs/adr/adr-0004-security-posture.md) (SSRF guard; no rate limiter on
purpose), [0011](docs/adr/adr-0011-drain-holds-locks-across-publish.md) (holding locks across the
publish).
