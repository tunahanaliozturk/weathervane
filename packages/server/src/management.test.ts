import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createDatabase,
  type Fixture,
  ROOT_KEY,
  seed,
  type Server,
  startServer,
} from "./test/harness.ts";

let server: Server;
let shop: Fixture;
let other: Fixture;

beforeAll(async () => {
  server = await startServer(await createDatabase());
  shop = await seed(server, "shop");
  other = await seed(server, "other");
});

afterAll(async () => {
  await server.close();
});

const config = {
  enabled: true,
  offVariation: 1,
  rules: [
    {
      id: "staff",
      clauses: [{ attribute: "email", op: "endsWith", values: ["@peakup.org"], negate: false }],
      serve: { variation: 0 },
    },
  ],
  fallthrough: { rollout: { weights: [10_000, 90_000], bucketBy: "key" } },
};

describe("authentication", () => {
  it("rejects a missing key with the error envelope and a trace id", async () => {
    const reply = await call(server, "GET", "/api/v1/projects/shop/flags");
    expect(reply.status).toBe(401);
    expect(reply.body["code"]).toBe("unauthorized");
    expect(reply.body["traceId"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a key with a wrong secret", async () => {
    const forged = shop.adminKey.slice(0, -4) + "0000";
    expect((await call(server, "GET", "/api/v1/projects/shop/flags", { key: forged })).status).toBe(401);
  });

  it("refuses SDK keys on the management API", async () => {
    const reply = await call(server, "GET", "/api/v1/projects/shop/flags", { key: shop.productionKey });
    expect(reply.status).toBe(403);
    expect(reply.body["code"]).toBe("sdk_key_not_allowed");
  });

  it("answers 404 when an admin key names another project, as if it did not exist", async () => {
    const reply = await call(server, "GET", "/api/v1/projects/other/flags", { key: shop.adminKey });
    expect(reply.status).toBe(404);
    expect(reply.body["code"]).toBe("project_not_found");
  });

  it("lets only the root key create admin keys", async () => {
    const reply = await call(server, "POST", "/api/v1/projects/shop/keys", {
      key: shop.adminKey,
      body: { kind: "admin" },
    });
    expect(reply.status).toBe(403);
  });

  it("stops accepting a key once it is revoked, and revoking twice still succeeds", async () => {
    const created = await call<{ id: string; token: string }>(server, "POST", "/api/v1/projects/shop/keys", {
      key: shop.adminKey,
      body: { kind: "sdk", environment: "development" },
    });
    expect((await call(server, "GET", "/sdk/v1/ruleset", { key: created.body.token })).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const revoked = await call(server, "DELETE", `/api/v1/projects/shop/keys/${created.body.id}`, {
        key: shop.adminKey,
      });
      expect(revoked.status).toBe(204);
    }
    expect((await call(server, "GET", "/sdk/v1/ruleset", { key: created.body.token })).status).toBe(401);
  });

  it("does not let one project's admin key revoke another project's keys", async () => {
    const created = await call<{ id: string; token: string }>(server, "POST", "/api/v1/projects/other/keys", {
      key: other.adminKey,
      body: { kind: "sdk", environment: "production" },
    });
    await call(server, "DELETE", `/api/v1/projects/shop/keys/${created.body.id}`, { key: shop.adminKey });
    expect((await call(server, "GET", "/sdk/v1/ruleset", { key: created.body.token })).status).toBe(200);
  });
});

describe("projects", () => {
  it("rejects a duplicate project key with 409", async () => {
    const reply = await call(server, "POST", "/api/v1/projects", {
      key: ROOT_KEY,
      body: { key: "shop", name: "Again", environments: [{ key: "production", name: "Production" }] },
    });
    expect(reply.status).toBe(409);
    expect(reply.body["code"]).toBe("project_exists");
  });

  it("rejects unknown fields instead of dropping them", async () => {
    const reply = await call(server, "POST", "/api/v1/projects", {
      key: ROOT_KEY,
      body: { key: "x", name: "X", environments: [{ key: "a", name: "A" }], owner: "me" },
    });
    expect(reply.status).toBe(400);
    expect(reply.body["code"]).toBe("invalid_request");
  });
});

describe("flags", () => {
  it("creates a boolean flag that is off in every environment", async () => {
    const reply = await call(server, "POST", "/api/v1/projects/shop/flags", {
      key: shop.adminKey,
      body: { key: "new-checkout", kind: "boolean", description: "The redesigned checkout" },
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ key: "new-checkout", variations: [true, false] });
    const environments = reply.body["environments"] as Record<
      string,
      { config: { enabled: boolean }; version: number }
    >;
    expect(Object.keys(environments)).toEqual(["development", "production"]);
    expect(environments["production"]).toMatchObject({
      config: { enabled: false, offVariation: 1 },
      version: 1,
    });
  });

  it("rejects a duplicate flag key with 409", async () => {
    const reply = await call(server, "POST", "/api/v1/projects/shop/flags", {
      key: shop.adminKey,
      body: { key: "new-checkout", kind: "boolean" },
    });
    expect(reply.status).toBe(409);
  });

  it("names every problem with the variations at once", async () => {
    const reply = await call(server, "POST", "/api/v1/projects/shop/flags", {
      key: shop.adminKey,
      body: { key: "bad", kind: "number", variations: ["1"] },
    });
    expect(reply.status).toBe(422);
    expect(reply.body["details"]).toEqual([
      { field: "variations", issue: "too_few_variations" },
      { field: "variations[0]", issue: "variation_kind_mismatch" },
    ]);
  });

  it("requires If-Match to replace a config", async () => {
    const reply = await call(
      server,
      "PUT",
      "/api/v1/projects/shop/flags/new-checkout/environments/production",
      {
        key: shop.adminKey,
        body: config,
      },
    );
    expect(reply.status).toBe(428);
  });

  it("replaces a config at the version read, and rejects the stale writer with 412", async () => {
    const path = "/api/v1/projects/shop/flags/new-checkout/environments/production";
    const first = await call(server, "PUT", path, {
      key: shop.adminKey,
      body: config,
      headers: { "if-match": '"1"' },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"2"');
    expect(first.body).toMatchObject({ version: 2, config });

    const stale = await call(server, "PUT", path, {
      key: shop.adminKey,
      body: config,
      headers: { "if-match": '"1"' },
    });
    expect(stale.status).toBe(412);
    expect(stale.body["code"]).toBe("version_mismatch");
  });

  it("rejects a config that breaks the flag's rules", async () => {
    const reply = await call(
      server,
      "PUT",
      "/api/v1/projects/shop/flags/new-checkout/environments/development",
      {
        key: shop.adminKey,
        body: { ...config, offVariation: 5 },
        headers: { "if-match": '"1"' },
      },
    );
    expect(reply.status).toBe(422);
    expect(reply.body["details"]).toEqual([{ field: "offVariation", issue: "variation_out_of_range" }]);
  });

  it("pages through flags with an opaque cursor", async () => {
    for (const key of ["a-flag", "b-flag"]) {
      await call(server, "POST", "/api/v1/projects/shop/flags", {
        key: shop.adminKey,
        body: { key, kind: "boolean" },
      });
    }
    const first = await call<{ items: { key: string }[]; nextCursor: string }>(
      server,
      "GET",
      "/api/v1/projects/shop/flags?limit=2",
      { key: shop.adminKey },
    );
    expect(first.body.items.map((item) => item.key)).toEqual(["a-flag", "b-flag"]);
    const second = await call<{ items: { key: string }[]; nextCursor: string | null }>(
      server,
      "GET",
      `/api/v1/projects/shop/flags?limit=2&cursor=${first.body.nextCursor}`,
      { key: shop.adminKey },
    );
    expect(second.body.items.map((item) => item.key)).toEqual(["new-checkout"]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("rejects a cursor it did not issue", async () => {
    const reply = await call(server, "GET", "/api/v1/projects/shop/flags?cursor=bm9wZQ", {
      key: shop.adminKey,
    });
    expect(reply.status).toBe(400);
    expect(reply.body["code"]).toBe("invalid_cursor");
  });

  it("records who changed what in the audit log, newest first", async () => {
    const reply = await call<{
      items: { action: string; flag: string; environment: string | null; actor: string }[];
    }>(server, "GET", "/api/v1/projects/shop/audit?limit=10", { key: shop.adminKey });
    const replaced = reply.body.items.find((item) => item.action === "config_replaced");
    expect(replaced).toMatchObject({ flag: "new-checkout", environment: "production" });
    expect(replaced?.actor).toMatch(/^key:[0-9a-f]{16}$/);
    expect(reply.body.items.at(-1)).toMatchObject({
      action: "flag_created",
      flag: "new-checkout",
      environment: null,
    });
  });
});
