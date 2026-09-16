# ADR-0013 — Real Postgres, faked broker, outside-in

**Status:** accepted · **Date:** 2026-09-16

**Issue.** The pipeline spans HTTP, a database, a broker and three processes. Testing all of it
through every real dependency is slow and flaky; testing none of it proves nothing.

**Decision.** **Postgres is real**, because the properties under test *are* database properties: a
partial unique index arbitrating concurrent submissions, `SKIP LOCKED` on the drain, a conditional
`UPDATE` as compare-and-swap. A fake repository would only prove our mock behaves like our mock.
**RabbitMQ is faked at the port**, because its delivery is RabbitMQ's problem — ours is only that
redelivery is safe, which is provable by invoking the consumer twice with the same envelope.
**Outside-in:** the pipeline tests were written first and left skipped, and that ordering paid
immediately — the worker's handler was inline in its composition root where no test could reach it,
so writing the test first is what produced `createProcessScan` as a unit.

**Trade-offs.** The suite runs in seconds, is deterministic, and every assertion is about our own
behaviour. The cost: `npm test` isn't hermetic — it needs Postgres running (Testcontainers is the
next step) — and nothing automated exercises the real AMQP wire format, which is manual verification
against the running stack.

**In one breath.** *Postgres is real because the guarantees under test are database guarantees, the
broker is faked because its delivery is its own problem and ours is only that redelivery is safe —
and the tests were written outside-in, which is what forced the worker's handler out of its
composition root.*
