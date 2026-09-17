# ADR-0012 — Connection loss exits the process; the supervisor restarts it

**Status:** accepted · **Date:** 2026-09-16

**Issue.** The relay and worker hold long-lived AMQP connections. Brokers restart, networks partition,
connections die.

**Decision.** On connection loss, log and exit non-zero. No hand-rolled reconnect loop. Docker's
restart policy — and any real scheduler — already implements restart-with-backoff; a bespoke loop is
a worse second version that must re-establish the channel, re-declare topology, survive a failure
*during* reconnection, and avoid a thundering herd. Exiting is safe here because of what surrounds
it: the broker requeues unacked messages, the consumer is idempotent, and the outbox holds anything
unconfirmed. No in-memory state is worth saving — which is what makes crash-only legitimate rather
than lazy.

**Trade-offs.** Far less code in the failure path, and that path is exercised constantly in normal
operation instead of only during incidents. The cost: process churn shows up in orchestrator metrics
and looks alarming, and a crash-loop against a persistently down broker needs backoff from the
supervisor — Compose sets `restart: unless-stopped` on all three services, which production
would tune further.

**In one breath.** *A dropped connection exits the process rather than reconnecting by hand, because
the supervisor already solves restart correctly and nothing in memory is worth saving — the broker
requeues, the consumer is idempotent, and the outbox still holds anything unconfirmed.*

**Open defect against this (2026-09-17).** Crash-only is safe here *because* the guards around it
hold — and for one input they don't. A non-JSON message crashes the worker *before* the guard that
would dead-letter it, so the broker requeues it and `restart: unless-stopped` replays the crash
indefinitely: 10 restarts in ~40s, observed. Crash-only needs every poison input rejected before the
exit, never after. Phase 11 in `docs/plan.md`.
