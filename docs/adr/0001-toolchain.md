# 0001: Node 24, TypeScript 6.0 and npm workspaces

Status: Accepted, 2026-10-02

## Context

The repository holds three packages (core, server, SDK) that build together. On the day this was written
the newest TypeScript was 7.0.2, the Go-native compiler, and the newest typescript-eslint (8.71.0)
declared `typescript >=4.8.4 <6.1.0` as its peer range. TypeScript 7 does not ship the JavaScript compiler
API that type-aware lint rules run on.

The rules that matter most in a Node server are type-aware: `no-floating-promises` and
`no-misused-promises` catch the unawaited write and the async callback handed to an API that ignores
its promise. Both bugs lose data quietly.

Node 24 is the active LTS line. Node 26 becomes LTS at the end of October 2026.

## Decision

We build with TypeScript 6.0.3 and lint with typescript-eslint's `strictTypeChecked` preset. We target
Node 24 as the minimum and test on 24 and 26 in CI. We use npm workspaces.

## Consequences

- Type-aware lint runs on every file, and CI fails on any warning.
- The compiler is the slower JavaScript one. On this repository a full `tsc -b` takes a few seconds, so
  the cost is small today.
- Moving to TypeScript 7 is one version bump once typescript-eslint supports it. The source avoids
  anything 7.0 removed (`erasableSyntaxOnly` is on, so no enums or parameter properties).
- npm ships with Node, so a fresh clone needs no extra tool.

## Alternatives

- **TypeScript 7 with lint rules that do not need types.** Lost because it gives up the two rules above.
  Would win if typescript-eslint supported 7.0, or if build time became the bottleneck.
- **TypeScript 7 for builds and 6.0 for lint.** Lost on two compilers that can disagree about the same
  file. Would win on a codebase large enough that the build is measured in minutes.
- **pnpm.** Stricter about undeclared dependencies, but needs a separate install, since Corepack no longer
  ships with Node 25 and later. Would win with many more packages where its disk savings show.
