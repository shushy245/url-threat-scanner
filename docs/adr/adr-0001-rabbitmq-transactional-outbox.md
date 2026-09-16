# ADR-0001 — RabbitMQ with a transactional outbox

**Status:** accepted · **Date:** 2026-09-16

**Issue.** Saving the scan and publishing its event are two writes. Commit-then-publish-fails leaves
the scan `pending` forever; publish-then-commit-fails hands a worker an event for a scan that
doesn't exist.

**Decision.** `POST` writes the scan **and** an outbox row in one transaction, and never talks to the
broker. A relay drains unpublished rows, publishes to RabbitMQ, and marks them published only after
the broker confirms. Rejected a Postgres `SKIP LOCKED` job table (reversing an earlier choice): it
avoids the dual write instead of solving it, and leaves nowhere for a second consumer to attach.

**Trade-offs.** A broker outage can't fail a submission or lose an event. The cost: two more moving
parts, at-least-once delivery — so every consumer must stay idempotent forever — and a relay that
still polls Postgres. The outbox moves polling off the request path; it doesn't remove it.

**In one breath.** *We never publish and write in two steps — the scan and its event commit together
and a relay pushes them at-least-once, which is safe because the consumer claims work with a
compare-and-swap that makes reprocessing a no-op.*
