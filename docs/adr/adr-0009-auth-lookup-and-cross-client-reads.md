# ADR-0009 — Digest-keyed auth lookup; cross-client reads return 404

**Status:** accepted · **Date:** 2026-09-16

**Issue.** Two small API-layer security choices that look arbitrary without their reasoning.

**Decision.**

- **Keys are looked up by digest with a plain map get, not a constant-time comparison loop.**
  Timing-safe comparison protects a secret compared against a secret. Here the presented key is
  hashed and the *digest* is the map key — an attacker can't steer a SHA-256 digest toward a stored
  value without already holding the preimage, which is the key itself. So the get leaks nothing
  usable, and it's O(1) instead of O(keys).
- **Another client's scan returns `404`, not `403`.** `403` confirms the id exists, turning the
  endpoint into an enumeration oracle. The attempt is logged at `warn` with both client ids — visible
  to us, silent to the caller.

**Trade-offs.** No per-request iteration over the key set, no enumeration oracle, and no usable
credential in config or logs. The cost: a client that mistypes its own id gets the same response as
one probing another tenant, so diagnosis relies on logs rather than the status code.

**In one breath.** *We hash the key and look the digest up in a map — constant-time comparison
protects secrets, not digests an attacker can't steer — and another client's scan is a 404 rather
than a 403, because 403 confirms the id exists and turns the endpoint into an enumeration oracle.*
