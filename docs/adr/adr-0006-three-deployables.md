# ADR-0006 — Three deployables; versioned event schemas

**Status:** accepted · **Date:** 2026-09-16

**Issue.** Three distinct jobs — accept submissions, move events to the broker, run checks. One
process or several?

**Decision.** Three deployables from one codebase (`api`, `relay`, `worker`), each with its own
composition root. The argument is scaling signals, not tidiness: the API is bound by request
concurrency, the relay by Postgres throughput, the worker by network I/O — and a slow WHOIS lookup
must never starve the API's event loop. Event payloads are **versioned Zod schemas**
(`ScanRequestedV1`) parsed on receive, never a shared TypeScript type: producer and consumer deploy
at different times, so a compile-time type drifts silently across a version skew, while a parsed
schema fails loudly at the boundary and names the field.

**Trade-offs.** Independent scaling and failure; an unparseable event dead-letters at the edge instead
of corrupting a scan. The cost: three services to run and observe — Compose hides that from a
reviewer, but it's real operational surface. The port boundary keeps folding the relay into the API a
deployment decision rather than a rewrite.

**In one breath.** *Three processes because they scale on different signals and a slow check must
never starve the API, and versioned schemas parsed on receive because producer and consumer ship
separately — a shared TypeScript type is a promise nothing enforces across a version skew.*

**Open defect against this (2026-09-17).** The trade-off above overstates what ships: an unparseable
event does *not* dead-letter at the edge today. A non-JSON body crashes the worker before the schema
guard runs, and a schema-invalid payload nacks to an exchange with no bound queue and is discarded.
The decision stands — the mechanism that delivers it is Phase 11 in `docs/plan.md`.
