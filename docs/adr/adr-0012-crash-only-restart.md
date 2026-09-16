# ADR-0012 — Connection loss exits the process; the supervisor restarts it

**Status:** accepted · **Date:** 2026-09-16

## Context

The relay and worker hold long-lived AMQP connections. Brokers restart, networks partition, and
connections die.

## Decision

**On connection loss, log and exit non-zero.** No hand-rolled reconnect loop.

Docker's restart policy — and any real scheduler — already implements restart-with-backoff correctly.
A bespoke reconnect loop is a second, worse implementation of that: it has to re-establish the
channel, re-declare topology, handle a failure *during* reconnection, and avoid a thundering herd.
That code is subtle, rarely exercised, and therefore rarely correct.

Exiting is safe here specifically because of what surrounds it. Unacked messages are requeued by the
broker when the connection drops, the consumer is idempotent, and the outbox retains anything the
relay had not yet confirmed. There is no in-memory state whose loss matters — which is the property
that makes crash-only design legitimate rather than lazy.

## Consequences

**Easier:** dramatically less code in the failure path, and the restart path is exercised constantly
in normal operation rather than only during incidents.

**Harder:** process churn is visible in orchestrator metrics and can look alarming; a crash-loop
against a persistently down broker needs backoff from the supervisor rather than from us. Compose
uses the default restart policy here, which a production deployment would tune.

## In one breath

*A dropped connection exits the process rather than reconnecting by hand, because the supervisor
already solves restart correctly and nothing in memory is worth saving — the broker requeues, the
consumer is idempotent, and the outbox still holds anything unconfirmed.*
