# ADR-0002 — One message per scan; checks run concurrently inside it

**Status:** accepted · **Date:** 2026-09-16

## Context

A scan runs several independent checks. They could be one unit of work or many.

## Decision

**One `ScanRequested` message per scan.** The worker claims the scan, runs every check via
`Promise.allSettled` with a per-check timeout, and writes all `scan_check` rows, the threat score,
and the terminal status **in a single transaction**.

Rejected: one message per `(scan, check)` with a fan-in aggregation step. That buys per-check retry,
isolation, and independent scaling per check type — real benefits. It costs a completion-detection
step: something must decide "all checks are done now," and under concurrent workers that decision
races. Getting it wrong produces scans stuck in `in_progress` forever, which is both the worst
failure mode here and the hardest to reproduce.

One message also means **one status transition and one write per entity per flow**, which is the
property that makes the whole pipeline easy to reason about.

## Consequences

**Easier:** no aggregation race; a scan is atomically complete or not; the pipeline is a pure
function of its checks and trivially testable.

**Harder:** one slow check delays the whole scan (bounded by the per-check timeout), and a
redelivery re-runs checks that already succeeded — wasted work, not incorrect work, since the
transaction is all-or-nothing.

**Migration path, if per-check cost diverges:** message per check + a completion counter on the scan
row, incremented in the same transaction as each check's result, with the last writer transitioning
the scan. Documented now so the escape hatch is a known shape rather than a redesign.

## In one breath

*One message per scan with the checks running concurrently inside it, because the alternative's
per-check retry isn't worth introducing a fan-in race that strands scans in `in_progress`.*
