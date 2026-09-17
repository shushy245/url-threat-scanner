# Changelog

## Story `url-threat-scanner` — 2026-09-16

**Pain.** Above's sensor sees suspicious URLs on pages users visit, but had nowhere to send them for
analysis — and any such service must answer instantly while the actual checks take seconds.

**Fix.** A backend that accepts a URL, returns a scan id immediately, and runs security checks
asynchronously, with the scan record and its "go do the work" event committed in a single database
transaction *(instead of: a Postgres job table, which avoids the dual-write problem rather than
solving it and leaves nowhere for a second consumer to attach)*.

**Trade-off.** Three processes and two infrastructure dependencies instead of one, and delivery is
at-least-once — so every consumer must stay idempotent forever. The rejected job-table design would
have been simpler to run but would have capped scaling and ruled out future consumers such as
alerting or enrichment.

**Result.** A submitted URL reaches a scored verdict in ~2–3s; submissions keep succeeding through a
total broker outage and drain automatically when it returns (observed, not inferred). 83 automated
tests (70 unit, 13 integration), 13 ADRs, 86 files, +5,575 lines (`git diff --stat`).

### Known gaps, deliberately
- No automated HTTP-layer tests — auth 401, body 400, unknown-id 404 and cross-client 404 are
  verified only by hand against the running containers.
- No test for two concurrent relay instances (the `SKIP LOCKED` no-double-publish claim).
- No test for a malformed event dead-lettering, nor for log redaction or graceful shutdown.
- Retry ladder, DLQ consumer, list endpoint and real RDAP/TLS adapters are cut, not missing by
  accident — see the README trade-offs section.

### Defects found after close-out — 2026-09-17

Two open defects, found by injecting messages straight at the broker rather than through the API.
Both are reproduced against the running stack; details and fixes in Phase 11 of `docs/plan.md`.

- **A non-JSON message crash-loops the worker.** The `JSON.parse` in `consumer.ts` sits outside the
  try/catch, so a malformed body kills the process, the message is requeued unacked, and the restart
  policy feeds it back — 10 crashes in ~40s from one message. The guard meant to dead-letter it is
  the next statement.
- **Dead-lettered messages are silently dropped.** `declareTopology` asserts the `scan.dlx` exchange
  but never declares or binds `scan.dead`, so nacks route to an exchange with no bindings and vanish.
  Makes the "sits there durably in the RabbitMQ UI" claim false; README corrected.

Neither is reachable through the HTTP API, and everything else re-verified green: 83/83 tests, every
documented status code, SSRF rejection, idempotency semantic and log-redaction claim confirmed live.
