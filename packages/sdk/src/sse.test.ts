import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SseParser } from "./sse.ts";

describe("SseParser", () => {
  it("parses named events with ids, and keeps the id for later events", () => {
    const parser = new SseParser();
    const events = parser.feed('event: ruleset\nid: 7\ndata: {"a":1}\n\ndata: plain\n\n');
    expect(events).toEqual([
      { event: "ruleset", data: '{"a":1}', id: "7" },
      { event: "message", data: "plain", id: "7" },
    ]);
  });

  it("joins multi-line data and ignores comments", () => {
    const parser = new SseParser();
    expect(parser.feed(": ping\ndata: one\ndata: two\n\n")).toEqual([
      { event: "message", data: "one\ntwo", id: undefined },
    ]);
  });

  it("does not dispatch an event without data", () => {
    expect(new SseParser().feed("event: flags\nid: 3\n\n")).toEqual([]);
  });

  it("reads the retry field", () => {
    const parser = new SseParser();
    parser.feed("retry: 1500\n\n");
    expect(parser.retry).toBe(1500);
  });

  it("produces the same events however the stream is chunked and whatever line endings it uses", () => {
    const blocks = [
      "event: ruleset\nid: 1\ndata: {}\n\n",
      ": ping\n\n",
      "event: flags\nid: 2\ndata: [1]\ndata: [2]\n\n",
    ];
    fc.assert(
      fc.property(
        fc.constantFrom("\n", "\r", "\r\n"),
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 40 }),
        (newline, cuts) => {
          const text = blocks.join("").replaceAll("\n", newline);
          const parser = new SseParser();
          const events = [];
          let position = 0;
          for (const cut of cuts) {
            events.push(...parser.feed(text.slice(position, position + cut)));
            position += cut;
          }
          events.push(...parser.feed(text.slice(position)));
          expect(events).toEqual([
            { event: "ruleset", data: "{}", id: "1" },
            { event: "flags", data: "[1]\n[2]", id: "2" },
          ]);
        },
      ),
    );
  });
});
