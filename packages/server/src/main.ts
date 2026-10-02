import pino from "pino";
import { buildApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createDb, migrate } from "./db.ts";
import { Hub } from "./hub.ts";

const config = readConfig(process.env);
const log = pino({ level: config.logLevel, redact: ["req.headers.authorization"] });

const db = createDb(config.databaseUrl, (error) => {
  log.warn({ err: error }, "idle database connection failed");
});
await migrate(db);

const hub = new Hub(db, config.databaseUrl, log);
await hub.start();

const app = buildApp({ db, hub, rootKey: config.rootKey, logger: log });

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  await hub.stop();
  await app.close();
  await db.destroy();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => {
    shutdown(received).then(
      () => process.exit(0),
      (error: unknown) => {
        log.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  });
}

await app.listen({ host: config.host, port: config.port });
