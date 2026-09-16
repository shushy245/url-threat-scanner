# ADR-0003 — `Idempotency-Key` header, not URL-keyed result reuse

**Status:** accepted · **Date:** 2026-09-16

## Context

The sensor submits URLs from pages users actually visit, so traffic is heavily skewed toward popular
domains and the same URL arrives constantly. "Do we dedupe?" sounds like one question. It is two:

- **Retry safety** — the sensor's POST timed out and it retries; we must not create a second scan.
- **Cost** — the same URL is submitted a thousand times; we must not run a thousand WHOIS lookups.

Conflating them into a single URL-keyed cache answers both badly.

## Decision

**Solve retry safety now with an `Idempotency-Key` header. Every distinct submission remains its own
scan.** Document the cost problem with a named fix rather than pre-solving it in the wrong layer.

The decisive reason is that this is a **security audit trail**. Each submission is a real observation
— this user, this page, this moment. Collapsing distinct observations into one cached verdict
destroys evidence the product exists to retain. And any TTL is wrong in the direction that matters:
the domain that was clean an hour ago is precisely the one that turns malicious.

Mechanics:
- `Idempotency-Key` header, optional but honored (Stripe semantics).
- Unique index on `(client_id, idempotency_key)`. The write path **attempts the insert and handles
  the unique violation**, rather than checking-then-inserting — the database arbitrates the
  concurrent double-submit, which a read-then-write provably cannot.
- Replay with the same body → `200` and the original scan. Same key, **different** body → `409`,
  detected by a stored hash of the normalized request. Silently returning the first result for a
  different payload is the failure mode that makes idempotency keys dangerous.
- Keys expire on a configurable window (24h default).

## Consequences

**Easier:** retries are safe; the audit trail stays faithful; the API contract says exactly one thing
about caching, which is "it doesn't."

**Harder:** popular-URL cost is unbounded — N submissions of a domain means N lookups.

**The named fix, for when that cost becomes real:** a short-TTL result cache keyed on the normalized
URL, placed **underneath the check layer**. Each scan stays its own audit record while the expensive
lookup is shared. That it belongs below the checks and not in the `POST` semantics is the whole
point — it is a caching concern, not an API-contract concern.

## In one breath

*Idempotency keys make retries safe without lying about history — every submission stays its own
audit record, and the duplicate-work problem gets solved by a cache under the checks rather than by
a contract that pretends two observations were one.*
