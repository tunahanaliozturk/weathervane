// Measures how long a flag change takes to reach every open stream.
//
//   WEATHERVANE_ROOT_KEY=... node bench/propagation.ts --base-url http://127.0.0.1:8080 \
//     --streams 10000 --workers 4 --flips 20
//
// Streams are spread over worker processes so that one client event loop parsing thousands of sockets
// does not become the thing being measured. Workers stamp each arrival with
// `performance.timeOrigin + performance.now()`, a clock shared by processes on one machine, and the
// main process subtracts the moment it sent the PUT.
import { fork } from "node:child_process";
import { connect, type Socket } from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://127.0.0.1:8080" },
    streams: { type: "string", default: "1000" },
    workers: { type: "string", default: "4" },
    flips: { type: "string", default: "20" },
    worker: { type: "boolean", default: false },
    "sdk-key": { type: "string", default: "" },
  },
});
const baseUrl = values["base-url"];
const now = () => performance.timeOrigin + performance.now();

type WorkerMessage = { kind: "open" } | { kind: "arrivals"; arrivals: [version: number, at: number][] };

if (values.worker) {
  await runWorker(Number(values.streams), values["sdk-key"]);
} else {
  await runMain();
}

/**
 * Opens its share of streams over raw TCP and records when each `flags` event arrived. Raw sockets
 * rather than fetch: undici's per-chunk cost across thousands of streams otherwise dominates the result.
 */
async function runWorker(count: number, sdkKey: string): Promise<void> {
  const send = (message: WorkerMessage) => process.send?.(message);
  const arrivals: [number, number][] = [];
  const sockets: Socket[] = [];
  const { hostname, port } = new URL(baseUrl);
  const request =
    `GET /sdk/v1/stream HTTP/1.1\r\nhost: ${hostname}:${port}\r\n` +
    `authorization: Bearer ${sdkKey}\r\naccept: text/event-stream\r\n\r\n`;
  const opened: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    opened.push(
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: hostname, port: Number(port), noDelay: true }, () =>
          socket.write(request),
        );
        sockets.push(socket);
        socket.setEncoding("latin1");
        let buffer = "";
        socket.on("data", (chunk: string) => {
          const at = now();
          buffer += chunk;
          let end: number;
          // Chunked framing lines pass through as noise; only the event fields matter here.
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.includes("event: ruleset")) resolve();
            const id = /^id: (\d+)$/m.exec(block)?.[1];
            if (block.includes("event: flags") && id !== undefined) arrivals.push([Number(id), at]);
          }
        });
        socket.on("error", reject);
      }),
    );
    // Open in batches of 100 per worker: bursts past the listen backlog (511) are refused on Windows.
    if (i % 100 === 99) await Promise.all(opened.slice(i - 99, i + 1));
  }
  await Promise.all(opened);
  send({ kind: "open" });
  process.on("message", (message) => {
    if (message === "report") {
      for (const socket of sockets) socket.destroy();
      // Disconnect only once the report is flushed: tens of thousands of samples take a while over IPC,
      // and disconnecting early lets the parent see this process exit before the message.
      process.send?.({ kind: "arrivals", arrivals } satisfies WorkerMessage, () => {
        process.disconnect();
      });
    }
  });
}

async function runMain(): Promise<void> {
  const rootKey = process.env["WEATHERVANE_ROOT_KEY"] ?? "";
  if (rootKey === "") throw new Error("Set WEATHERVANE_ROOT_KEY.");
  const streamCount = Number(values.streams);
  const workerCount = Number(values.workers);
  const flipCount = Number(values.flips);

  async function api(
    method: string,
    path: string,
    key: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as Record<string, unknown>;
  }

  const project = `bench-${Date.now()}`;
  await api("POST", "/api/v1/projects", rootKey, {
    key: project,
    name: "Benchmark",
    environments: [{ key: "production", name: "Production" }],
  });
  const adminKey = String(
    (await api("POST", `/api/v1/projects/${project}/keys`, rootKey, { kind: "admin" }))["token"],
  );
  const sdkKey = String(
    (
      await api("POST", `/api/v1/projects/${project}/keys`, adminKey, {
        kind: "sdk",
        environment: "production",
      })
    )["token"],
  );
  await api("POST", `/api/v1/projects/${project}/flags`, adminKey, { key: "bench-flag", kind: "boolean" });

  const connectStart = now();
  const share = Math.ceil(streamCount / workerCount);
  const workers = Array.from({ length: workerCount }, () =>
    fork(import.meta.filename, [
      "--worker",
      "--streams",
      String(share),
      "--base-url",
      baseUrl,
      "--sdk-key",
      sdkKey,
    ]),
  );
  const nextMessage = (child: (typeof workers)[number]) =>
    new Promise<WorkerMessage>((resolve, reject) => {
      child.once("message", (message) => {
        resolve(message as WorkerMessage);
      });
      child.once("exit", (code) => {
        // A clean exit after its last message is expected; only a crash is an error.
        if (code !== 0) reject(new Error(`worker exited with ${String(code)}`));
      });
    });
  await Promise.all(workers.map(nextMessage));
  const connectMs = now() - connectStart;

  const sentAt = new Map<number, number>();
  const putLatencies: number[] = [];
  for (let flip = 0; flip < flipCount; flip++) {
    const start = now();
    await api(
      "PUT",
      `/api/v1/projects/${project}/flags/bench-flag/environments/production`,
      adminKey,
      { enabled: flip % 2 === 0, offVariation: 1, rules: [], fallthrough: { variation: 0 } },
      { "if-match": `"${flip + 1}"` },
    );
    putLatencies.push(now() - start);
    // Stream event ids are environment versions: creating the flag made it 1, so flip n lands at n + 2.
    sentAt.set(flip + 2, start);
    // Spaced out so one flip's tail does not overlap the next.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const reports = await Promise.all(
    workers.map((child) => {
      const message = nextMessage(child);
      child.send("report");
      return message;
    }),
  );
  const perStream: number[] = [];
  const lastPerFlip = new Map<number, number>();
  for (const report of reports) {
    if (report.kind !== "arrivals") continue;
    for (const [version, at] of report.arrivals) {
      const start = sentAt.get(version);
      if (start === undefined) continue;
      perStream.push(at - start);
      lastPerFlip.set(version, Math.max(lastPerFlip.get(version) ?? 0, at - start));
    }
  }
  const expected = share * workerCount * flipCount;
  if (perStream.length !== expected) {
    throw new Error(`expected ${expected} arrivals, got ${perStream.length}`);
  }

  const percentile = (samples: number[], p: number) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
  };
  const ms = (value: number) => `${value.toFixed(1)} ms`;
  const last = [...lastPerFlip.values()];
  const report = {
    streams: share * workerCount,
    workers: workerCount,
    flips: flipCount,
    connectAllStreams: ms(connectMs),
    putLatency: { p50: ms(percentile(putLatencies, 50)), p99: ms(percentile(putLatencies, 99)) },
    perStream: {
      p50: ms(percentile(perStream, 50)),
      p95: ms(percentile(perStream, 95)),
      p99: ms(percentile(perStream, 99)),
      max: ms(perStream.reduce((a, b) => Math.max(a, b), 0)),
    },
    lastStreamPerFlip: { p50: ms(percentile(last, 50)), max: ms(last.reduce((a, b) => Math.max(a, b), 0)) },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
