# ADR-0004 — SSRF guard and API-key auth ship; rate limiting deliberately deferred

**Status:** accepted · **Date:** 2026-09-16

## Context

This service fetches URLs chosen by whoever is being attacked — that is its entire job. A URL
scanner is, structurally, a server-side request forgery engine unless deliberately prevented from
being one.

## Decision

### Shipping: SSRF guard

Normalize and validate at the boundary:
- reject non-`http(s)` schemes (`file:`, `gopher:`, `javascript:`),
- reject credentials-in-URL,
- reject private, loopback, link-local and cloud-metadata targets (`169.254.169.254` above all),
- reject obfuscated encodings of the above (`2130706433`, `0x7f.0.0.1`, `017700000001`),
- **re-check after DNS resolution and on every redirect hop.**

That last clause is the one that matters. A guard that only inspects the literal string is defeated
by a public hostname whose A record points at `127.0.0.1` — DNS rebinding. Validating the string and
then handing the *hostname* to the fetch layer re-opens exactly the hole the guard was written to
close; the resolved address is what must be checked, and checked again after every redirect.

### Shipping: API-key auth

One key per sensor client, **hashed at rest**, client id attached to every log line and every scan
row. This gives attribution, and it is the precondition for per-client quotas later.

### Deliberately NOT shipping: rate limiting

Correct distributed rate limiting requires shared state. An in-process limiter behind a load
balancer does not limit anything — with N instances the real ceiling is N × the configured limit,
and it varies with autoscaling. It produces a dashboard that says "protected" and an attacker who
isn't.

Shipping nothing plus a stated reason is the more honest engineering position than shipping a
limiter that doesn't limit. The real implementation is a shared token bucket (Redis) at the edge,
keyed by client id — which the auth layer already provides.

## Consequences

**Easier:** the service cannot be turned into an internal-network probe; every scan is attributable
to a client; adding quotas later needs no new identity plumbing.

**Harder:** an unbounded client can still exhaust the worker pool. Mitigated operationally (broker
prefetch bounds concurrency, the DLQ bounds retry storms), not architecturally. This is the first
gap I would close with more time.

## In one breath

*A URL scanner is an SSRF engine by construction, so the guard re-validates after DNS resolution and
on every redirect rather than trusting the string — and we shipped no rate limiter at all, because
an in-process one behind a load balancer is a dashboard that lies.*
