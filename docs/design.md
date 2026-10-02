# Weathervane design

This page is the contract. It says what Weathervane does, what it does not do, and which test or
measurement backs each claim. A change that alters behaviour described here updates this page in the same
pull request.

## What it is

A feature flag and remote config service. Engineers define flags per project, configure them per
environment (targeting rules, percentage rollouts, an on/off switch), and server-side applications read
them through a Node SDK that evaluates locally and receives changes over a server-sent event stream.

Three properties carry the design:

1. **A flag change reaches every connected SDK quickly, and the time is measured.** One write in Postgres
   becomes one notification per server instance, one serialised message per environment, and one socket
   write per connection.
2. **Rollouts are sticky.** A user's bucket depends only on the flag, its salt and the user's key, so
   raising a two-way rollout from 10% to 20% keeps the first 10% where they were.
3. **Evaluation happens in the SDK, without a network call.** The SDK holds the environment's ruleset in
   memory. A flag read is a function call.

## Packages

| Package               | Role                                                             | Depends on                |
| --------------------- | ---------------------------------------------------------------- | ------------------------- |
| `@weathervane/core`   | Flag types, rule evaluation, bucketing. No runtime dependencies. | nothing                   |
| `@weathervane/server` | Management API, SDK API, SSE fan-out, Postgres storage.          | core, Fastify, Kysely, pg |
| `@weathervane/node`   | Server-side Node SDK: ruleset cache, stream client, typed reads. | core                      |

The server and the SDK run the same evaluation code, so `POST /sdk/v1/evaluate` and an SDK read can never
disagree about the same ruleset and context.

## Model

- **Project**: a namespace for flags and keys, for example `checkout`.
- **Environment**: belongs to a project (`development`, `production`). Carries a monotonically increasing
  `version` that moves on every flag change in that environment.
- **Flag**: belongs to a project. Has a `key`, a `kind` (`boolean`, `string`, `number`, `json`), an
  ordered list of `variations` (the values it can serve) and a random `salt` set at creation.
- **Flag config**: one per flag per environment. Holds `enabled`, `offVariation`, an ordered list of
  `rules`, a `fallthrough`, its own `version` for optimistic concurrency, and `changedAt`, the environment
  version at which it last changed.
- **API key**: `root` (from configuration, manages projects and keys), `admin` (one project, manages flags
  and configs) or `sdk` (one environment, read only).
- **Audit entry**: who changed which flag config in which environment, with the before and after documents.

### Evaluation

Given a flag, its config for one environment, and a context (`{ key: string, ...attributes }`):

1. If `enabled` is false, serve `offVariation`. Reason `off`.
2. Otherwise walk `rules` in order. The first rule whose clauses all match serves its `serve`. Reason
   `rule` with the rule's `id`.
3. If no rule matches, serve `fallthrough`. Reason `fallthrough`.

A `serve` is either a fixed `{ variation: n }` or a `{ rollout: { weights, bucketBy } }`. Weights are
integers in hundred-thousandths, one per variation, summing to 100000. The bucket is
`murmur3_32(flagKey + "." + salt + "." + value) mod 100000`, where `value` is the context attribute named
by `bucketBy` (default `key`). The variation is the first whose cumulative weight exceeds the bucket.

A clause is `{ attribute, op, values, negate }`. It matches when the attribute's value matches any of
`values` under `op`. Operators: `in`, `startsWith`, `endsWith`, `contains`, `lt`, `lte`, `gt`, `gte`,
`semverEq`, `semverLt`, `semverGt`. A clause on an attribute the context does not carry never matches,
negated or not, so a missing attribute cannot opt someone into a rule written as "not in beta".
There is no regular expression operator: a pattern from a flag editor running against every evaluation is
a denial of service waiting for one careless edit.

Evaluation errors (a rollout on a context with no value for `bucketBy`, a variation index out of range)
return reason `error` with a stable `errorCode`, and the SDK serves the caller's fallback value.

## Propagation path

```
PUT config ──> Postgres transaction:
                 lock environment row, version = version + 1
                 update flag config (changedAt = new version)
                 insert audit entry
                 pg_notify('weathervane_changes', '<environmentId>:<version>')
               commit
                    │ (NOTIFY is delivered only after commit)
                    ▼
each server instance: one LISTEN connection
  ──> environment cache: load flag configs with changedAt > cached version
  ──> serialise one SSE event per environment
  ──> write the same string to every open stream for that environment
```

