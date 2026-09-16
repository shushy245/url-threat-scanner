# ADR-0006 — Three deployables; versioned event schemas

**Status:** accepted · **Date:** 2026-09-16

## Context

The outbox architecture has three distinct jobs: accept submissions, move events to the broker, and
run checks. They could be one process or several.

## Decision

**Three separate deployables from one codebase** — `api`, `relay`, `worker` — each with its own
composition root where dependencies are constructed and config is read.

They scale on different signals, which is the substance of the argument rather than tidiness: the
API is bound by request concurrency, the relay by Postgres throughput, the worker by network I/O to
external check services. A slow WHOIS lookup must not be able to starve the API's event loop. This
is cheap to establish now and expensive to retrofit once modules assume shared process state.

**Event payloads are explicit, versioned Zod schemas** (`ScanRequestedV1`), parsed on receive —
never an implicit TypeScript type shared by import. Producer and consumer are separate deployables
and will be deployed at different times, so a shared compile-time type is a promise that nothing
enforces at the moment it matters: it drifts silently across a version skew and fails somewhere
downstream with a confusing symptom. A parsed schema fails loudly, at the boundary, naming the field.

## Consequences

**Easier:** independent scaling and independent failure; an unparseable event dead-letters at the
edge instead of corrupting a scan; rolling deploys across a version skew are safe by construction.

**Harder:** three services to run, observe, and reason about. Docker Compose hides that from a
reviewer but it is real operational surface. If operating the relay proved noisy I would fold it
into the API deployment as a separate module — the port boundary keeps that a deployment decision
rather than a rewrite.

## In one breath

*Three processes because they scale on different signals and a slow check must never starve the API,
and versioned event schemas parsed on receive because producer and consumer ship separately — a
shared TypeScript type is a promise nothing enforces across a version skew.*
