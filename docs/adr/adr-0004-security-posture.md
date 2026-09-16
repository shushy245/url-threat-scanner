# ADR-0004 — SSRF guard and API-key auth ship; rate limiting deferred

**Status:** accepted · **Date:** 2026-09-16

**Issue.** This service fetches URLs chosen by whoever is being attacked. That makes it, structurally,
an SSRF engine unless deliberately prevented from being one.

**Decision.** Ship two things, skip one on purpose.

- **SSRF guard:** reject non-`http(s)` schemes, credentials in the URL, and private, loopback,
  link-local and cloud-metadata targets including obfuscated encodings (`2130706433`, `0x7f.0.0.1`) —
  then **re-check after DNS resolution and on every redirect hop.** A guard that only reads the string
  is defeated by a public hostname whose A record points at `127.0.0.1`.
- **API-key auth:** one key per client, hashed at rest, client id on every log line and scan row.
- **No rate limiter.** Correct limiting needs shared state; in-process behind a load balancer means N
  instances × the limit. That's a dashboard saying "protected" and an attacker who isn't.

**Trade-offs.** The service can't be turned into an internal-network probe and every scan is
attributable. The cost: an unbounded client can still exhaust the worker pool — bounded by prefetch
and the DLQ operationally, not architecturally. The real fix is a Redis token bucket at the edge,
keyed by the client id auth already provides. First gap I'd close.

**In one breath.** *A URL scanner is an SSRF engine by construction, so the guard re-validates after
DNS and on every redirect instead of trusting the string — and we shipped no rate limiter at all,
because an in-process one behind a load balancer is a dashboard that lies.*
