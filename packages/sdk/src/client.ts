import {
  type Context,
  type Evaluation,
  evaluate,
  type FlagDefinition,
  type JsonValue,
} from "@weathervane/core";
import { SseParser } from "./sse.ts";

/**
 * Flag keys and value types for typed reads. Empty by default, so any key is accepted. Run
 * `weathervane-typegen` to generate a declaration that fills it in:
 *
 *     declare module "@weathervane/node" {
 *       interface FlagTypes { "new-checkout": boolean }
 *     }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by declaration merging
export interface FlagTypes {}

export type FlagKey = [keyof FlagTypes] extends [never] ? string : Extract<keyof FlagTypes, string>;
export type FlagValue<K extends string> = K extends keyof FlagTypes ? FlagTypes[K] : JsonValue;

export type ClientReason =
  | Evaluation["reason"]
  | { readonly kind: "error"; readonly errorCode: "not_ready" | "flag_not_found" | "wrong_type" };

export interface ClientEvaluation<T> {
  readonly value: T;
  readonly variation: number | null;
  readonly reason: ClientReason;
}

export interface ClientOptions {
  readonly sdkKey: string;
  /** Where the Weathervane server listens, such as `https://flags.internal:8080`. */
  readonly baseUrl: string;
  /** Called for connection and protocol errors. Defaults to `process.emitWarning`. */
  readonly onError?: (error: Error) => void;
  /** Longest wait between reconnect attempts. */
  readonly maxRetryMs?: number;
  /**
   * A stream silent for this long is treated as dead and reopened. The server sends a heartbeat every
   * 25 seconds, so the default allows two to go missing.
   */
  readonly idleTimeoutMs?: number;
}

interface RulesetMessage {
  readonly version: number;
  readonly flags: readonly FlagDefinition[];
}

const MIN_RETRY_MS = 250;

/**
 * Holds one environment's ruleset in memory, kept current over the server's event stream. Reads never
 * touch the network: when the server is unreachable, the last ruleset received keeps being served.
 */
export class WeathervaneClient {
  readonly #options: ClientOptions;
  readonly #flags = new Map<string, FlagDefinition>();
  readonly #listeners = new Set<(keys: readonly string[]) => void>();
  readonly #abort = new AbortController();
  readonly #ready: Promise<void>;
  #markReady: () => void = () => undefined;
  #version: number | null = null;
  #retryMs = MIN_RETRY_MS;
  #serverRetryMs = 1_000;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.#ready = new Promise((resolve) => {
      this.#markReady = resolve;
    });
    void this.#run();
  }

  /** Resolves once the first ruleset has arrived. Reads before then return the fallback. */
  async ready(timeoutMs = 10_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`No ruleset from ${this.#options.baseUrl} within ${timeoutMs} ms.`));
      }, timeoutMs);
    });
    try {
      await Promise.race([this.#ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The environment version this client holds, or null before the first ruleset. */
  get version(): number | null {
    return this.#version;
  }

  /** The flag's value for this context, or `fallback` when it cannot be evaluated. */
  variation<K extends FlagKey>(key: K, context: Context, fallback: FlagValue<K>): FlagValue<K> {
    return this.evaluate(key, context, fallback).value;
  }

  /** Like `variation`, with the variation index and the reason, for logging and debugging. */
  evaluate<K extends FlagKey>(
    key: K,
    context: Context,
    fallback: FlagValue<K>,
  ): ClientEvaluation<FlagValue<K>> {
    if (this.#version === null) {
      return { value: fallback, variation: null, reason: { kind: "error", errorCode: "not_ready" } };
    }
    const flag = this.#flags.get(key);
    if (flag === undefined) {
      return { value: fallback, variation: null, reason: { kind: "error", errorCode: "flag_not_found" } };
    }
    const result = evaluate(flag, context);
    if (result.variation === null) {
      return { value: fallback, variation: null, reason: result.reason };
    }
    // Generated types can be older than the flag; a value of another type must not reach the caller.
    if (!sameType(result.value, fallback)) {
      return { value: fallback, variation: null, reason: { kind: "error", errorCode: "wrong_type" } };
    }
    return { value: result.value as FlagValue<K>, variation: result.variation, reason: result.reason };
  }

  /** Called with the keys of changed flags after each update. Returns the function that unsubscribes. */
  onChange(listener: (keys: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#abort.abort();
  }

  // A method rather than a property read, so the checks after each await are not narrowed away.
  #closed(): boolean {
    return this.#abort.signal.aborted;
  }

  async #run(): Promise<void> {
    while (!this.#closed()) {
      try {
        await this.#stream();
      } catch (error) {
        if (this.#closed()) return;
        this.#report(error);
      }
      if (this.#closed()) return;
      // Full jitter: instances restarted together do not reconnect together.
      const delay = Math.max(this.#serverRetryMs, Math.random() * this.#retryMs);
      this.#retryMs = Math.min(this.#retryMs * 2, this.#options.maxRetryMs ?? 30_000);
      await sleep(delay, this.#abort.signal);
    }
  }

  async #stream(): Promise<void> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#options.sdkKey}`,
      accept: "text/event-stream",
    };
    if (this.#version !== null) headers["last-event-id"] = String(this.#version);

    // A connection can die without a FIN (a NAT entry expiring, a pulled cable); only silence shows it.
    const idle = new AbortController();
    const idleTimeoutMs = this.#options.idleTimeoutMs ?? 60_000;
    let lastByteAt = Date.now();
    const watchdog = setInterval(
      () => {
        if (Date.now() - lastByteAt > idleTimeoutMs)
          idle.abort(new Error(`Stream silent for ${idleTimeoutMs} ms.`));
      },
      Math.min(idleTimeoutMs, 5_000),
    );
    watchdog.unref();

    try {
      const response = await fetch(new URL("/sdk/v1/stream", this.#options.baseUrl), {
        headers,
        signal: AbortSignal.any([this.#abort.signal, idle.signal]),
      });
      if (response.status !== 200 || response.body === null) {
        const body = await response.text();
        throw new Error(`Stream refused with ${response.status}: ${body.slice(0, 200)}`);
      }
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        lastByteAt = Date.now();
        for (const event of parser.feed(decoder.decode(chunk, { stream: true }))) {
          this.#apply(event.event, event.data);
        }
        if (parser.retry !== undefined) this.#serverRetryMs = parser.retry;
      }
      // The server ended the stream cleanly; reconnect and resume.
    } finally {
      clearInterval(watchdog);
    }
  }

  #apply(event: string, data: string): void {
    if (event !== "ruleset" && event !== "flags") return;
    const message = JSON.parse(data) as RulesetMessage;
    if (event === "ruleset") this.#flags.clear();
    for (const flag of message.flags) this.#flags.set(flag.key, flag);
    this.#version = message.version;
    this.#retryMs = MIN_RETRY_MS;
    this.#markReady();
    const keys = message.flags.map((flag) => flag.key);
    for (const listener of this.#listeners) {
      try {
        listener(keys);
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error("Weathervane client error", { cause: error });
    if (this.#options.onError === undefined) {
      process.emitWarning(wrapped);
    } else {
      this.#options.onError(wrapped);
    }
  }
}

function sameType(value: JsonValue, fallback: unknown): boolean {
  if (fallback === null || typeof fallback === "object") {
    return value === null || typeof value === "object";
  }
  return typeof value === typeof fallback;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
