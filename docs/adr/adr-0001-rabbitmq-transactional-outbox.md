# ADR-0001 — RabbitMQ with a transactional outbox

**Status:** accepted · **Date:** 2026-09-16

## Context

A submission must return immediately and the checks must run asynchronously, so work has to cross a
process boundary durably. The hard constraint is that **persisting the scan and publishing its event
must not be two independent writes** — if the row commits and the publish fails, the scan is stuck
`pending` forever; if the publish succeeds and the commit fails, a worker consumes an event for a
scan that does not exist.

## Decision

**RabbitMQ, fed by a transactional outbox.** Rejected: a Postgres `FOR UPDATE SKIP LOCKED` job
table, and BullMQ/Redis.

This reverses an earlier choice, and the reversal is the interesting part. A Postgres-backed queue
is a legitimate production pattern (Oban, River, Solid Queue), and it has one genuine advantage:
enqueueing in the same transaction as the insert means the dual-write problem never *arises*. But it
buys correctness by **removing the problem rather than solving it**, and it pays for that with a
ceiling this system will hit — the queue contending with OLTP traffic on the same database, no
independent scaling of queue infrastructure, and nowhere for a second consumer (alerting,
enrichment, an ML pipeline) to attach.

The outbox gets the same atomicity without the ceiling:

1. `POST` opens one transaction: `INSERT scan` + `INSERT outbox_event`. Commit. The API never talks
   to RabbitMQ, so **a broker outage cannot fail a submission or lose an event**.
2. The **relay** drains unpublished rows (`FOR UPDATE SKIP LOCKED`, batched), publishes them on a
   confirm channel, and marks them published only after the broker confirms.
3. The **worker** consumes and runs the checks.

**Delivery semantics, stated rather than assumed.** The relay is *at-least-once*: if the broker
confirms but the mark-published commit then fails, the event republishes. That is acceptable only
because the consumer is idempotent by construction — it claims work with
`UPDATE scan SET status='in_progress' WHERE id=$1 AND status='pending' RETURNING *`. That single
compare-and-swap is simultaneously the idempotency guard and the stale-update guard.

**Dead-lettering** is mandatory at the type level: queues are declared through a wrapper whose
options type requires dead-letter config, so omitting it is a compile error rather than a code-review
miss. Past `MAX_REDELIVERIES` a message dead-letters to `scan.dead`, whose consumer persists it to
`dlq_event` for **manual** replay — automatic replay just refills the DLQ.

## Consequences

**Easier:** submissions survive broker outages; new consumers attach without touching the producer;
queue and database scale independently; DLQ/routing/redelivery are the broker's native semantics
rather than hand-rolled columns.

**Harder:** three processes instead of two, and one more container. Two moving parts (relay,
consumer) where a Postgres queue needed one. Exactly-once is still not on offer — it never is —
so every consumer must stay idempotent, which is now a standing design obligation.

**Honest caveat:** the relay polls Postgres, so this does *not* eliminate polling; it moves polling
off the request path. Claiming "no polling" would be false.

## In one breath

*We never publish and write in two steps — the scan row and its event commit together in Postgres,
and a relay pushes them to RabbitMQ at-least-once, which is safe because the consumer claims work
with a compare-and-swap that makes reprocessing a no-op.*
