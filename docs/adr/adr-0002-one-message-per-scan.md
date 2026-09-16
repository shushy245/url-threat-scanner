# ADR-0002 — One message per scan; checks run concurrently inside it

**Status:** accepted · **Date:** 2026-09-16

**Issue.** A scan runs several independent checks. That's either one unit of work or many.

**Decision.** One message per scan. The worker claims it, runs all checks with `Promise.allSettled`
and a per-check timeout, and writes every check row, the score and the terminal status in one
transaction. Rejected one message per `(scan, check)`: per-check retry is real, but it needs
something to decide "all checks are done now", and that decision races under concurrent workers —
stranding scans in `in_progress` forever, the worst failure here and the hardest to reproduce.

**Trade-offs.** No fan-in race, one write per entity per flow, a scan is atomically complete or not.
The cost: one slow check delays the whole scan (bounded by the timeout), and a redelivery re-runs
checks that already passed — wasted work, not wrong results. If per-check cost ever diverges, the
escape hatch is a completion counter on the scan row with the last writer transitioning it.

**In one breath.** *One message per scan with the checks concurrent inside it, because the
alternative's per-check retry isn't worth a fan-in race that strands scans in `in_progress`.*
