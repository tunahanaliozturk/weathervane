# Contributing to Weathervane

## Build and test

You need Node 24 or later. The server's integration tests start Postgres with Testcontainers, so they
also need Docker.

```bash
npm ci
npm run build
npm test
```

These gates must pass before every commit, and CI runs all of them:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run licenses
```

`npm run lint` fails on any warning. `npm run licenses` checks the licence of every installed package,
at every depth, against an allow list of permissive licences; an exception needs a written reason in
`scripts/license-audit.mjs`.

A few rules the code follows:

- Every promise is awaited or explicitly handed off; type-aware lint enforces it.
- No `any`, no non-null assertions, no enums (`erasableSyntaxOnly` is on).
- Errors that reach a client use the envelope and codes in `docs/errors.md`.
- A change to behaviour comes with a test that fails without it.
- Text files use LF line endings.

## Plans and decisions

[docs/design.md](docs/design.md) is the contract. A pull request that changes what it describes updates
it too. A decision someone could reasonably make differently gets an ADR in [docs/adr](docs/adr),
numbered after the last one, with the alternatives it beat. Merged ADRs are not edited; a new one
supersedes them.

Documentation is plain English. Every claim in the README is backed by a test or a measurement, and
names it.
