import { randomUUID } from "node:crypto";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { Authenticator } from "./auth.ts";
import type { Database } from "./db.ts";
import { handleError, handleNotFound } from "./errors.ts";
import { flagRoutes } from "./flags.ts";
import type { Hub } from "./hub.ts";
import { projectRoutes } from "./projects.ts";
import { sdkRoutes } from "./sdk.ts";

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export interface Deps {
  readonly db: Kysely<Database>;
  readonly hub: Hub;
  readonly auth: Authenticator;
}

export interface AppOptions {
  readonly db: Kysely<Database>;
  readonly hub: Hub;
  readonly rootKey: string;
  readonly logger?: FastifyBaseLogger;
}

export function buildApp(options: AppOptions): App {
  const app: App = Fastify({
    ...(options.logger === undefined ? { logger: false } : { loggerInstance: options.logger }),
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024,
    ajv: {
      // Reject unknown fields and wrong types instead of silently dropping or coercing them.
      customOptions: { removeAdditional: false, coerceTypes: false },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);

  const deps: Deps = {
    db: options.db,
    hub: options.hub,
    auth: new Authenticator(options.db, options.rootKey),
  };

  app.get("/health", async () => {
    await sql`SELECT 1`.execute(options.db);
    return { status: "ok", streams: options.hub.subscriberCount };
  });

  projectRoutes(app, deps);
  flagRoutes(app, deps);
  sdkRoutes(app, deps);
  return app;
}
