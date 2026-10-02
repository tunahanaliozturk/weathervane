import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import pino from "pino";
import { inject } from "vitest";
import { type App, buildApp } from "../app.ts";
import { createDb, type Database, migrate } from "../db.ts";
import { Hub, type HubOptions } from "../hub.ts";

export const ROOT_KEY = "root-key-for-tests-0123456789abcdef";

const silent = pino({ level: "silent" });

/** A fresh database inside the shared Postgres container. */
export async function createDatabase(): Promise<string> {
  const adminUrl = inject("postgresUrl");
  const name = `wv_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export interface Server {
  readonly app: App;
  readonly db: Kysely<Database>;
  readonly hub: Hub;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** A real server on a random port: streams need a socket, not `inject`. */
export async function startServer(databaseUrl: string, options: HubOptions = {}): Promise<Server> {
  const db = createDb(databaseUrl, () => undefined);
  await migrate(db);
  const hub = new Hub(db, databaseUrl, silent, options);
  await hub.start();
  const app = buildApp({ db, hub, rootKey: ROOT_KEY });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    db,
    hub,
    baseUrl: address,
    async close() {
      await hub.stop();
      await app.close();
      await db.destroy();
    },
  };
}

export interface Reply<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export async function call<T = Record<string, unknown>>(
  server: Server,
  method: string,
  path: string,
  options: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key !== undefined) headers["authorization"] = `Bearer ${options.key}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? null : JSON.parse(text)) as T,
    headers: response.headers,
  };
}

export interface Fixture {
  readonly adminKey: string;
  readonly developmentKey: string;
  readonly productionKey: string;
}

/** Project `shop` with `development` and `production`, an admin key and one SDK key per environment. */
export async function seed(server: Server, project = "shop"): Promise<Fixture> {
  const created = await call(server, "POST", "/api/v1/projects", {
    key: ROOT_KEY,
    body: {
      key: project,
      name: "Shop",
      environments: [
        { key: "development", name: "Development" },
        { key: "production", name: "Production" },
      ],
    },
  });
  if (created.status !== 201) throw new Error(`seed failed: ${JSON.stringify(created.body)}`);
  const token = async (body: object) => {
    const reply = await call<{ token: string }>(server, "POST", `/api/v1/projects/${project}/keys`, {
      key: ROOT_KEY,
      body,
    });
    return reply.body.token;
  };
  return {
    adminKey: await token({ kind: "admin" }),
    developmentKey: await token({ kind: "sdk", environment: "development" }),
    productionKey: await token({ kind: "sdk", environment: "production" }),
  };
}

export interface StreamEvent {
  readonly event: string;
  readonly id: string;
  readonly data: { version: number; flags: { key: string; config: { enabled: boolean } }[] };
}

/** A minimal SSE reader for tests. The SDK has the full parser; this one only needs well-formed input. */
export class TestStream {
  readonly #events: StreamEvent[] = [];
  readonly #waiters: (() => void)[] = [];
  readonly #controller = new AbortController();
  closed = false;

  static async open(server: Server, key: string, lastEventId?: number): Promise<TestStream> {
    const stream = new TestStream();
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
    const response = await fetch(`${server.baseUrl}/sdk/v1/stream`, {
      headers,
      signal: stream.#controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`stream refused: ${response.status} ${await response.text()}`);
    }
    void stream.#read(response.body);
    return stream;
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields = new Map(
            block
              .split("\n")
              .filter((line) => !line.startsWith(":") && line.includes(":"))
              .map((line) => [
                line.slice(0, line.indexOf(":")),
                line.slice(line.indexOf(":") + 1).trimStart(),
              ]),
          );
          const data = fields.get("data");
          if (data !== undefined) {
            this.#events.push({
              event: fields.get("event") ?? "message",
              id: fields.get("id") ?? "",
              data: JSON.parse(data) as StreamEvent["data"],
            });
          }
        }
        this.#wake();
      }
    } catch {
      // Aborted by close(), or cut by the server.
    }
    this.closed = true;
    this.#wake();
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  /** Waits until at least `count` events arrived (or the stream closed) and returns them all. */
  async events(count: number, timeoutMs = 5_000): Promise<StreamEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.#events.length < count && !this.closed) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, left);
      });
    }
    return [...this.#events];
  }

  async waitClosed(timeoutMs = 5_000): Promise<boolean> {
    await this.events(Number.POSITIVE_INFINITY, timeoutMs);
    return this.closed;
  }

  close(): void {
    this.#controller.abort();
  }
}
