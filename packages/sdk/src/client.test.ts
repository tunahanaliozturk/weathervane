import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FlagDefinition } from "@weathervane/core";
import { afterEach, describe, expect, it } from "vitest";
import { WeathervaneClient } from "./client.ts";

function booleanFlag(key: string, enabled: boolean): FlagDefinition {
  return {
    key,
    kind: "boolean",
    variations: [true, false],
    salt: "s",
    config: { enabled, offVariation: 1, rules: [], fallthrough: { variation: 0 } },
  };
}

function event(name: string, version: number, flags: FlagDefinition[]): string {
  return `event: ${name}\nid: ${version}\ndata: ${JSON.stringify({ version, flags })}\n\n`;
}

interface Connection {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}

/** A stand-in for the Weathervane stream endpoint that records each connection. */
class FakeServer {
  readonly connections: Connection[] = [];
  readonly #waiters: (() => void)[] = [];
  #server: Server | null = null;
  baseUrl = "";

  async start(onConnect: (connection: Connection, index: number) => void): Promise<void> {
    this.#server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const connection = { request, response };
      this.connections.push(connection);
      onConnect(connection, this.connections.length - 1);
      for (const waiter of this.#waiters.splice(0)) waiter();
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async connectionCount(count: number, timeoutMs = 5_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.connections.length < count && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.connections.length;
  }

  async stop(): Promise<void> {
    for (const { response } of this.connections) response.destroy();
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (this.#server === null) {
        resolve();
      } else {
        this.#server.close(() => {
          resolve();
        });
      }
    });
  }
}

let server: FakeServer;
let client: WeathervaneClient | undefined;

afterEach(async () => {
  client?.close();
  await server.stop();
});

function connect(options: { idleTimeoutMs?: number } = {}): WeathervaneClient {
  client = new WeathervaneClient({
    sdkKey: "wv_sdk_test",
    baseUrl: server.baseUrl,
    maxRetryMs: 50,
    onError: () => undefined,
    ...options,
  });
  return client;
}

describe("WeathervaneClient", () => {
  it("serves the fallback until the first ruleset arrives, then evaluates locally", async () => {
    server = new FakeServer();
    let send: (() => void) | undefined;
    await server.start(({ response }) => {
      send = () => response.write(event("ruleset", 3, [booleanFlag("new-checkout", true)]));
    });
    const flags = connect();
    await server.connectionCount(1);
    expect(flags.evaluate("new-checkout", { key: "u1" }, false).reason).toEqual({
      kind: "error",
      errorCode: "not_ready",
    });

    send?.();
    await flags.ready();
    expect(flags.variation("new-checkout", { key: "u1" }, false)).toBe(true);
    expect(flags.version).toBe(3);
  });

  it("applies changes and tells listeners which flags changed", async () => {
    server = new FakeServer();
    let response: ServerResponse | undefined;
    await server.start((connection) => {
      response = connection.response;
      response.write(event("ruleset", 1, [booleanFlag("a", true), booleanFlag("b", true)]));
    });
    const flags = connect();
    await flags.ready();
    const changed = new Promise<readonly string[]>((resolve) => flags.onChange(resolve));
    response?.write(event("flags", 2, [booleanFlag("b", false)]));
    expect(await changed).toEqual(["b"]);
    expect(flags.variation("a", { key: "u" }, false)).toBe(true);
    expect(flags.variation("b", { key: "u" }, true)).toBe(false);
  });

  it("reconnects after the stream ends and resumes from the version it holds", async () => {
    server = new FakeServer();
    await server.start(({ response }, index) => {
      if (index === 0) {
        response.end(event("ruleset", 5, [booleanFlag("a", true)]));
      }
    });
    const flags = connect();
    await flags.ready();
    expect(await server.connectionCount(2)).toBe(2);
    expect(server.connections[1]?.request.headers["last-event-id"]).toBe("5");
    expect(server.connections[1]?.request.headers.authorization).toBe("Bearer wv_sdk_test");
  });

  it("treats a silent stream as dead and opens a new one", async () => {
    server = new FakeServer();
    await server.start(({ response }) => {
      response.write(event("ruleset", 1, [booleanFlag("a", true)]));
    });
    const flags = connect({ idleTimeoutMs: 300 });
    await flags.ready();
    expect(await server.connectionCount(2, 8_000)).toBe(2);
  });

  it("keeps serving the last ruleset while the server is gone", async () => {
    server = new FakeServer();
    await server.start(({ response }) => {
      response.write(event("ruleset", 1, [booleanFlag("a", true)]));
    });
    const flags = connect();
    await flags.ready();
    await server.stop();
    expect(flags.variation("a", { key: "u" }, false)).toBe(true);
  });

  it("returns the fallback for unknown flags and for values of another type", async () => {
    server = new FakeServer();
    await server.start(({ response }) => {
      response.write(event("ruleset", 1, [booleanFlag("a", true)]));
    });
    const flags = connect();
    await flags.ready();
    expect(flags.evaluate("missing", { key: "u" }, "x").reason).toEqual({
      kind: "error",
      errorCode: "flag_not_found",
    });
    expect(flags.evaluate("a", { key: "u" }, "not a boolean")).toEqual({
      value: "not a boolean",
      variation: null,
      reason: { kind: "error", errorCode: "wrong_type" },
    });
  });
});
