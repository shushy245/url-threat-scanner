# ADR-0011 — The outbox drain holds row locks across the broker round-trip

**Status:** accepted · **Date:** 2026-09-16

## Context

The relay must select unpublished events, publish them, and mark them published. Where the
transaction boundary goes decides what can go wrong.

## Decision

**All three happen inside one transaction.** `SELECT ... FOR UPDATE SKIP LOCKED`, publish each event
on a confirm channel, `UPDATE ... SET published_at`, commit.

This is knowingly in tension with the house rule "never hold locks across business logic". The rule
is about holding locks across *business logic* — arbitrary work of unbounded duration. Here the
locked region contains exactly one bounded operation: a publish with an enforced timeout. The
alternative shapes are both worse:

- *Mark first, publish after.* A publish failure then loses the event permanently, with the row
  claiming it was delivered. This is the failure the outbox exists to prevent.
- *Claim, publish outside the transaction, mark after.* Shorter locks, but it needs a reaper for
  stale claims and can double-publish after a crash. Strictly more moving parts for a guarantee we
  already have.

The blast radius is small by construction: `SKIP LOCKED` means other relay instances skip these rows
rather than blocking on them, the batch is bounded, and the publish timeout bounds the hold.

## Consequences

**Easier:** a failed publish rolls back the mark automatically — no compensating logic, no reaper. No
event is ever published twice by concurrent relays.

**Harder:** an unresponsive broker holds a transaction open until the timeout fires. Mitigated by the
timeout being mandatory in `publishConfirmed`, not optional.

## In one breath

*Drain, publish and mark are one transaction, so a broker failure rolls back the mark instead of
losing the event — and the lock is safe to hold because the only thing inside it is a single publish
with an enforced timeout.*
