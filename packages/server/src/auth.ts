import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "./db.ts";
import { ApiError } from "./errors.ts";
import { parseKey, sameHash, sha256 } from "./keys.ts";

export type Principal =
  | { readonly kind: "root"; readonly actor: "root" }
  | { readonly kind: "admin"; readonly actor: string; readonly keyId: string; readonly projectId: string }
  | {
      readonly kind: "sdk";
      readonly actor: string;
      readonly keyId: string;
      readonly projectId: string;
      readonly environmentId: string;
    };

export type ManagementPrincipal = Exclude<Principal, { kind: "sdk" }>;
export type SdkPrincipal = Extract<Principal, { kind: "sdk" }>;

const unauthorized = () =>
  new ApiError(401, "unauthorized", "Send a valid key as `Authorization: Bearer <key>`.");

export class Authenticator {
  readonly #db: Kysely<Database>;
  readonly #rootKeyHash: Buffer;

  constructor(db: Kysely<Database>, rootKey: string) {
    this.#db = db;
    this.#rootKeyHash = sha256(rootKey);
  }

  async management(request: FastifyRequest): Promise<ManagementPrincipal> {
    const principal = await this.#authenticate(request);
    if (principal.kind === "sdk") {
      throw new ApiError(403, "sdk_key_not_allowed", "SDK keys can only call /sdk routes.");
    }
    return principal;
  }

  async sdk(request: FastifyRequest): Promise<SdkPrincipal> {
    const principal = await this.#authenticate(request);
    if (principal.kind !== "sdk") {
      throw new ApiError(
        403,
        "sdk_key_required",
        "The /sdk routes take an SDK key, which names the environment.",
      );
    }
    return principal;
  }

  async #authenticate(request: FastifyRequest): Promise<Principal> {
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ") !== true) {
      throw unauthorized();
    }
    const token = header.slice("Bearer ".length);
    const parsed = parseKey(token);
    if (parsed === null) {
      // Not shaped like an issued key, so it can only be the root key.
      if (sameHash(sha256(token), this.#rootKeyHash)) {
        return { kind: "root", actor: "root" };
      }
      throw unauthorized();
    }
    const row = await this.#db
      .selectFrom("apiKeys")
      .select(["kind", "projectId", "environmentId", "secretHash"])
      .where("id", "=", parsed.id)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    if (row?.kind !== parsed.kind || !sameHash(sha256(parsed.secret), row.secretHash)) {
      throw unauthorized();
    }
    const actor = `key:${parsed.id}`;
    if (row.kind === "admin") {
      return { kind: "admin", actor, keyId: parsed.id, projectId: row.projectId };
    }
    if (row.environmentId === null) {
      throw unauthorized();
    }
    return {
      kind: "sdk",
      actor,
      keyId: parsed.id,
      projectId: row.projectId,
      environmentId: row.environmentId,
    };
  }
}
