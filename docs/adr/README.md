# Architecture Decision Records

One file per crossroads, each a 20-second read: **issue** (what forced the decision), **decision**
(what was chosen, and what was rejected), **trade-offs** (what got easier, what it costs), and a
single **in one breath** sentence.

If a decision can't compress to that sentence, it isn't understood well enough to defend.

| ADR | Decision |
|---|---|
| [0001](adr-0001-rabbitmq-transactional-outbox.md) | RabbitMQ with a transactional outbox (reversed from a Postgres queue) |
| [0002](adr-0002-one-message-per-scan.md) | One message per scan; checks run concurrently inside it |
| [0003](adr-0003-idempotency-key.md) | `Idempotency-Key` header, not URL-keyed result reuse |
| [0004](adr-0004-security-posture.md) | SSRF guard + API-key auth ship; rate limiting deliberately deferred |
| [0005](adr-0005-simulated-checks.md) | Simulated checks behind the real checks' port |
| [0006](adr-0006-three-deployables.md) | Three deployables; versioned event schemas |
| [0007](adr-0007-runtime-stack.md) | Express 5, node-postgres, CommonJS |
| [0008](adr-0008-scan-status-union.md) | Scan status as a discriminated union; `unknown` ≠ `clean` |
| [0009](adr-0009-auth-lookup-and-cross-client-reads.md) | Digest-keyed auth lookup; cross-client reads return 404 |
| [0010](adr-0010-liveness-and-readiness.md) | Liveness and readiness are separate endpoints |
| [0011](adr-0011-drain-holds-locks-across-publish.md) | The outbox drain holds row locks across the broker round-trip |
| [0012](adr-0012-crash-only-restart.md) | Connection loss exits; the supervisor restarts |
| [0013](adr-0013-test-strategy.md) | Real Postgres, faked broker, outside-in |
