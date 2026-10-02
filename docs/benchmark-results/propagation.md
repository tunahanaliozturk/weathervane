# Propagation latency

How long a flag change takes to reach every open SDK stream. Measured on 2026-10-02 with
[`bench/propagation.ts`](../../bench/propagation.ts).

## Linux, GitHub-hosted runner

[Run 37005752222](https://github.com/tunahanaliozturk/weathervane/actions/runs/37005752222) of
`.github/workflows/bench.yml`: an `ubuntu-latest` runner with 4 vCPUs (Intel Xeon Platinum 8573C), Node
24.21.0, Postgres 18 as a service container, one server instance, and the load generator (4 worker
processes, raw TCP) on the same runner. 10,000 streams, 20 flag changes 500 ms apart.

| Streams | PUT p50 | PUT p99 | Per stream p50 |      p95 |      p99 |      Max | Last stream, p50 over flips |
| ------: | ------: | ------: | -------------: | -------: | -------: | -------: | --------------------------: |
|  10,000 | 19.8 ms | 35.0 ms |        86.6 ms | 144.2 ms | 157.9 ms | 182.9 ms |                    146.5 ms |

Anyone can rerun it from the Actions tab with other stream counts.

## Windows laptop

### Setup

- Intel Core Ultra 7 255H (16 logical CPUs), 32 GB RAM, Windows 11 Enterprise.
- One server instance, Node 26.8.2, `LOG_LEVEL=info`, running on the host.
- Postgres 18 (`postgres:18-alpine`) in Docker Desktop on the same machine.
- The load generator on the same machine: 4 worker processes holding the streams over raw TCP, so
  the client's own parsing stays small. Arrival times use `performance.timeOrigin + performance.now()`,
  a clock the processes share.
- Each run: open all streams, then 20 flag changes 500 ms apart. Latency is from sending the `PUT` to a
  stream receiving the change.

```bash
WEATHERVANE_ROOT_KEY=... node bench/propagation.ts --base-url http://127.0.0.1:8081 \
  --streams 10000 --workers 4 --flips 20
```

### Results

| Streams | PUT p50 | Per stream p50 |      p95 |      p99 |      Max | Last stream, p50 over flips |
| ------: | ------: | -------------: | -------: | -------: | -------: | --------------------------: |
|   1,000 | 17.9 ms |        29.5 ms |  41.6 ms |  45.0 ms |  48.7 ms |                     41.8 ms |
|  10,000 | 28.7 ms |       150.2 ms | 316.2 ms | 507.5 ms | 558.9 ms |                    268.5 ms |

The server's own part, from the `change broadcast` debug log in a separate 10-flip run with 10,000
streams: writing the event to all 10,000 sockets took 9.6 to 25.6 ms, median 15.8 ms.

### Reading it

- Below a thousand streams, a change reaches everyone in about the time of the write itself: the `PUT`
  is a transaction plus one query, and the broadcast is a few milliseconds.
- At 10,000 streams the server finishes writing in about 16 ms, but the median stream sees the change
  about 150 ms after the `PUT`. The rest is spent after the server's write loop: the bytes cross the
  Windows TCP stack and are read by four client processes handling 2,500 sockets each, all on the laptop
  that also runs the server and Postgres. This run does not split that remainder further. These numbers are an upper bound for one machine, not the server's cost.
- `PUT` p99 at 10,000 streams was 566 ms. The instance that takes a write refreshes its own copy before
  answering, so a `PUT` can wait behind a broadcast already running on that event loop.
- An earlier run that read the streams with `fetch` instead of raw sockets gave a 10,000-stream p50 of
  140 to 170 ms with one or four client processes, and 42 ms at 1,000 streams. The client was part of
  what that measured.

## Not measured here

- More than one server instance. Each instance writes only to its own streams, so the fan-out cost per
  instance falls with the number of instances; the notification costs one query per instance.
- Windows needed the connect bursts kept under the listen backlog of 511 and two minutes between runs
  for `TIME_WAIT` sockets to free the ephemeral ports.
