import { type Context, type Evaluation, evaluate } from "@weathervane/core";
import type { App, Deps } from "./app.ts";
import { ContextBody } from "./schemas.ts";

function lastEventId(header: string | string[] | undefined): number | null {
  return typeof header === "string" && /^\d{1,15}$/.test(header) ? Number(header) : null;
}

export function sdkRoutes(app: App, { hub, auth }: Deps): void {
  app.get("/sdk/v1/ruleset", async (request, reply) => {
    const principal = await auth.sdk(request);
    const ruleset = await hub.ruleset(principal.environmentId);
    const etag = `"${ruleset.version}"`;
    reply.header("etag", etag).header("cache-control", "no-cache");
    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }
    return ruleset;
  });

  app.get("/sdk/v1/stream", async (request, reply) => {
    const principal = await auth.sdk(request);
    // Load the environment before committing to a 200, so a database failure is still a normal error.
    await hub.ruleset(principal.environmentId);

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 1000\n\n");

    const unsubscribe = await hub.subscribe(
      principal.environmentId,
      principal.keyId,
      lastEventId(request.headers["last-event-id"]),
      {
        write: (chunk) => response.write(chunk),
        get buffered() {
          return response.writableLength;
        },
        close: () => response.end(),
      },
    );
    // The client may already be gone by now; then there is no close event left to wait for.
    if (response.destroyed) {
      unsubscribe();
    } else {
      response.on("close", unsubscribe);
    }
  });

  app.post("/sdk/v1/evaluate", { schema: { body: ContextBody } }, async (request) => {
    const principal = await auth.sdk(request);
    const ruleset = await hub.ruleset(principal.environmentId);
    const context = request.body.context as Context;
    const flags: Record<string, Evaluation> = {};
    for (const flag of ruleset.flags) {
      flags[flag.key] = evaluate(flag, context);
    }
    return { version: ruleset.version, flags };
  });
}
