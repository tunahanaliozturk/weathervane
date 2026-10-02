import { describe, expect, it } from "vitest";
import { murmur3 } from "./murmur3.ts";

describe("murmur3", () => {
  // Reference values from the canonical C++ implementation (MurmurHash3_x86_32).
  it.each([
    ["", 0, 0],
    ["", 1, 0x514e28b7],
    ["hello", 0, 0x248bfa47],
    ["test", 0, 0xba6bd213],
    ["The quick brown fox jumps over the lazy dog", 0, 0x2e4ff723],
  ])("hashes %j with seed %i", (input, seed, expected) => {
    expect(murmur3(input, seed)).toBe(expected);
  });

  it("hashes multi-byte characters by their UTF-8 bytes", () => {
    expect(murmur3("ğüşiöç")).toBe(murmur3("ğüşiöç"));
    expect(murmur3("ğ")).not.toBe(murmur3("g"));
  });
});
