# ADR-0001 — RabbitMQ with a transactional outbox

**Status:** accepted · **Date:** 2026-09-16

**Issue.** Saving the scan and publishing its event are two writes. If the row commits and the
publish fails, the scan is stuck `pending` forever; if the publish lands and the commit fails, a
worker gets an event for a scan that doesn't exist.

**Decision.** `POST` writes the scan **and** an outbox row in one transaction, and never talks to
the broker. A separate **relay** drains unpublished rows and publishes them to RabbitMQ, marking
them published only after the broker confirms. Rejected: a Postgres `SKIP LOCKED` job table (this
reverses an earlier choice) — it avoids the dual write rather than solving it, and leaves nowhere
for a second consumer to attach and no way to scale the queue apart from the database.

**Trade-offs.** Gained: a broker outage can't fail a submission or lose an event; new consumers
attach without touching the producer. Cost: two more moving parts, and delivery is *at-least-once* —
a confirmed publish whose mark-published fails will republish, so every consumer must be idempotent
forever. Honest caveat: the relay still polls Postgres. The outbox moves polling off the request
path; it doesn't remove it.

**In one breath.** *We never publish and write in two steps — the scan and its event commit together
in Postgres and a relay pushes them at-least-once, which is safe because the consumer claims work
with a compare-and-swap that makes reprocessing a no-op.*
