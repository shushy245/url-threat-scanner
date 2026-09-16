# ADR-0002 — One message per scan; checks run concurrently inside it

**Status:** accepted · **Date:** 2026-09-16

**Issue.** A scan runs several independent checks. That's either one unit of work or many.

**Decision.** One `ScanRequested` message per scan. The worker claims it, runs all checks with
`Promise.allSettled` and a per-check timeout, and writes every check row, the score and the terminal
status in a single transaction. Rejected: one message per `(scan, check)`. Per-check retry and
isolation are real benefits, but they require something to decide "all checks are done now", and
that decision races under concurrent workers — producing scans stuck in `in_progress` forever, the
worst failure mode here and the hardest to reproduce.

**Trade-offs.** Gained: no fan-in race, one write per entity per flow, a scan is atomically complete
or not. Cost: one slow check delays the whole scan (bounded by the timeout), and a redelivery re-runs
checks that already passed — wasted work, not wrong results. Escape hatch if per-check cost
diverges: message per check plus a completion counter on the scan row, last writer transitions it.

**In one breath.** *One message per scan with the checks concurrent inside it, because the
alternative's per-check retry isn't worth a fan-in race that strands scans in `in_progress`.*
