# ADR-0013 — Real Postgres, faked broker, outside-in

**Status:** accepted · **Date:** 2026-09-16

## Context

The pipeline spans an HTTP boundary, a database, a message broker and three processes. Testing all of
it through every real dependency is slow and flaky; testing none of it proves nothing.

## Decision

**Postgres is real. RabbitMQ is faked at the port. Tests are written outside-in.**

Postgres is real because the properties under test *are* database properties: a partial unique index
arbitrating two concurrent submissions, `FOR UPDATE SKIP LOCKED` on the drain, a conditional UPDATE
as compare-and-swap. A fake repository would assert that our mock behaves like our mock.

RabbitMQ is faked because its delivery guarantees are RabbitMQ's to keep, not ours to re-verify. What
must be proven is that *our* consumer is safe when a redelivery happens — and that is provable by
invoking the consumer twice with the same envelope, which is both faster and more deterministic than
persuading a real broker to redeliver on cue.

**Outside-in:** the two pipeline tests were written first and left skipped while the inner circles
were built. That ordering paid for itself immediately — the worker's handler was inline in its
composition root where no test could reach it, so writing the test first is what produced
`createProcessScan` as a unit. The test could not be written against the shape the code had, so the
shape changed.

Simulated checks take an injected seeded generator. The brief asks for randomized results *and* for
pipeline tests; those requirements conflict unless the randomness is a dependency.

## Consequences

**Easier:** the suite runs in seconds, is deterministic, and every assertion is about our own
behaviour.

**Harder:** integration tests need Postgres running, so `npm test` is not hermetic — Testcontainers
would fix that and is the documented next step. And nothing automated exercises the real AMQP wire
format; that is covered by manual verification against the running stack, which is stated plainly in
the README rather than implied to be under test.

## In one breath

*Postgres is real because the guarantees under test are database guarantees, the broker is faked
because its delivery is its own problem and ours is only that redelivery is safe — and the tests were
written outside-in, which is what forced the worker's handler out of its composition root.*
