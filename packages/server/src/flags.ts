import { randomBytes } from "node:crypto";
import { type FlagConfig, type JsonValue, validateConfig, validateVariations } from "@weathervane/core";
import type { Kysely } from "kysely";
import { Type } from "typebox";
import type { App, Deps } from "./app.ts";
import { type Database, isUniqueViolation, json } from "./db.ts";
import { ApiError, notFound } from "./errors.ts";
import { notifyChange } from "./hub.ts";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination.ts";
import { resolveProject } from "./projects.ts";
import { CreateFlagBody, FlagConfigBody, Key, PageQuery } from "./schemas.ts";

const FlagParams = Type.Object({ project: Key, flag: Key });
const ConfigParams = Type.Object({ project: Key, flag: Key, environment: Key });

/** Accepts `"7"`, `W/"7"` and a bare `7`. */
function expectedVersion(ifMatch: string | undefined): number {
  if (ifMatch === undefined) {
    throw new ApiError(428, "if_match_required", "Send If-Match with the config version you read.");
  }
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(ifMatch.trim());
  if (match?.[1] === undefined) {
    throw new ApiError(400, "invalid_if_match", 'If-Match must carry a config version, such as "3".');
  }
  return Number(match[1]);
}

async function flagView(db: Kysely<Database>, projectId: string, flagKey: string) {
  const flag = await db
    .selectFrom("flags")
    .select(["id", "key", "kind", "variations", "description", "createdAt"])
    .where("projectId", "=", projectId)
    .where("key", "=", flagKey)
    .executeTakeFirst();
  if (flag === undefined) {
    throw notFound("flag");
  }
  const configs = await db
    .selectFrom("flagConfigs as c")
    .innerJoin("environments as e", "e.id", "c.environmentId")
    .select(["e.key as environment", "c.config", "c.version", "c.updatedAt"])
    .where("c.flagId", "=", flag.id)
    .orderBy("e.key")
    .execute();
  const environments: Record<string, { config: FlagConfig; version: number; updatedAt: Date }> = {};
  for (const { environment, ...config } of configs) {
    environments[environment] = config;
  }
  return {
    key: flag.key,
    kind: flag.kind,
    variations: flag.variations,
    description: flag.description,
    createdAt: flag.createdAt,
    environments,
  };
}

