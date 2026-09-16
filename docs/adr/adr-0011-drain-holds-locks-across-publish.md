# ADR-0011 — The outbox drain holds row locks across the broker round-trip

**Status:** accepted · **Date:** 2026-09-16

**Issue.** The relay selects unpublished events, publishes them, and marks them published. Where the
transaction boundary goes decides what can go wrong.

**Decision.** All three in one transaction: `SELECT ... FOR UPDATE SKIP LOCKED`, publish on a confirm
channel, `UPDATE ... SET published_at`, commit. This is knowingly in tension with "never hold locks
across business logic" — but that rule is about work of unbounded duration, and the locked region
holds exactly one bounded operation with a mandatory timeout. Both alternatives are worse.
*Mark-then-publish* loses the event on a publish failure with the row claiming delivery — the exact
failure the outbox exists to prevent. *Claim, publish outside, mark after* shortens the lock but needs
a reaper for stale claims and can double-publish after a crash.

**Trade-offs.** A failed publish rolls back the mark automatically — no compensating logic, no reaper
— and `SKIP LOCKED` means concurrent relays skip these rows rather than block. The cost: an
unresponsive broker holds a transaction open until the timeout fires, which is why the timeout is
mandatory in `publishConfirmed` rather than optional.

**In one breath.** *Drain, publish and mark are one transaction, so a broker failure rolls back the
mark instead of losing the event — and the lock is safe to hold because the only thing inside it is
one publish with an enforced timeout.*
