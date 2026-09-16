# ADR-0009 — Digest-keyed auth lookup; cross-client reads return 404

**Status:** accepted · **Date:** 2026-09-16

## Context

Two small security decisions in the API layer that look arbitrary without their reasoning.

## Decision

**API keys are looked up by digest with a plain map get, not a constant-time comparison loop.**

Timing-safe comparison matters when comparing a secret against a secret. Here the presented key is
hashed first and the *digest* is used as a map key. An attacker cannot steer a SHA-256 digest toward
a stored value without already possessing the preimage — which is the key itself. So the map get
leaks nothing usable, is O(1) rather than O(keys), and is less code. Keys are stored hashed, so
neither the config file nor a leaked log ever yields a usable credential.

**Requesting another client's scan returns `404`, not `403`.**

`403` confirms the id exists. That turns the endpoint into an oracle: an attacker enumerating ids
learns which ones are real and how many scans a competitor is running. `404` is indistinguishable
from a genuinely absent id. The attempt is logged at `warn` with both client ids, so the behaviour is
visible to us while telling the caller nothing.

## Consequences

**Easier:** no per-request iteration over the key set; no enumeration oracle.

**Harder:** a legitimate client that mistypes an id gets the same response as one probing another
tenant, so diagnosing "why can't I see my scan" relies on the logs rather than the status code. That
is the right trade for a multi-tenant security product.

## In one breath

*We hash the key and look the digest up in a map — constant-time comparison protects secrets, not
digests an attacker cannot steer — and another client's scan is a 404 rather than a 403, because 403
confirms the id exists and turns the endpoint into an enumeration oracle.*
