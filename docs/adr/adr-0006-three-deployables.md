# ADR-0006 — Three deployables; versioned event schemas

**Status:** accepted · **Date:** 2026-09-16

**Issue.** The architecture has three distinct jobs — accept submissions, move events to the broker,
run checks. One process or several?

**Decision.** Three deployables from one codebase (`api`, `relay`, `worker`), each with its own
composition root. The argument is scaling signals, not tidiness: the API is bound by request
concurrency, the relay by Postgres throughput, the worker by network I/O to check services — and a
slow WHOIS lookup must never starve the API's event loop. Event payloads are **explicit, versioned
Zod schemas** (`ScanRequestedV1`) parsed on receive, never a shared TypeScript type: producer and
consumer deploy at different times, so a compile-time type is a promise nothing enforces at the
moment it matters. It drifts silently across a version skew; a parsed schema fails loudly at the
boundary, naming the field.

**Trade-offs.** Gained: independent scaling and failure, unparseable events dead-letter at the edge,
rolling deploys across a skew are safe. Cost: three services to run and observe — Compose hides that
from a reviewer, but it's real operational surface. If the relay proved noisy, the port boundary makes
folding it into the API a deployment decision rather than a rewrite.

**In one breath.** *Three processes because they scale on different signals and a slow check must
never starve the API, and versioned schemas parsed on receive because producer and consumer ship
separately — a shared TypeScript type is a promise nothing enforces across a version skew.*
