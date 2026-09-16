# ADR-0003 — `Idempotency-Key` header, not URL-keyed result reuse

**Status:** accepted · **Date:** 2026-09-16

**Issue.** "Do we dedupe?" is two questions. **Retry safety:** the sensor's POST timed out and it
retries — don't create a second scan. **Cost:** the same popular URL arrives a thousand times —
don't run a thousand WHOIS lookups. One URL-keyed cache answers both badly.

**Decision.** Solve retry safety with an optional `Idempotency-Key` header (Stripe semantics), and
keep every submission its own scan. A partial unique index on `(client_id, idempotency_key)` backs
it, and the write path attempts the insert and handles the unique violation rather than
checking-then-inserting — so the database arbitrates concurrent double-submits, which a
read-then-write provably cannot. Replay with the same body returns `200` and the original scan; the
same key with a **different** body returns `409`. The decisive reason is that this is a security
audit trail: each submission is a real observation, and any cache TTL is wrong in the direction that
matters — the domain that was clean an hour ago is the one that turns malicious.

**Trade-offs.** Gained: retries are safe, history stays faithful, the API says exactly one thing
about caching. Cost: popular-URL work is unbounded. Named fix: a short-TTL cache keyed on the
normalized URL placed **under the check layer**, so each scan stays its own record.

**In one breath.** *Idempotency keys make retries safe without lying about history — every
submission stays its own audit record, and duplicate work gets solved by a cache beneath the checks
rather than a contract that pretends two observations were one.*