export function flagRoutes(app: App, { db, hub, auth }: Deps): void {
  app.post(
    "/api/v1/projects/:project/flags",
    { schema: { params: Type.Object({ project: Key }), body: CreateFlagBody } },
    async (request, reply) => {
      const principal = await auth.management(request);
      const project = await resolveProject(db, principal, request.params.project);
      const { key, kind, description = "" } = request.body;
      const variations: readonly JsonValue[] | undefined =
        request.body.variations ?? (kind === "boolean" ? [true, false] : undefined);
      if (variations === undefined) {
        throw new ApiError(400, "variations_required", "Only boolean flags have default variations.");
      }
      const issues = validateVariations(kind, variations);
      const offVariation = request.body.offVariation ?? variations.length - 1;
      if (offVariation >= variations.length) {
        issues.push({ path: "offVariation", issue: "variation_out_of_range" });
      }
      if (issues.length > 0) {
        throw new ApiError(
          422,
          "invalid_variations",
          "The variations are not valid for this flag.",
          toDetails(issues),
        );
      }
      // Off everywhere until someone turns it on.
      const config: FlagConfig = {
        enabled: false,
        offVariation,
        rules: [],
        fallthrough: { variation: offVariation },
      };

      let environmentIds: string[] = [];
      try {
        await db.transaction().execute(async (trx) => {
          const flag = await trx
            .insertInto("flags")
            .values({
              projectId: project.id,
              key,
              kind,
              variations: json(variations),
              salt: randomBytes(8).toString("hex"),
              description,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          // Lock in id order, the same order every multi-environment writer uses, so two writers cannot
          // deadlock on each other's environment rows.
          const environments = await trx
            .selectFrom("environments")
            .select("id")
            .where("projectId", "=", project.id)
            .orderBy("id")
            .forUpdate()
            .execute();
          environmentIds = environments.map((environment) => environment.id);
          for (const environment of environments) {
            const { version } = await trx
              .updateTable("environments")
              .set((eb) => ({ version: eb("version", "+", 1) }))
              .where("id", "=", environment.id)
              .returning("version")
              .executeTakeFirstOrThrow();
            await trx
              .insertInto("flagConfigs")
              .values({
                flagId: flag.id,
                environmentId: environment.id,
                config: json(config),
                changedAt: version,
              })
              .execute();
            await notifyChange(trx, environment.id, version);
          }
          await trx
            .insertInto("auditEntries")
            .values({
              projectId: project.id,
              environmentId: null,
              flagId: flag.id,
              actor: principal.actor,
              action: "flag_created",
              before: null,
              after: json({ kind, variations, description, config }),
            })
            .execute();
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "flag_exists", `A flag with key ${key} already exists in this project.`);
        }
        throw error;
      }
      await Promise.all(environmentIds.map((id) => hub.refresh(id)));
      return reply.status(201).send(await flagView(db, project.id, key));
    },
  );

  app.get(
    "/api/v1/projects/:project/flags",
    { schema: { params: Type.Object({ project: Key }), querystring: PageQuery } },
    async (request) => {
      const principal = await auth.management(request);
      const project = await resolveProject(db, principal, request.params.project);
      const limit = pageLimit(request.query.limit);
      const after = decodeCursor(request.query.cursor, "string");
      const rows = await db
        .selectFrom("flags")
        .select(["key", "kind", "description", "createdAt"])
        .where("projectId", "=", project.id)
        .$if(after !== undefined, (query) => query.where("key", ">", after ?? ""))
        .orderBy("key")
        .limit(limit + 1)
        .execute();
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.key) : null };
    },
  );

  app.get("/api/v1/projects/:project/flags/:flag", { schema: { params: FlagParams } }, async (request) => {
    const principal = await auth.management(request);
    const project = await resolveProject(db, principal, request.params.project);
    return flagView(db, project.id, request.params.flag);
  });

  app.put(
    "/api/v1/projects/:project/flags/:flag/environments/:environment",
    { schema: { params: ConfigParams, body: FlagConfigBody } },
    async (request, reply) => {
      const principal = await auth.management(request);
      const expected = expectedVersion(request.headers["if-match"]);
      const project = await resolveProject(db, principal, request.params.project);
      const flag = await db
        .selectFrom("flags")
        .select(["id", "variations"])
        .where("projectId", "=", project.id)
        .where("key", "=", request.params.flag)
        .executeTakeFirst();
      if (flag === undefined) throw notFound("flag");
      const environment = await db
        .selectFrom("environments")
        .select("id")
        .where("projectId", "=", project.id)
        .where("key", "=", request.params.environment)
        .executeTakeFirst();
      if (environment === undefined) throw notFound("environment");

      const config: FlagConfig = request.body;
      const issues = validateConfig(config, flag.variations.length);
      if (issues.length > 0) {
        throw new ApiError(
          422,
          "invalid_flag_config",
          "The config breaks the flag's rules.",
          toDetails(issues),
        );
      }

      const saved = await db.transaction().execute(async (trx) => {
        // Bumping the environment version takes its row lock, which serialises writers per environment
        // and keeps versions in commit order. The stream relies on that; see hub.ts.
        const { version: environmentVersion } = await trx
          .updateTable("environments")
          .set((eb) => ({ version: eb("version", "+", 1) }))
          .where("id", "=", environment.id)
          .returning("version")
          .executeTakeFirstOrThrow();
        const before = await trx
          .selectFrom("flagConfigs")
          .select(["config", "version"])
          .where("flagId", "=", flag.id)
          .where("environmentId", "=", environment.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (before.version !== expected) {
          throw new ApiError(
            412,
            "version_mismatch",
            `The config changed since you read it; it is now at version ${before.version}.`,
          );
        }
        const updated = await trx
          .updateTable("flagConfigs")
          .set((eb) => ({
            config: json(config),
            version: eb("version", "+", 1),
            changedAt: environmentVersion,
            updatedAt: new Date(),
          }))
          .where("flagId", "=", flag.id)
          .where("environmentId", "=", environment.id)
          .returning(["version", "updatedAt"])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("auditEntries")
          .values({
            projectId: project.id,
            environmentId: environment.id,
            flagId: flag.id,
            actor: principal.actor,
            action: "config_replaced",
            before: json(before.config),
            after: json(config),
          })
          .execute();
        await notifyChange(trx, environment.id, environmentVersion);
        return updated;
      });
      await hub.refresh(environment.id);
      return reply.header("etag", `"${saved.version}"`).send({ config, ...saved });
    },
  );

  app.get(
    "/api/v1/projects/:project/audit",
    { schema: { params: Type.Object({ project: Key }), querystring: PageQuery } },
    async (request) => {
      const principal = await auth.management(request);
      const project = await resolveProject(db, principal, request.params.project);
      const limit = pageLimit(request.query.limit);
      const before = decodeCursor(request.query.cursor, "number");
      const rows = await db
        .selectFrom("auditEntries as a")
        .innerJoin("flags as f", "f.id", "a.flagId")
        .leftJoin("environments as e", "e.id", "a.environmentId")
        .select([
          "a.id",
          "f.key as flag",
          "e.key as environment",
          "a.actor",
          "a.action",
          "a.before",
          "a.after",
          "a.createdAt",
        ])
        .where("a.projectId", "=", project.id)
        .$if(before !== undefined, (query) => query.where("a.id", "<", before ?? 0))
        .orderBy("a.id", "desc")
        .limit(limit + 1)
        .execute();
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.id) : null };
    },
  );
}

function toDetails(issues: readonly { path: string; issue: string }[]) {
  return issues.map(({ path, issue }) => ({ field: path, issue }));
}
