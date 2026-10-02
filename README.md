# Weathervane

[![ci](https://github.com/tunahanaliozturk/weathervane/actions/workflows/ci.yml/badge.svg)](https://github.com/tunahanaliozturk/weathervane/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

A feature flag service in TypeScript: change a flag once, and every connected Node service sees the new
value within milliseconds, without a network call on the read path.

> Status: under construction. The evaluation core is done and tested; the server and SDK are in
> progress. This README states only what the code already backs.

## How it works

Flags are defined per project and configured per environment: an on/off switch, targeting rules, and
percentage rollouts. The Node SDK downloads an environment's ruleset once, evaluates flags locally, and
keeps the ruleset current over a server-sent event stream.

A flag change is one Postgres transaction that bumps the environment's version and calls `pg_notify`.
Each server instance listens, loads only what changed, serialises one event, and writes the same bytes
to every open stream for that environment. There is no Redis and no broker: the notification is sent
only if the transaction commits ([ADR 0002](docs/adr/0002-postgres-notify-for-fan-out.md)).

Rollouts are sticky. A user's bucket is `murmur3(flagKey.salt.userKey) mod 100000`, so raising a rollout
from 10% to 20% keeps the first 10% where they were. A property test in
[`bucket.test.ts`](packages/core/src/bucket.test.ts) checks it, and a 100k-key test checks that a
10/30/60 split lands within half a percentage point of each weight.

## Repository

| Path                                 | What                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| [`packages/core`](packages/core)     | Types, rule evaluation, bucketing, validation. No runtime dependencies. |
| [`packages/server`](packages/server) | Fastify server: management API, SDK API, change stream, Postgres.       |
| [`packages/sdk`](packages/sdk)       | Server-side Node SDK.                                                   |
| [`docs/design.md`](docs/design.md)   | The contract: model, evaluation rules, propagation path, API, limits.   |
| [`docs/adr`](docs/adr)               | Decisions and the alternatives they beat.                               |

## Build and test

Node 24 or later, and Docker for the server's integration tests.

```bash
npm ci
npm run build
npm test
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
