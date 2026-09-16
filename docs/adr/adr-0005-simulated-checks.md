# ADR-0005 — Simulated checks behind the real checks' port

**Status:** accepted · **Date:** 2026-09-16

## Context

The brief permits either real security checks (RDAP, TLS) or simulated ones with random delays and
results. The architecture — queue, outbox, idempotency, scoring, error semantics — is what is
actually being evaluated, and it is identical either way. Time is the binding constraint.

## Decision

**Ship simulated checks first, behind the exact interface the real ones implement.** Real RDAP and
TLS adapters are the final phase, added only if time remains.

Every check satisfies one `CheckRunner` port and is registered in a `Record<CheckId, CheckRunner>`
lookup table — a new check is a new table entry, never an edit to a branch chain (Open/Closed).
Simulated and real adapters are selected **at the composition root by config** (`CHECK_MODE`), so
promoting to real checks is a config flag plus one new file. Nothing downstream — scoring, status,
persistence, error handling — knows or cares which is in use.

**The non-obvious part: the nondeterminism must be injected.** The brief asks for randomized results
*and* for tests of the scanning pipeline, and those two requirements are in direct conflict unless
the randomness is a dependency. Simulated checks therefore take `Clock` and `Random` ports. In
production they get the real ones; in tests they get a fixed clock and a seeded generator, and every
pipeline test is deterministic. Unseeded `Math.random()` would have produced a test suite that fails
one run in twenty for reasons no one can reproduce — the worst possible outcome for a suite whose
purpose is to prove the pipeline correct.

## Consequences

**Easier:** the pipeline is exercised end-to-end from day one without depending on third-party
availability; tests are fast and deterministic; real checks land without touching the pipeline.

**Harder:** the real adapters carry risks the simulations do not — WHOIS rate limits and wildly
inconsistent response formats, TLS handshake edge cases, and SSRF exposure on the redirect chain.
The simulated versions prove the plumbing, not the parsing. That distinction is stated plainly rather
than glossed: a green pipeline here does **not** mean the real checks work.

## In one breath

*Checks sit behind a port with the simulated and real implementations chosen by config, and the
simulation's randomness is injected rather than ambient — otherwise the same requirement that asked
for random results would have made the pipeline tests flaky.*
