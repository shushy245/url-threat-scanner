# ADR-0008 — Scan status is a discriminated union; `unknown` is not `clean`

**Status:** accepted · **Date:** 2026-09-16

**Issue.** A scan gains fields as it progresses — `startedAt`, then `completedAt`, `threatScore`,
`verdict`. The obvious model is one flat type with those fields optional.

**Decision.** A discriminated union: their presence *depends on* status, which makes them variants,
not optionals. Flat optionals admit states that can't exist (a `completed` scan with no score) and
force consumers to re-check fields inside a branch that already knows the status. With a union, one
guard narrows and every access after it is direct. The database can't express this, so the translator
switches on status and **throws loudly** if a row lacks the columns its status requires. Separately:
`unknown` ≠ `clean`. When every check errors the scan completes but produced no signal — calling that
`clean` would be the most dangerous bug this service could ship.

**Trade-offs.** Illegal states are unrepresentable and the compiler catches a missing branch when a
status is added. The cost: the translator is more code than a field copy, and each new status needs a
variant plus its branch — the compiler asking a question that would otherwise go unasked.

**In one breath.** *Fields that only exist in certain states are variants, not optionals, so illegal
states are unrepresentable — and `unknown` is deliberately not `clean`, because a scanner must never
say "safe" when it means "I couldn't tell".*
