# ADR-0010 — Liveness and readiness are separate endpoints

**Status:** accepted · **Date:** 2026-09-16

## Context

An orchestrator asks two different questions: "is this process broken, should I restart it?" and
"can this instance serve traffic right now?" A single `/health` endpoint conflates them.

## Decision

`GET /health` is **liveness** and deliberately does **not** touch the database. `GET /ready` is
**readiness** and does.

The failure this prevents is specific and nasty. If liveness probed the database, a brief database
blip would fail the liveness check on every instance simultaneously, and the orchestrator would
respond by killing every otherwise-healthy process — converting a recoverable dependency hiccup into
a full outage, with a cold-start stampede on the way back. Liveness must only answer for the process
itself.

Readiness *should* fail during that blip: those instances genuinely cannot serve, and removing them
from the load balancer while leaving them running is exactly right.

## Consequences

**Easier:** dependency outages degrade instead of cascading; instances rejoin automatically.

**Harder:** two endpoints to configure, and a deployment that wires the wrong one to the wrong probe
gets the worst of both. Documented in the README so the mapping is explicit.

## In one breath

*Liveness never touches the database, because a probe that does turns a five-second database blip
into every instance being killed at once — readiness is the one allowed to fail.*