- Each instance keeps a materialised ruleset per environment that has at least one reader. Ruleset
  reads and new stream connections are served from that copy and do not touch Postgres.
- All updates to one environment's copy run through one promise chain, so a lazy first load and a
  notification that arrives during it cannot interleave.
- A new stream gets the full ruleset as its first event, synchronously from the cached copy, so no change
  can fall between the snapshot and the first delta.
- A reconnecting SDK sends `Last-Event-ID` (the environment version it holds). If it is behind, it gets
  only the flags whose `changedAt` is greater. If the ID is unknown or ahead, it gets the full ruleset.
- If the LISTEN connection drops, the instance reconnects and re-syncs every cached environment by
  querying `changedAt > cached version`, so a notification lost during the gap costs latency, not
  correctness.
- Streams receive a comment line every 25 seconds so idle proxies do not cut them.

## API

Wire format is JSON with camelCase field names. Timestamps are RFC 3339 in UTC. Every error uses one
envelope: `{ code, message, details?, traceId }`. Error codes are listed in `docs/errors.md`.

Management API, `Authorization: Bearer <root or admin key>`:

| Method and path                                                          | Purpose                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST /api/v1/projects`                                                  | Create a project with its environments (root)                                                     |
| `POST /api/v1/projects/{project}/keys`                                   | Create an admin or SDK key; the secret is returned once (root for admin keys, admin for SDK keys) |
| `DELETE /api/v1/projects/{project}/keys/{keyId}`                         | Revoke a key                                                                                      |
| `POST /api/v1/projects/{project}/flags`                                  | Create a flag                                                                                     |
| `GET /api/v1/projects/{project}/flags`                                   | List flags, keyset paginated                                                                      |
| `GET /api/v1/projects/{project}/flags/{flag}`                            | A flag with its config in every environment                                                       |
| `PUT /api/v1/projects/{project}/flags/{flag}/environments/{environment}` | Replace a flag config; `If-Match` with the config version is required                             |
| `GET /api/v1/projects/{project}/audit`                                   | Audit entries, newest first, keyset paginated                                                     |

SDK API, `Authorization: Bearer <sdk key>`. The environment comes from the key, never from the request:

| Method and path         | Purpose                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `GET /sdk/v1/ruleset`   | The environment's ruleset; `ETag` is the environment version, `If-None-Match` returns `304` |
| `GET /sdk/v1/stream`    | SSE stream: `ruleset` event first, then `flags` events with changed flags                   |
| `POST /sdk/v1/evaluate` | Every flag's value and reason for one context, for debugging and non-Node callers           |

## Security

- Keys are `wv_<kind>_<id>_<secret>`. Only `sha256(secret)` is stored. A lookup by id is followed by a
  constant-time comparison of the hashes.
- The root key comes from configuration and is compared the same way. It is never stored.
- The project and environment a request acts on come from the key. A path naming another project
  returns `404`, not `403`, so keys cannot probe for project names.
- Secrets never appear in logs: the `Authorization` header is redacted by the logger configuration.
- Request bodies are validated against JSON schemas before handlers run; unknown fields are rejected.

## Evidence

| Claim                                                     | Backed by                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| Rollouts are sticky when a two-way split grows            | `packages/core/src/bucket.test.ts`, property test                    |
| Rollout shares match their weights                        | `packages/core/src/bucket.test.ts`, distribution test over 100k keys |
| A missing attribute never matches, negated or not         | `packages/core/src/evaluate.test.ts`                                 |
| Stale `If-Match` is rejected with `412`                   | server integration tests                                             |
| An SDK key cannot read another environment                | server integration tests                                             |
| Reconnect with `Last-Event-ID` receives only missed flags | server integration tests                                             |
| Propagation latency                                       | `bench/propagation.ts`, results in `docs/benchmark-results/`         |

## Known limits

- Writes to one environment serialise on its row lock. That bounds write throughput per environment to
  what one Postgres row can take, which is far above how often people edit flags.
- Every instance caches every environment that has a reader. Memory grows with environments times flags.
- No user accounts. Admin access is by key. An identity provider in front of the management API is the
  intended next step, not part of this release.
- No segments, no scheduled changes, no experiments or analytics.
- The SDK is for Node on the server. A browser should call `POST /sdk/v1/evaluate` through its own
  backend, since SDK keys are secret.
