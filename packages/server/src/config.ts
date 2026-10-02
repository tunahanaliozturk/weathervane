export interface Config {
  readonly databaseUrl: string;
  readonly rootKey: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
}

/** Reads configuration from the environment and names every problem at once. */
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
  const databaseUrl = env["DATABASE_URL"] ?? "";
  if (databaseUrl === "") problems.push("DATABASE_URL is required");
  const rootKey = env["WEATHERVANE_ROOT_KEY"] ?? "";
  if (rootKey.length < 32) problems.push("WEATHERVANE_ROOT_KEY must be at least 32 characters");
  const port = Number(env["PORT"] ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) problems.push("PORT must be a TCP port number");
  if (problems.length > 0) {
    throw new Error(`Invalid configuration: ${problems.join("; ")}.`);
  }
  return { databaseUrl, rootKey, host: env["HOST"] ?? "0.0.0.0", port, logLevel: env["LOG_LEVEL"] ?? "info" };
}
