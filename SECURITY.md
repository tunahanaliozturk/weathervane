# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Report it privately through GitHub:
[open a private vulnerability report](https://github.com/tunahanaliozturk/weathervane/security/advisories/new).
Please do not open a public issue for it.

Say what you found, how to reproduce it, which version you used, and what an attacker gains.

You can expect an acknowledgement within 7 days, and a fix or a decision within 30 days of a confirmed
report.

## Scope

In scope:

- A key reading or changing anything outside its project or environment.
- A revoked key that still works.
- A key secret, or the root key, reaching a log, a response or the database in plain form.
- A flag change that reaches SDKs although its transaction rolled back, or a committed change that never
  reaches a connected SDK.
- Input that makes the server crash, hang or use unbounded memory.

Out of scope:

- Anyone holding a valid SDK key reading that environment's full ruleset. That is by design
  ([ADR 0003](docs/adr/0003-evaluate-in-the-sdk.md)): SDK keys are secrets for server-side use.
- Vulnerabilities in Node, Postgres or a dependency, unless Weathervane's use of it creates the problem.
