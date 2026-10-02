import type { FlagConfig, FlagKind, JsonValue } from "@weathervane/core";
import { CamelCasePlugin, type ColumnType, type Generated, Kysely, PostgresDialect, sql } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import pg from "pg";

export interface Database {
  projects: { id: Generated<string>; key: string; name: string; createdAt: Generated<Date> };
  environments: {
    id: Generated<string>;
    projectId: string;
    key: string;
    name: string;
    version: Generated<number>;
  };
  flags: {
    id: Generated<string>;
    projectId: string;
    key: string;
    kind: FlagKind;
    variations: JsonColumn<readonly JsonValue[]>;
    salt: string;
    description: string;
    createdAt: Generated<Date>;
  };
  flagConfigs: {
    flagId: string;
    environmentId: string;
    config: JsonColumn<FlagConfig>;
    version: Generated<number>;
    changedAt: number;
    updatedAt: Generated<Date>;
  };
  apiKeys: {
    id: string;
    projectId: string;
    environmentId: string | null;
    kind: "admin" | "sdk";
    secretHash: Buffer;
    createdAt: Generated<Date>;
    revokedAt: Date | null;
  };
  auditEntries: {
    id: Generated<number>;
    projectId: string;
    environmentId: string | null;
    flagId: string;
    actor: string;
    action: "flag_created" | "config_replaced";
    before: JsonColumn<FlagConfig> | null;
    after: JsonColumn<JsonValue>;
    createdAt: Generated<Date>;
  };
}

/** jsonb columns read back as parsed values and are written as JSON text. */
type JsonColumn<T> = ColumnType<T, string, string>;

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export function createDb(
  connectionString: string,
  onIdleError: (error: Error) => void,
  maxConnections = 10,
): Kysely<Database> {
  const types = new pg.TypeOverrides();
  // Environment versions and audit ids are bigint; they stay far below 2^53, so numbers are exact.
  types.setTypeParser(pg.types.builtins.INT8, Number);
  const pool = new pg.Pool({ connectionString, max: maxConnections, types });
  // Without a listener, an idle client that loses its connection crashes the process.
  pool.on("error", onIdleError);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] });
}

const migrations: Record<string, Migration> = {
  "0001_initial": {
    async up(db) {
      await sql
        .raw(
          `
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  key text NOT NULL,
  name text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  UNIQUE (project_id, key)
);

CREATE TABLE flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('boolean', 'string', 'number', 'json')),
  variations jsonb NOT NULL,
  salt text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE flag_configs (
  flag_id uuid NOT NULL REFERENCES flags (id),
  environment_id uuid NOT NULL REFERENCES environments (id),
  config jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  changed_at bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, environment_id)
);
-- Serves "what changed in this environment since version N", the query behind every stream update.
CREATE INDEX flag_configs_environment_changed ON flag_configs (environment_id, changed_at);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id),
  environment_id uuid REFERENCES environments (id),
  kind text NOT NULL CHECK (kind IN ('admin', 'sdk')),
  secret_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((kind = 'sdk') = (environment_id IS NOT NULL))
);

CREATE TABLE audit_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id),
  environment_id uuid REFERENCES environments (id),
  flag_id uuid NOT NULL REFERENCES flags (id),
  actor text NOT NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entries_project_id ON audit_entries (project_id, id DESC);
`,
        )
        .execute(db);
    },
  },
};

export async function migrate(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
  const { error } = await migrator.migrateToLatest();
  if (error !== undefined) {
    throw error instanceof Error ? error : new Error("migration failed", { cause: error });
  }
}
