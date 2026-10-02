# Operating Weathervane

## Configuration

All configuration comes from environment variables. The server refuses to start, naming every problem,
if one is missing or malformed.

| Variable               | Default   | Meaning                                                                   |
| ---------------------- | --------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`         | required  | Postgres connection string. The server runs its migrations at start.      |
| `WEATHERVANE_ROOT_KEY` | required  | At least 32 characters. Creates projects and admin keys. Never stored.    |
| `PORT`                 | `8080`    | HTTP port.                                                                |
| `HOST`                 | `0.0.0.0` | Interface to listen on.                                                   |
| `LOG_LEVEL`            | `info`    | pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |

Each instance holds up to 10 pooled Postgres connections plus one for `LISTEN`. The `LISTEN` connection
must reach Postgres directly: a pooler in transaction mode, such as PgBouncer, does not deliver
notifications ([ADR 0002](adr/0002-postgres-notify-for-fan-out.md)).

## Health

`GET /health` runs `SELECT 1` and returns `{ "status": "ok", "streams": <open streams> }`. It returns
500 when Postgres is unreachable. The Docker image's `HEALTHCHECK` calls it with Node, since the image
has no curl.

## Bootstrapping

1. Start the server with a root key.
2. `POST /api/v1/projects` with the root key creates a project and its environments.
3. `POST /api/v1/projects/{project}/keys` with `{"kind":"admin"}` and the root key creates the admin key
   people or tools use from then on. The token in the response is the only copy.
4. With the admin key, create SDK keys per environment and hand them to services.

`scripts/quickstart.sh` does exactly this against the compose stack.

## Runbook

### SDKs stopped receiving changes, but the API accepts writes

Confirm: a write returns 200, `GET /sdk/v1/ruleset` on the instance that took the write shows it, the
same call on another instance does not.

Cause: that instance's `LISTEN` connection is down and not yet back. It logs `change listener connection
failed` and retries with backoff up to 10 seconds, and re-syncs every cached environment when it
reconnects. Look for `change listener reconnected` in its log.

Act: if it does not reconnect, check that the instance can reach Postgres directly rather than through a
transaction-mode pooler. Restarting the instance is safe: SDKs reconnect to another instance and resume
with `Last-Event-ID`.

### A write returns 412 `version_mismatch` repeatedly

Someone else, or a script, is writing the same flag config. Read the config, reapply the change and send
the new version in `If-Match`. Do not script a retry that skips the read: it would overwrite the other
writer's change, which is what the version exists to prevent.

### SDKs reconnect in a loop

Confirm: the SDK reports `Stream refused with 401` or `403`. A 401 means the SDK key was revoked or is
wrong; issue a new one. If the SDK reports no error but reconnects about once a minute, something on the
path cuts idle connections in under 25 seconds or buffers the response. Raise the idle timeout above 30
seconds and turn off response buffering for `/sdk/v1/stream` (the server sends `X-Accel-Buffering: no`
for nginx).

### Memory grows on one instance

Each instance caches every environment that has had a reader since it started, and buffers up to 4 MiB
per stream that is not reading. A stream past that is closed and logged as `closing a stream that
stopped reading`. Many of those lines point at a client that holds the connection but does not consume
it. The cache is not evicted; an instance serving many environments needs memory for all of their flags.

## Known limitations

- No eviction of cached environments.
- No user accounts; access is by key. Put the management API behind your identity proxy if people use it
  directly.
- Writes to one environment serialise on its row; fine for human edit rates, not for automated writes at
  hundreds per second.
- Unknown key ids are rejected without a hash comparison, so response time reveals whether a key id
  exists. Key ids are random and not secret, and the secret is still compared in constant time.
