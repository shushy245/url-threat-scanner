# ADR-0007 — Express 5, node-postgres, CommonJS

**Status:** accepted · **Date:** 2026-09-16

## Context

Three runtime choices sit below the architecture but shape every file, so they are recorded rather
than left as defaults someone has to reverse-engineer.

## Decision

**Express 5, not 4.** In Express 5 a rejected promise inside a handler is forwarded to the error
middleware automatically. Under Express 4 every async handler needs an `asyncHandler` wrapper, and
the failure mode is that someone eventually forgets it on one route — producing a request that hangs
until the client times out, with nothing in the logs. Choosing 5 deletes that class of bug instead of
relying on discipline.

**node-postgres (`pg`), not postgres.js.** `pg.Pool` is the most battle-tested connection pool in the
Node ecosystem, and Drizzle's `node-postgres` adapter exposes the transaction API that the outbox
write path depends on. Trade-off: postgres.js is measurably faster on raw throughput. That is not the
bottleneck here — external check latency is — so pooling maturity wins.

**CommonJS output.** ESM is the direction of travel, and under a different clock this would be ESM.
CJS avoids extension-specifier churn across `tsx`, `vitest` and `drizzle-kit`, which under a tight
deadline is a real risk of losing time to tooling rather than to the problem. This is the pragmatic
call, stated as such.

## Consequences

**Easier:** no async-wrapper discipline to maintain; no module-resolution friction in the toolchain.

**Harder:** CJS is the legacy target and will eventually need migrating; Express 5 is newer than 4,
so some middleware ecosystem examples are still written against 4's idioms.

## In one breath

*Express 5 because it auto-forwards async errors and removes a whole bug class, `pg` because its pool
is the proven one and the transaction API is what the outbox needs, and CommonJS because ESM
specifier churn is a tooling tax I chose not to pay today.*
