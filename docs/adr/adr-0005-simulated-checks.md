# ADR-0005 — Simulated checks behind the real checks' port

**Status:** accepted · **Date:** 2026-09-16

**Issue.** The brief allows real checks (RDAP, TLS) or simulated ones. Everything being evaluated —
queue, outbox, idempotency, scoring, error semantics — is identical either way, and time is short.

**Decision.** Ship simulated checks behind the exact `CheckRunner` port the real ones implement,
registered in a `Record<CheckId, CheckRunner>` so a new check is a table entry, not a new branch. The
implementation is picked at the composition root by `CHECK_MODE`; nothing downstream knows which is
in use. The non-obvious part: **the randomness is injected.** Checks take `Clock` and `Random` ports,
because the brief asks for random results *and* pipeline tests — which conflict unless randomness is
a dependency. Ambient `Math.random()` would fail one run in twenty for reasons no one can reproduce.

**Trade-offs.** The pipeline runs end-to-end from day one with fast, deterministic tests, and real
checks land without touching it. The cost: simulations prove the plumbing, not the parsing — real
adapters carry WHOIS rate limits, inconsistent formats, TLS edge cases. A green pipeline here does
**not** mean the real checks work.

**In one breath.** *Checks sit behind a port with simulated and real chosen by config, and the
simulation's randomness is injected rather than ambient — otherwise the same requirement that asked
for random results would have made the pipeline tests flaky.*
