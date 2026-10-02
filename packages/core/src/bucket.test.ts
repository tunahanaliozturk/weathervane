import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BUCKET_SCALE, bucketOf, pickVariation } from "./bucket.ts";

describe("bucketOf", () => {
  it("is stable for the same flag, salt and value", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (flag, salt, value) => {
        expect(bucketOf(flag, salt, value)).toBe(bucketOf(flag, salt, value));
      }),
    );
  });

  it("stays inside the bucket range", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (flag, salt, value) => {
        const bucket = bucketOf(flag, salt, value);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(BUCKET_SCALE);
      }),
    );
  });

  it("splits 100k keys within half a percentage point of a 10/30/60 rollout", () => {
    const weights = [10_000, 30_000, 60_000];
    const counts = [0, 0, 0];
    const total = 100_000;
    for (let i = 0; i < total; i++) {
      const variation = pickVariation(weights, bucketOf("checkout-v2", "s4lt", `user-${i}`));
      if (variation === null) throw new Error("weights cover every bucket");
      counts[variation] = (counts[variation] ?? 0) + 1;
    }
    for (const [index, weight] of weights.entries()) {
      expect(Math.abs((counts[index] ?? 0) / total - weight / BUCKET_SCALE)).toBeLessThan(0.005);
    }
  });

  it("does not correlate two flags with different salts", () => {
    let both = 0;
    const total = 50_000;
    for (let i = 0; i < total; i++) {
      const a = bucketOf("flag-a", "salt-a", `user-${i}`) < 50_000;
      const b = bucketOf("flag-b", "salt-b", `user-${i}`) < 50_000;
      if (a && b) both++;
    }
    // Independent 50% rollouts overlap on about a quarter of users.
    expect(Math.abs(both / total - 0.25)).toBeLessThan(0.01);
  });
});

describe("pickVariation", () => {
  it("keeps every user in a two-way rollout's first variation when its share grows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: BUCKET_SCALE }),
        fc.integer({ min: 0, max: BUCKET_SCALE }),
        fc.string(),
        (a, b, key) => {
          const [smaller, larger] = a <= b ? [a, b] : [b, a];
          const bucket = bucketOf("sticky", "salt", key);
          const before = pickVariation([smaller, BUCKET_SCALE - smaller], bucket);
          const after = pickVariation([larger, BUCKET_SCALE - larger], bucket);
          if (before === 0) {
            expect(after).toBe(0);
          }
        },
      ),
    );
  });

  it("returns null when the weights do not cover the bucket", () => {
    expect(pickVariation([10, 20], 30)).toBeNull();
    expect(pickVariation([], 0)).toBeNull();
  });
});
