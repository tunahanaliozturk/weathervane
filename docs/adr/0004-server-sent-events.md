# 0004: Server-sent events for the change stream

Status: Accepted, 2026-10-02

## Context

Changes flow one way, from the server to SDKs. SDKs reconnect after deploys, network blips and proxy
timeouts, and must not miss a change when they do.

## Decision

The SDK stream is `GET /sdk/v1/stream` with `text/event-stream`. Each event's `id` is the environment
version. A reconnecting SDK sends `Last-Event-ID` and receives only the flags changed since then.

## Consequences

- Resume is part of the protocol (`id` and `Last-Event-ID`), so no custom handshake.
- It is plain HTTP: it passes through proxies and load balancers that already handle long responses, and
  it uses the same authentication header as every other SDK call.
- One message is serialised per environment per change and the same string is written to every socket.
- Each connection is a long-lived HTTP response, so idle timeouts on proxies must be longer than the
  25 second heartbeat.

## Alternatives

- **WebSocket.** Lost because the channel is one-way, and because resume and heartbeats would have to be
  built by hand. Would win if SDKs had to send data back, such as evaluation events for analytics.
- **Long polling `GET /sdk/v1/ruleset` with `If-None-Match`.** Simpler, and still supported for SDKs that
  cannot hold a stream, but every change costs one request per SDK and arrives up to one poll interval
  late.
