import type { FlagDefinition } from "@weathervane/core";
import type { FastifyBaseLogger } from "fastify";
import { type Kysely, sql } from "kysely";
import pg from "pg";
import type { Database } from "./db.ts";

export const CHANNEL = "weathervane_changes";

export function changePayload(environmentId: string, version: number): string {
  return `change:${environmentId}:${version}`;
}

export function revokePayload(keyId: string): string {
  return `revoke:${keyId}`;
}

export interface Ruleset {
  readonly version: number;
  readonly flags: readonly FlagDefinition[];
}

/** Where a stream's bytes go. The HTTP layer adapts a response to it; tests can pass a plain object. */
export interface Sink {
  write(chunk: string): void;
  /** Bytes accepted but not yet flushed to the socket. */
  readonly buffered: number;
  close(): void;
}

interface Subscriber {
  readonly keyId: string;
  readonly sink: Sink;
}

interface CachedFlag {
  readonly definition: FlagDefinition;
  readonly changedAt: number;
}

class EnvironmentState {
  version = 0;
  readonly flags = new Map<string, CachedFlag>();
  readonly subscribers = new Set<Subscriber>();
  syncQueued = false;
  tail: Promise<void> = Promise.resolve();
  ready: Promise<void> = Promise.resolve();
}

export interface HubOptions {
  readonly heartbeatMs?: number;
  /** A subscriber whose unflushed bytes exceed this is cut off; it reconnects and catches up. */
  readonly maxBufferedBytes?: number;
}

export function sseEvent(event: "ruleset" | "flags", id: number, data: Ruleset): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Keeps one materialised ruleset per environment that has readers, updated from Postgres notifications,
 * and fans each change out to every open stream. See docs/design.md, "Propagation path".
 */
export class Hub {
  readonly #db: Kysely<Database>;
  readonly #connectionString: string;
  readonly #log: FastifyBaseLogger;
  readonly #heartbeatMs: number;
  readonly #maxBufferedBytes: number;
  readonly #states = new Map<string, EnvironmentState>();
  #listener: pg.Client | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #reconnectDelayMs = 250;
  #stopped = false;

  constructor(
    db: Kysely<Database>,
    connectionString: string,
    log: FastifyBaseLogger,
    options: HubOptions = {},
  ) {
    this.#db = db;
    this.#connectionString = connectionString;
    this.#log = log;
    this.#heartbeatMs = options.heartbeatMs ?? 25_000;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 4 * 1024 * 1024;
  }

