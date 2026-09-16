# ADR-0003 — `Idempotency-Key` header, not URL-keyed result reuse

**Status:** accepted · **Date:** 2026-09-16

**Issue.** "Do we dedupe?" is two questions. **Retry safety:** the sensor's POST timed out and it
retries — don't create a second scan. **Cost:** a popular URL arrives a thousand times — don't run a
thousand WHOIS lookups. One URL-keyed cache answers both badly.

**Decision.** Solve retry safety with an optional `Idempotency-Key`; every submission stays its own
scan. A partial unique index on `(client_id, idempotency_key)` backs it, and the handler attempts the
insert and handles the unique violation — so the database arbitrates concurrent double-submits, which
a read-then-write provably cannot. Same key, same body → `200` and the original scan; same key,
different body → `409`. No URL cache, because this is an audit trail: each submission is a real
observation, and any TTL is wrong in the direction that matters — the domain that was clean an hour
ago is the one that turns malicious.

**Trade-offs.** Retries are safe and history stays faithful. The cost: popular-URL work is unbounded.
The fix, when it's real, is a short-TTL cache **under the check layer** — a caching concern, not an
API-contract one.

**In one breath.** *Idempotency keys make retries safe without lying about history — every submission
stays its own audit record, and duplicate work gets solved by a cache beneath the checks rather than
a contract that pretends two observations were one.*
