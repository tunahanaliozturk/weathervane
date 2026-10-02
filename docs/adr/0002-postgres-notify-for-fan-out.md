# 0002: Postgres LISTEN/NOTIFY carries changes between instances

Status: Accepted, 2026-10-02

## Context

Several server instances each hold open SSE streams. A flag change written through one instance must
reach the streams on all of them. Postgres is already required for storage.

Flag changes are rare compared to reads: people edit flags a few times an hour, while thousands of SDK
connections stay open.

## Decision

The transaction that changes a flag config also calls `pg_notify('weathervane_changes',
'<environmentId>:<version>')`. Every instance holds one connection that runs `LISTEN` on that channel. On a
notification it loads the flag configs whose `changedAt` is above the version it has cached, and
broadcasts them.

## Consequences

- No second piece of infrastructure to run, secure and monitor.
- A notification is sent only when the transaction commits, so an instance can never broadcast a change
  that was rolled back. A message broker fed from application code after the commit would need an outbox
  to promise the same.
- The payload is an id and a version, not the change, so the 8000 byte NOTIFY payload limit never
  applies, and a lost notification is recovered by the next query against `changedAt`.
- NOTIFY is not delivered to a listener that is disconnected. The instance re-syncs every cached
  environment when its LISTEN connection comes back, so a gap costs latency, not correctness.
- Postgres serialises NOTIFY across the whole database at commit time. At flag-edit rates this is
  invisible. It would matter at thousands of changes per second, which is not this workload.
- Each instance holds one extra Postgres connection.

## Alternatives

- **Redis pub/sub.** Lost because it adds a service and, being fire-and-forget outside the transaction,
  needs an outbox to avoid announcing changes that never committed. Would win if changes ran at thousands
  per second.
- **Each instance polls `environments.version` every second.** Simple and correct, but puts a floor of
  up to one second on propagation and a constant query load on the database. Would win where the
  database sits behind a pooler in transaction mode, such as PgBouncer, where LISTEN does not work.
