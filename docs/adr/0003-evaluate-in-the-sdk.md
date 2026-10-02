# 0003: Flags are evaluated in the SDK, with MurmurHash3 buckets

Status: Accepted, 2026-10-02

## Context

An application reads flags in its hot path, often several per request. A network call per read adds
latency, and turns a Weathervane outage into an outage of every application that reads a flag.

Percentage rollouts need to put the same user in the same variation on every instance and every SDK,
without coordination.

## Decision

The SDK downloads the environment's whole ruleset and evaluates locally, using the same
`@weathervane/core` code the server runs. A user's bucket is `murmur3_32(flagKey + "." + salt + "." +
value) mod 100000`.

## Consequences

- A flag read is a function call, with no I/O.
- If the server goes away, the SDK keeps serving the last ruleset it received.
- The whole ruleset, rules and target values included, is visible to the SDK key holder. That is why SDK
  keys are secret and the SDK is for servers. A browser goes through `POST /sdk/v1/evaluate` on its own
  backend.
- MurmurHash3 is specified well enough that an SDK in another language reproduces it from the
  reference, and the test vectors in `murmur3.test.ts` pin it.
- The per-flag salt decorrelates flags: two 50% rollouts overlap on about a quarter of users, asserted in
  `bucket.test.ts`.

## Alternatives

- **Evaluate on the server for every read.** Lost on latency and on the outage coupling. Would win if
  rules had to stay secret from the application, for example targeting lists that are personal data.
- **SHA-256 for buckets.** Equally stable, but needs `crypto.subtle`, which is asynchronous in browsers,
  and is slower for no benefit, since bucketing needs uniformity rather than secrecy.
