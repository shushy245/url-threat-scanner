# ADR-0010 — Liveness and readiness are separate endpoints

**Status:** accepted · **Date:** 2026-09-16

**Issue.** An orchestrator asks two different questions — "is this process broken, restart it?" and
"can this instance serve traffic right now?" One `/health` endpoint conflates them.

**Decision.** `GET /health` is liveness and deliberately does **not** touch the database. `GET /ready`
is readiness and does. If liveness probed the database, a brief database blip would fail liveness on
every instance at once and the orchestrator would kill every healthy process — turning a recoverable
hiccup into a full outage with a cold-start stampede on the way back. Readiness *should* fail during
that blip: those instances genuinely can't serve, so pulling them from the load balancer while
leaving them running is exactly right.

**Trade-offs.** Dependency outages degrade instead of cascading, and instances rejoin automatically.
The cost: two endpoints to configure, and wiring the wrong one to the wrong probe gets the worst of
both — so the mapping is spelled out in the README.

**In one breath.** *Liveness never touches the database, because a probe that does turns a
five-second database blip into every instance being killed at once — readiness is the one allowed to
fail.*
