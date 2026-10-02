import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createDatabase,
  type Fixture,
  seed,
  type Server,
  startServer,
  TestStream,
} from "./test/harness.ts";

let databaseUrl: string;
let server: Server;
let shop: Fixture;

beforeAll(async () => {
  databaseUrl = await createDatabase();
  server = await startServer(databaseUrl);
  shop = await seed(server);
  await call(server, "POST", "/api/v1/projects/shop/flags", {
    key: shop.adminKey,
    body: { key: "banner", kind: "string", variations: ["hello", "merhaba"], offVariation: 0 },
  });
  await call(server, "POST", "/api/v1/projects/shop/flags", {
    key: shop.adminKey,
    body: { key: "quiet", kind: "boolean" },
  });
});

afterAll(async () => {
  await server.close();
});

let configVersion = 1;

/** Turns `banner` on in production with Turkish users served the second variation. */
async function changeBanner(server: Server, enabled: boolean) {
  const reply = await call(server, "PUT", "/api/v1/projects/shop/flags/banner/environments/production", {
    key: shop.adminKey,
    headers: { "if-match": `"${configVersion}"` },
    body: {
      enabled,
      offVariation: 0,
      rules: [
        {
          id: "tr",
          clauses: [{ attribute: "country", op: "in", values: ["TR"], negate: false }],
          serve: { variation: 1 },
        },
      ],
      fallthrough: { variation: 0 },
    },
  });
  expect(reply.status).toBe(200);
  configVersion += 1;
}

describe("ruleset", () => {
  it("serves the environment named by the key, with an ETag that answers 304 when unchanged", async () => {
    const first = await call<{ version: number; flags: { key: string }[] }>(
      server,
      "GET",
      "/sdk/v1/ruleset",
      {
        key: shop.productionKey,
      },
    );
    expect(first.status).toBe(200);
    expect(first.body.flags.map((flag) => flag.key).sort()).toEqual(["banner", "quiet"]);
    const etag = first.headers.get("etag") ?? "";
    const again = await call(server, "GET", "/sdk/v1/ruleset", {
      key: shop.productionKey,
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("refuses admin keys on SDK routes", async () => {
    const reply = await call(server, "GET", "/sdk/v1/ruleset", { key: shop.adminKey });
    expect(reply.status).toBe(403);
    expect(reply.body["code"]).toBe("sdk_key_required");
  });
});

describe("evaluate", () => {
  it("evaluates every flag for a context and says why", async () => {
    await changeBanner(server, true);
    const reply = await call<{ flags: Record<string, unknown> }>(server, "POST", "/sdk/v1/evaluate", {
      key: shop.productionKey,
      body: { context: { key: "user-1", country: "TR" } },
    });
    expect(reply.body.flags["banner"]).toEqual({
      variation: 1,
      value: "merhaba",
      reason: { kind: "rule", ruleId: "tr" },
    });
  });

  it("keeps environments apart: a production change is invisible to a development key", async () => {
    const reply = await call<{ flags: Record<string, unknown> }>(server, "POST", "/sdk/v1/evaluate", {
      key: shop.developmentKey,
      body: { context: { key: "user-1", country: "TR" } },
    });
    expect(reply.body.flags["banner"]).toEqual({ variation: 0, value: "hello", reason: { kind: "off" } });
  });
});

describe("stream", () => {
  it("opens with the full ruleset, then delivers a change as it commits", async () => {
    const stream = await TestStream.open(server, shop.productionKey);
    const [opening] = await stream.events(1);
    expect(opening?.event).toBe("ruleset");

    await changeBanner(server, false);
    const events = await stream.events(2);
    expect(events[1]).toMatchObject({ event: "flags", id: String((opening?.data.version ?? 0) + 1) });
    expect(events[1]?.data.flags).toMatchObject([{ key: "banner", config: { enabled: false } }]);
    stream.close();
  });

  it("does not announce a write that was rejected", async () => {
    const stream = await TestStream.open(server, shop.productionKey);
    await stream.events(1);
    const stale = await call(server, "PUT", "/api/v1/projects/shop/flags/banner/environments/production", {
      key: shop.adminKey,
      headers: { "if-match": '"1"' },
      body: { enabled: true, offVariation: 0, rules: [], fallthrough: { variation: 1 } },
    });
    expect(stale.status).toBe(412);
    expect(await stream.events(2, 500)).toHaveLength(1);
    stream.close();
  });

  it("sends a reconnecting client only the flags it missed", async () => {
    const first = await TestStream.open(server, shop.productionKey);
    const [snapshot] = await first.events(1);
    first.close();
    expect(snapshot?.data.flags.map((flag) => flag.key).sort()).toEqual(["banner", "quiet"]);

    await changeBanner(server, true);
    const resumed = await TestStream.open(server, shop.productionKey, snapshot?.data.version);
    const [catchUp] = await resumed.events(1);
    expect(catchUp?.event).toBe("flags");
    expect(catchUp?.data.flags.map((flag) => flag.key)).toEqual(["banner"]);
    resumed.close();
  });

  it("sends the full ruleset to a client whose Last-Event-ID is ahead of the server", async () => {
    const stream = await TestStream.open(server, shop.productionKey, 999_999);
    const [opening] = await stream.events(1);
    expect(opening?.event).toBe("ruleset");
    stream.close();
  });

  it("closes open streams when their key is revoked", async () => {
    const created = await call<{ id: string; token: string }>(server, "POST", "/api/v1/projects/shop/keys", {
      key: shop.adminKey,
      body: { kind: "sdk", environment: "production" },
    });
    const stream = await TestStream.open(server, created.body.token);
    await stream.events(1);
    await call(server, "DELETE", `/api/v1/projects/shop/keys/${created.body.id}`, { key: shop.adminKey });
    expect(await stream.waitClosed()).toBe(true);
  });

  it("delivers a change written through one instance to streams held by another", async () => {
    const second = await startServer(databaseUrl);
    try {
      const stream = await TestStream.open(second, shop.productionKey);
      await stream.events(1);
      await changeBanner(server, false);
      const events = await stream.events(2);
      expect(events[1]?.data.flags).toMatchObject([{ key: "banner", config: { enabled: false } }]);
      stream.close();
    } finally {
      await second.close();
    }
  });

  it("catches up after its change listener loses the database connection", async () => {
    const stream = await TestStream.open(server, shop.productionKey);
    await stream.events(1);
    await sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND query LIKE 'LISTEN%'`.execute(server.db);
    await changeBanner(server, true);
    const events = await stream.events(2, 10_000);
    expect(events[1]?.data.flags).toMatchObject([{ key: "banner", config: { enabled: true } }]);
    stream.close();
  });
});
