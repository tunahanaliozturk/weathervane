import { WeathervaneClient } from "@weathervane/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createDatabase, type Fixture, seed, type Server, startServer } from "./test/harness.ts";

let server: Server;
let shop: Fixture;
let client: WeathervaneClient;

beforeAll(async () => {
  server = await startServer(await createDatabase());
  shop = await seed(server);
  await call(server, "POST", "/api/v1/projects/shop/flags", {
    key: shop.adminKey,
    body: { key: "new-checkout", kind: "boolean" },
  });
  client = new WeathervaneClient({ sdkKey: shop.productionKey, baseUrl: server.baseUrl });
  await client.ready();
});

afterAll(async () => {
  client.close();
  await server.close();
});

describe("SDK against a real server", () => {
  it("serves the off variation of a new flag, then follows a 25% rollout once it is turned on", async () => {
    const users = Array.from({ length: 2_000 }, (_, i) => ({ key: `user-${i}` }));
    expect(users.every((user) => !client.variation("new-checkout", user, true))).toBe(true);

    const changed = new Promise<readonly string[]>((resolve) => client.onChange(resolve));
    const reply = await call(
      server,
      "PUT",
      "/api/v1/projects/shop/flags/new-checkout/environments/production",
      {
        key: shop.adminKey,
        headers: { "if-match": '"1"' },
        body: {
          enabled: true,
          offVariation: 1,
          rules: [],
          fallthrough: { rollout: { weights: [25_000, 75_000], bucketBy: "key" } },
        },
      },
    );
    expect(reply.status).toBe(200);
    expect(await changed).toEqual(["new-checkout"]);

    const enabled = users.filter((user) => client.variation("new-checkout", user, false)).length;
    expect(enabled / users.length).toBeGreaterThan(0.22);
    expect(enabled / users.length).toBeLessThan(0.28);
  });

  it("agrees with the server's own evaluation for every user", async () => {
    for (let i = 0; i < 50; i++) {
      const context = { key: `user-${i}` };
      const remote = await call<{ flags: Record<string, { value: unknown }> }>(
        server,
        "POST",
        "/sdk/v1/evaluate",
        {
          key: shop.productionKey,
          body: { context },
        },
      );
      expect(client.variation("new-checkout", context, false)).toBe(remote.body.flags["new-checkout"]?.value);
    }
  });
});
