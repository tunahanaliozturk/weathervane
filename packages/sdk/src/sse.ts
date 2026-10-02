export interface ServerSentEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | undefined;
}

/**
 * Incremental parser for the event-stream format in the HTML standard: LF, CR or CRLF line endings,
 * multi-line data, comments, and chunks that split anywhere, including inside a CRLF.
 */
export class SseParser {
  #buffer = "";
  #pendingCarriageReturn = false;
  #event = "";
  #data: string[] = [];
  #id: string | undefined = undefined;
  #retry: number | undefined = undefined;
  #sawFirstChunk = false;

  /** The last `retry:` value the server sent, in milliseconds. */
  get retry(): number | undefined {
    return this.#retry;
  }

  feed(chunk: string): ServerSentEvent[] {
    if (chunk === "") {
      return [];
    }
    if (!this.#sawFirstChunk) {
      this.#sawFirstChunk = true;
      // A byte order mark at the very start is not part of the first field name.
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    if (this.#pendingCarriageReturn && chunk.startsWith("\n")) {
      chunk = chunk.slice(1);
    }
    this.#pendingCarriageReturn = false;
    this.#buffer += chunk;

    const events: ServerSentEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i++) {
      const char = this.#buffer[i];
      if (char !== "\n" && char !== "\r") continue;
      const line = this.#buffer.slice(start, i);
      if (char === "\r") {
        if (i + 1 === this.#buffer.length) {
          this.#pendingCarriageReturn = true;
        } else if (this.#buffer[i + 1] === "\n") {
          i++;
        }
      }
      start = i + 1;
      const event = this.#line(line);
      if (event !== null) events.push(event);
    }
    this.#buffer = this.#buffer.slice(start);
    return events;
  }

  #line(line: string): ServerSentEvent | null {
    if (line === "") {
      return this.#dispatch();
    }
    if (line.startsWith(":")) {
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.#id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.#retry = Number(value);
        break;
    }
    return null;
  }

  #dispatch(): ServerSentEvent | null {
    const hasData = this.#data.length > 0;
    const event = {
      event: this.#event === "" ? "message" : this.#event,
      data: this.#data.join("\n"),
      id: this.#id,
    };
    this.#event = "";
    this.#data = [];
    return hasData ? event : null;
  }
}
