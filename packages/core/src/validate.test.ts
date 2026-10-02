import { describe, expect, it } from "vitest";
import type { FlagConfig } from "./types.ts";
import { validateConfig, validateVariations } from "./validate.ts";

const valid: FlagConfig = {
  enabled: true,
  offVariation: 1,
  rules: [
    {
      id: "beta",
      clauses: [{ attribute: "version", op: "semverGt", values: ["2.0.0"], negate: false }],
      serve: { rollout: { weights: [25_000, 75_000], bucketBy: "key" } },
    },
  ],
  fallthrough: { variation: 1 },
};

describe("validateVariations", () => {
  it("accepts two distinct booleans", () => {
    expect(validateVariations("boolean", [true, false])).toEqual([]);
  });

  it("names every problem at once", () => {
    expect(validateVariations("number", ["1"])).toEqual([
      { path: "variations", issue: "too_few_variations" },
      { path: "variations[0]", issue: "variation_kind_mismatch" },
    ]);
  });

  it("rejects duplicate values, including equal JSON documents", () => {
    expect(validateVariations("json", [{ a: 1 }, { a: 1 }])).toEqual([
      { path: "variations", issue: "duplicate_variation" },
    ]);
  });
});

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    expect(validateConfig(valid, 2)).toEqual([]);
  });

  it("rejects weights that do not sum to 100000 or do not match the variations", () => {
    const config: FlagConfig = {
      ...valid,
      fallthrough: { rollout: { weights: [10, 20, 30], bucketBy: "key" } },
    };
    expect(validateConfig(config, 2)).toEqual([
      { path: "fallthrough.rollout.weights", issue: "one_weight_per_variation" },
      { path: "fallthrough.rollout.weights", issue: "weights_must_sum_to_100000" },
    ]);
  });

  it("rejects out of range variations, duplicate rule ids, empty rules and mistyped values", () => {
    const config: FlagConfig = {
      enabled: true,
      offVariation: 2,
      rules: [
        { id: "a", clauses: [], serve: { variation: 0 } },
        {
          id: "a",
          clauses: [{ attribute: "age", op: "gt", values: ["18"], negate: false }],
          serve: { variation: -1 },
        },
      ],
      fallthrough: { variation: 0 },
    };
    expect(validateConfig(config, 2)).toEqual([
      { path: "offVariation", issue: "variation_out_of_range" },
      { path: "rules[0].clauses", issue: "rule_without_clauses" },
      { path: "rules[1].id", issue: "duplicate_rule_id" },
      { path: "rules[1].clauses[0].values[0]", issue: "value_does_not_fit_op" },
      { path: "rules[1].serve.variation", issue: "variation_out_of_range" },
    ]);
  });
});
