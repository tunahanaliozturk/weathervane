import type { Kysely } from "kysely";
import { Type } from "typebox";
import type { App, Deps } from "./app.ts";
import type { ManagementPrincipal } from "./auth.ts";
import { type Database, isUniqueViolation } from "./db.ts";
import { ApiError, forbidden, notFound } from "./errors.ts";
import { notifyRevoke } from "./hub.ts";
import { newKey } from "./keys.ts";
import { CreateKeyBody, CreateProjectBody, Key } from "./schemas.ts";

export interface ProjectRef {
  readonly id: string;
  readonly key: string;
}

/**
 * The project a management call acts on. An admin key naming another project gets the same 404 as a
 * project that does not exist, so keys cannot be used to discover project names.
 */
export async function resolveProject(
  db: Kysely<Database>,
  principal: ManagementPrincipal,
  projectKey: string,
): Promise<ProjectRef> {
  const project = await db
    .selectFrom("projects")
    .select(["id", "key"])
    .where("key", "=", projectKey)
    .executeTakeFirst();
  if (project === undefined || (principal.kind === "admin" && principal.projectId !== project.id)) {
    throw notFound("project");
  }
  return project;
}

export function projectRoutes(app: App, { db, auth }: Deps): void {
  app.post("/api/v1/projects", { schema: { body: CreateProjectBody } }, async (request, reply) => {
    const principal = await auth.management(request);
    if (principal.kind !== "root") {
      throw forbidden("Only the root key creates projects.");
    }
    const { key, name, environments } = request.body;
    if (new Set(environments.map((environment) => environment.key)).size !== environments.length) {
      throw new ApiError(400, "duplicate_environment", "Environment keys must be unique within a project.");
    }
    try {
      await db.transaction().execute(async (trx) => {
        const project = await trx
          .insertInto("projects")
          .values({ key, name })
          .returning("id")
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("environments")
          .values(environments.map((environment) => ({ ...environment, projectId: project.id })))
          .execute();
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "project_exists", `A project with key ${key} already exists.`);
      }
      throw error;
    }
    return reply.status(201).send({ key, name, environments });
  });

  app.post(
    "/api/v1/projects/:project/keys",
    { schema: { params: Type.Object({ project: Key }), body: CreateKeyBody } },
    async (request, reply) => {
      const principal = await auth.management(request);
      const project = await resolveProject(db, principal, request.params.project);
      const { kind, environment } = request.body;
      if (kind === "admin" && principal.kind !== "root") {
        throw forbidden("Only the root key creates admin keys.");
      }
      if ((kind === "sdk") !== (environment !== undefined)) {
        throw new ApiError(
          400,
          "environment_required_for_sdk_keys",
          "SDK keys name one environment; admin keys none.",
        );
      }
      let environmentId: string | null = null;
      if (environment !== undefined) {
        const row = await db
          .selectFrom("environments")
          .select("id")
          .where("projectId", "=", project.id)
          .where("key", "=", environment)
          .executeTakeFirst();
        if (row === undefined) throw notFound("environment");
        environmentId = row.id;
      }
      const key = newKey(kind);
      await db
        .insertInto("apiKeys")
        .values({ id: key.id, projectId: project.id, environmentId, kind, secretHash: key.secretHash })
        .execute();
      request.log.info({ keyId: key.id, kind, actor: principal.actor }, "key created");
      // The only time the secret leaves the server.
      return reply.status(201).send({ id: key.id, kind, environment: environment ?? null, token: key.token });
    },
  );

  app.delete(
    "/api/v1/projects/:project/keys/:keyId",
    { schema: { params: Type.Object({ project: Key, keyId: Type.String({ pattern: "^[0-9a-f]{16}$" }) }) } },
    async (request, reply) => {
      const principal = await auth.management(request);
      const project = await resolveProject(db, principal, request.params.project);
      await db.transaction().execute(async (trx) => {
        const revoked = await trx
          .updateTable("apiKeys")
          .set({ revokedAt: new Date() })
          .where("id", "=", request.params.keyId)
          .where("projectId", "=", project.id)
          .where("revokedAt", "is", null)
          // Admin keys revoke SDK keys only; the root key revokes anything.
          .$if(principal.kind === "admin", (query) => query.where("kind", "=", "sdk"))
          .returning("id")
          .executeTakeFirst();
        if (revoked !== undefined) {
          // Open streams for this key close on every instance.
          await notifyRevoke(trx, revoked.id);
        }
      });
      // Revoking a key that is already revoked or never existed succeeds too: the end state is the same.
      return reply.status(204).send();
    },
  );
}
