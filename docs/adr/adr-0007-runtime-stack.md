# ADR-0007 — Express 5, node-postgres, CommonJS

**Status:** accepted · **Date:** 2026-09-16

**Issue.** Three choices that sit below the architecture but shape every file, recorded so nobody has
to reverse-engineer them.

**Decision.**

- **Express 5, not 4** — a rejected promise in a handler forwards to the error middleware
  automatically. Express 4 needs an `asyncHandler` wrapper on every async route, and the failure mode
  when someone forgets one is a request that hangs until the client times out with nothing in the
  logs. Version 5 deletes the bug class instead of relying on discipline.
- **node-postgres (`pg`), not postgres.js** — the most battle-tested pool in Node, and Drizzle's `pg`
  adapter exposes the transaction API the outbox write depends on. postgres.js is faster on raw
  throughput, but external check latency is the bottleneck here, not the driver.
- **CommonJS output** — ESM is the direction of travel, but CJS avoids extension-specifier churn
  across `tsx`, `vitest` and `drizzle-kit`. A deadline is the wrong time to pay a tooling tax.

**Trade-offs.** Gained: no async-wrapper discipline, no module-resolution friction. Cost: CJS is the
legacy target and will need migrating, and some middleware examples are still written against
Express 4 idioms.

**In one breath.** *Express 5 because it auto-forwards async errors and removes a whole bug class,
`pg` because its pool is the proven one and its transaction API is what the outbox needs, and
CommonJS because ESM specifier churn is a tooling tax I chose not to pay today.*