  async start(): Promise<void> {
    await this.#listen();
    this.#heartbeat = setInterval(() => {
      this.#writeToAll(": ping\n\n");
    }, this.#heartbeatMs);
    this.#heartbeat.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    for (const state of this.#states.values()) {
      for (const subscriber of state.subscribers) subscriber.sink.close();
      state.subscribers.clear();
    }
    await this.#listener?.end();
  }

  get subscriberCount(): number {
    let count = 0;
    for (const state of this.#states.values()) count += state.subscribers.size;
    return count;
  }

  async ruleset(environmentId: string): Promise<Ruleset> {
    const state = await this.#state(environmentId);
    return { version: state.version, flags: [...state.flags.values()].map((flag) => flag.definition) };
  }

  /**
   * Brings a cached environment up to date now instead of when the notification arrives, so a client
   * that wrote through this instance reads its own write here. Other instances still follow the
   * notification.
   */
  async refresh(environmentId: string): Promise<void> {
    const state = this.#states.get(environmentId);
    if (state !== undefined) {
      await this.#enqueue(environmentId, state);
    }
  }

  /**
   * Sends the subscriber what it is missing and registers it for updates. Returns the function that
   * unregisters it.
   */
  async subscribe(environmentId: string, keyId: string, lastEventId: number | null, sink: Sink) {
    const state = await this.#state(environmentId);
    // No await from here on: the catch-up event and the registration happen in one turn of the event
    // loop, so an update applied by a concurrent sync lands either in the catch-up or in a broadcast.
    if (lastEventId !== null && lastEventId > 0 && lastEventId <= state.version) {
      const missed = [...state.flags.values()].filter((flag) => flag.changedAt > lastEventId);
      if (missed.length > 0) {
        sink.write(
          sseEvent("flags", state.version, {
            version: state.version,
            flags: missed.map((f) => f.definition),
          }),
        );
      }
    } else {
      const flags = [...state.flags.values()].map((flag) => flag.definition);
      sink.write(sseEvent("ruleset", state.version, { version: state.version, flags }));
    }
    const subscriber: Subscriber = { keyId, sink };
    state.subscribers.add(subscriber);
    return () => {
      state.subscribers.delete(subscriber);
    };
  }

  async #state(environmentId: string): Promise<EnvironmentState> {
    let state = this.#states.get(environmentId);
    if (state === undefined) {
      const created = new EnvironmentState();
      state = created;
      this.#states.set(environmentId, created);
      created.ready = this.#enqueue(environmentId, created, true).catch((error: unknown) => {
        // Forget the failed load so the next reader tries again.
        this.#states.delete(environmentId);
        throw error;
      });
    }
    await state.ready;
    return state;
  }

  /** Every update to one environment runs through its own promise chain, so loads never interleave. */
  #enqueue(environmentId: string, state: EnvironmentState, rethrow = false): Promise<void> {
    state.syncQueued = true;
    const run = state.tail.then(async () => {
      state.syncQueued = false;
      await this.#sync(environmentId, state);
    });
    state.tail = run.catch((error: unknown) => {
      this.#log.error({ err: error, environmentId }, "ruleset sync failed");
    });
    return rethrow ? run : state.tail;
  }

  async #sync(environmentId: string, state: EnvironmentState): Promise<void> {
    // One statement, one snapshot. Writers bump environments.version under a row lock and hold it until
    // commit, so seeing version V means every change with changedAt <= V is visible too.
    const rows = await this.#db
      .selectFrom("environments as e")
      .leftJoin("flagConfigs as c", (join) =>
        join.onRef("c.environmentId", "=", "e.id").on("c.changedAt", ">", state.version),
      )
      .leftJoin("flags as f", "f.id", "c.flagId")
      .select([
        "e.version as environmentVersion",
        "f.key",
        "f.kind",
        "f.variations",
        "f.salt",
        "c.config",
        "c.changedAt",
      ])
      .where("e.id", "=", environmentId)
      .execute();

    const environmentVersion = rows[0]?.environmentVersion;
    if (environmentVersion === undefined || environmentVersion <= state.version) {
      return;
    }
    const changed: FlagDefinition[] = [];
    for (const row of rows) {
      if (row.key === null || row.kind === null || row.variations === null || row.salt === null) continue;
      if (row.config === null || row.changedAt === null) continue;
      const definition: FlagDefinition = {
        key: row.key,
        kind: row.kind,
        variations: row.variations,
        salt: row.salt,
        config: row.config,
      };
      state.flags.set(row.key, { definition, changedAt: row.changedAt });
      changed.push(definition);
    }
    state.version = environmentVersion;
    if (changed.length > 0 && state.subscribers.size > 0) {
      const started = performance.now();
      // Serialised once, written to every subscriber.
      this.#broadcast(
        state,
        sseEvent("flags", environmentVersion, { version: environmentVersion, flags: changed }),
      );
      this.#log.debug(
        {
          environmentId,
          version: environmentVersion,
          streams: state.subscribers.size,
          ms: performance.now() - started,
        },
        "change broadcast",
      );
    }
  }

  #broadcast(state: EnvironmentState, chunk: string): void {
    for (const subscriber of state.subscribers) {
      if (subscriber.sink.buffered > this.#maxBufferedBytes) {
        this.#log.warn({ keyId: subscriber.keyId }, "closing a stream that stopped reading");
        state.subscribers.delete(subscriber);
        subscriber.sink.close();
        continue;
      }
      subscriber.sink.write(chunk);
    }
  }

  #writeToAll(chunk: string): void {
    for (const state of this.#states.values()) this.#broadcast(state, chunk);
  }

  #onNotification(payload: string): void {
    const [kind, first, second] = payload.split(":");
    if (kind === "change" && first !== undefined && second !== undefined) {
      const state = this.#states.get(first);
      if (state !== undefined && Number(second) > state.version && !state.syncQueued) {
        void this.#enqueue(first, state);
      }
      return;
    }
    if (kind === "revoke" && first !== undefined) {
      for (const state of this.#states.values()) {
        for (const subscriber of state.subscribers) {
          if (subscriber.keyId === first) {
            state.subscribers.delete(subscriber);
            subscriber.sink.close();
          }
        }
      }
    }
  }

  async #listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.#connectionString });
    client.on("notification", (message) => {
      if (message.channel === CHANNEL && message.payload !== undefined) {
        this.#onNotification(message.payload);
      }
    });
    client.on("error", (error) => {
      this.#log.warn({ err: error }, "change listener connection failed");
    });
    client.on("end", () => {
      if (this.#listener === client) this.#listener = null;
      if (!this.#stopped) this.#scheduleReconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.#listener = client;
    this.#reconnectDelayMs = 250;
  }

  #scheduleReconnect(): void {
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(delay * 2, 10_000);
    setTimeout(() => {
      this.#listen()
        .then(() => {
          // Notifications sent while we were away are gone; ask Postgres what changed instead.
          for (const [environmentId, state] of this.#states) void this.#enqueue(environmentId, state);
          this.#log.info("change listener reconnected");
        })
        .catch((error: unknown) => {
          this.#log.warn({ err: error }, "change listener reconnect failed");
          if (!this.#stopped) this.#scheduleReconnect();
        });
    }, delay).unref();
  }
}

/** Sends a change notification inside the caller's transaction; Postgres delivers it on commit. */
export async function notifyChange(db: Kysely<Database>, environmentId: string, version: number) {
  await sql`SELECT pg_notify(${CHANNEL}, ${changePayload(environmentId, version)})`.execute(db);
}

export async function notifyRevoke(db: Kysely<Database>, keyId: string) {
  await sql`SELECT pg_notify(${CHANNEL}, ${revokePayload(keyId)})`.execute(db);
}
