# ADR-0008 — Scan status is a discriminated union; `unknown` is not `clean`

**Status:** accepted · **Date:** 2026-09-16

## Context

A scan accumulates fields as it progresses: `startedAt` when work begins, then `completedAt`,
`threatScore` and `verdict` when it finishes. The obvious model is one flat type with those fields
optional.

## Decision

**Model status as a discriminated union.** The presence of `threatScore`, `verdict` and `completedAt`
*depends on* the value of `status` — that is a variant, not an optional.

The flat-optional version admits states that cannot exist: a `completed` scan with no score, a
`pending` scan with a `completedAt`. Worse, it forces every consumer to defensively re-check fields
even inside a branch where it already knows the status. With a union, one guard narrows and every
field access afterwards is direct — no optional chaining, no non-null assertions.

The database cannot express this, so `fromRows` is where the two worlds meet: it switches on status
and **throws loudly** if a row reached a status without the columns that status requires. A corrupt
row is a real fault and should fail visibly at the boundary, not propagate as a half-built model that
breaks somewhere unrelated.

**Separately: `Verdict.Unknown` is distinct from `Verdict.Clean`.** When every check errors, the scan
still *completes* — the pipeline worked — but it produced no signal. Reporting that as `clean` would
be the single most dangerous bug this service could ship: a security product telling a user a URL is
safe when what it means is that it could not tell. `unknown` says the true thing.

## Consequences

**Easier:** illegal states are unrepresentable; consumers narrow once; the compiler catches a missing
status branch when a new status is added.

**Harder:** the translator is more code than a field-by-field copy, and every new status means a new
variant plus its branch. That cost is the point — it is the compiler asking a question that would
otherwise have gone unasked.

## In one breath

*Fields that only exist in certain states are variants rather than optionals, so the model makes
illegal states unrepresentable — and `unknown` is deliberately not `clean`, because a scanner must
never say "safe" when it means "I could not tell".*
