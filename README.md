# Weathervane

[![ci](https://github.com/tunahanaliozturk/weathervane/actions/workflows/ci.yml/badge.svg)](https://github.com/tunahanaliozturk/weathervane/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

A feature flag service in TypeScript. Change a flag once and every connected Node service has the new
value a fraction of a second later, with no network call on the read path.

With 1,000 SDK streams open, a flag change reached the median stream 29.5 ms after the write was sent
and every stream within 49 ms. With 10,000, the server wrote the change to all of them in 16 ms
(median of 10 changes), and the median stream had it after 150 ms. That was on one Intel Core Ultra 7
255H laptop running the server, Postgres and the load generator together, so most of the 10,000-stream
figure is spent outside the server's write loop. Method, raw numbers and caveats are in
[docs/benchmark-results/propagation.md](docs/benchmark-results/propagation.md).

## Quick start

Needs Docker, curl and jq.

```bash
docker compose up -d --build --wait
./scripts/quickstart.sh
```

The script creates a project, an admin key and an SDK key, a flag that starts off, asks what user
`alice` gets (`false`, reason `off`), turns the flag on for pro users and 25% of everyone else, and asks
again (`true`, by rule `pro`). Read it: it is ten commands, and CI runs it on every push. `docker compose
down -v` resets the stack.

Then, in a Node service:

```ts
import { WeathervaneClient } from "@weathervane/node";

const flags = new WeathervaneClient({
  sdkKey: process.env.WEATHERVANE_SDK_KEY!,
  baseUrl: "http://localhost:8080",
});
await flags.ready();

if (flags.variation("new-checkout", { key: user.id, plan: user.plan }, false)) {
  // the new checkout
}
```

`variation` never throws and never waits: it evaluates against the ruleset in memory, and returns the
fallback when the flag is missing, the client has no ruleset yet, or the value has the wrong type.

## How it works

Flags are defined per project and configured per environment: an on/off switch, targeting rules, and
percentage rollouts. The SDK downloads its environment's ruleset once and evaluates locally with the same
`@weathervane/core` code the server uses ([ADR 0003](docs/adr/0003-evaluate-in-the-sdk.md)).

A change is one Postgres transaction. It bumps the environment's version under a row lock, writes the
config and an audit entry, and calls `pg_notify`. Every server instance listens, loads only the flags
whose version is newer than its cached copy, serialises one server-sent event, and writes those same
bytes to every open stream for that environment. There is no Redis and no broker, and a notification
only goes out if the transaction commits ([ADR 0002](docs/adr/0002-postgres-notify-for-fan-out.md)).

The parts that took the most care:

- **No gap between snapshot and updates.** A new stream gets its snapshot from the cached copy and joins
  the broadcast list in the same turn of the event loop, so a concurrent update lands in one or the
  other. Updates to one environment run through a single promise chain, so a lazy load and a
  notification cannot interleave.
- **Resume, not replay.** Event ids are environment versions. A reconnecting SDK sends `Last-Event-ID`
  and receives only the flags changed since, which the server finds by `changedAt > version` on an index
  instead of keeping a log.
- **Lost notifications cost latency, not correctness.** When an instance's `LISTEN` connection drops,
  it reconnects and asks Postgres what changed. A test kills that connection mid-run and checks the
  change still arrives.
- **Sticky rollouts.** A user's bucket is `murmur3(flagKey.salt.userKey) mod 100000`, so raising a
  rollout from 10% to 20% keeps the first 10% where they were. A property test checks it, and a
  100k-key test checks that a 10/30/60 split lands within half a point of each weight.
- **Slow readers do not grow memory.** A stream with more than 4 MiB unflushed is closed; its SDK
  reconnects and catches up.

The full contract, with the test behind each claim, is [docs/design.md](docs/design.md).

## Repository

| Path                                       | What                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| [`packages/core`](packages/core)           | Types, rule evaluation, bucketing, validation. No runtime dependencies. |
| [`packages/server`](packages/server)       | Fastify server: management API, SDK API, change stream, Postgres.       |
| [`packages/sdk`](packages/sdk)             | Node SDK and `weathervane-typegen`.                                     |
| [`bench`](bench)                           | The propagation benchmark.                                              |
| [`docs/design.md`](docs/design.md)         | Model, evaluation rules, propagation path, API, limits.                 |
| [`docs/errors.md`](docs/errors.md)         | Every error code, what to do about it, and the request limits.          |
| [`docs/operations.md`](docs/operations.md) | Configuration, health, runbook.                                         |
| [`docs/adr`](docs/adr)                     | Decisions and the alternatives they beat.                               |

## Typed flags

`weathervane-typegen` reads an environment's ruleset and writes a declaration file, after which an
unknown flag key or a fallback of the wrong type is a compile error:

```bash
WEATHERVANE_SDK_KEY=wv_sdk_... npx weathervane-typegen --base-url http://localhost:8080 --out src/flags.d.ts
```

Generated types use the flag's kind (`boolean`, `string`, `number`, JSON), not a union of today's
variations, so adding a variation later does not break code generated before it. The SDK still checks
the type at runtime and serves the fallback if a value does not match.

## Build and test

Node 24 or later, and Docker for the server's integration tests, which run against a real Postgres
through Testcontainers.

```bash
npm ci
npm run build
npm test
```

## Limits

- Writes to one environment serialise on its row lock. That suits people editing flags, not automated
  writes at hundreds per second.
- Every instance caches every environment that has had a reader, with no eviction.
- No user accounts: access is by key. The SDK is for servers, since an SDK key can read its
  environment's whole ruleset.
- No segments, scheduled changes or experiment analytics.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
