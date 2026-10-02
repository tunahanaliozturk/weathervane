import { describe, expect, it } from "vitest";
import { newKey, parseKey, sameHash, sha256 } from "./keys.ts";

describe("keys", () => {
  it("parses a key it generated and stores only a hash of the secret", () => {
    const key = newKey("sdk");
    expect(parseKey(key.token)).toEqual({ kind: "sdk", id: key.id, secret: key.secret });
    expect(sameHash(key.secretHash, sha256(key.secret))).toBe(true);
    expect(key.secretHash.toString("hex")).not.toContain(key.secret);
  });

  it.each([
    "",
    "Bearer wv_sdk_0123456789abcdef_" + "a".repeat(64),
    "wv_root_0123456789abcdef_" + "a".repeat(64),
    "wv_sdk_0123456789abcdef_" + "a".repeat(63),
    "wv_sdk_0123456789ABCDEF_" + "a".repeat(64),
  ])("rejects %j", (token) => {
    expect(parseKey(token)).toBeNull();
  });

  it("compares hashes of different lengths as unequal instead of throwing", () => {
    expect(sameHash(Buffer.alloc(32), Buffer.alloc(31))).toBe(false);
  });
});
