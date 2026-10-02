import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.ts";
import type { Clause, FlagConfig, FlagDefinition } from "./types.ts";

function flag(config: Partial<FlagConfig>): FlagDefinition {
  return {
    key: "new-checkout",
    kind: "boolean",
    variations: [true, false],
    salt: "s4lt",
    config: { enabled: true, offVariation: 1, rules: [], fallthrough: { variation: 1 }, ...config },
  };
}

function ruleOn(clause: Omit<Clause, "negate"> & { negate?: boolean }): Partial<FlagConfig> {
  return { rules: [{ id: "r1", clauses: [{ negate: false, ...clause }], serve: { variation: 0 } }] };
}

describe("evaluate", () => {
  it("serves the off variation when the flag is disabled, whatever the rules say", () => {
    const disabled = flag({
      enabled: false,
      ...ruleOn({ attribute: "key", op: "in", values: ["alice"] }),
    });
    expect(evaluate(disabled, { key: "alice" })).toEqual({
      variation: 1,
      value: false,
      reason: { kind: "off" },
    });
  });

  it("serves the first matching rule", () => {
    const twoRules = flag({
      rules: [
        {
          id: "beta",
          clauses: [{ attribute: "plan", op: "in", values: ["beta"], negate: false }],
          serve: { variation: 0 },
        },
        {
          id: "all",
          clauses: [{ attribute: "key", op: "startsWith", values: [""], negate: false }],
          serve: { variation: 1 },
        },
      ],
    });
    expect(evaluate(twoRules, { key: "bob", plan: "beta" }).reason).toEqual({ kind: "rule", ruleId: "beta" });
    expect(evaluate(twoRules, { key: "bob", plan: "free" }).reason).toEqual({ kind: "rule", ruleId: "all" });
  });

  it("requires every clause in a rule to match", () => {
    const both = flag({
      rules: [
        {
          id: "r1",
          clauses: [
            { attribute: "country", op: "in", values: ["TR"], negate: false },
            { attribute: "age", op: "gte", values: [18], negate: false },
          ],
          serve: { variation: 0 },
        },
      ],
    });
    expect(evaluate(both, { key: "a", country: "TR", age: 30 }).value).toBe(true);
    expect(evaluate(both, { key: "a", country: "TR", age: 12 }).value).toBe(false);
  });

  it("falls through when no rule matches", () => {
    const result = evaluate(flag(ruleOn({ attribute: "key", op: "in", values: ["alice"] })), { key: "bob" });
    expect(result.reason).toEqual({ kind: "fallthrough" });
    expect(result.value).toBe(false);
  });

  it("never matches a clause on a missing attribute, negated or not", () => {
    const negated = flag(ruleOn({ attribute: "plan", op: "in", values: ["beta"], negate: true }));
    expect(evaluate(negated, { key: "carol" }).reason).toEqual({ kind: "fallthrough" });
    expect(evaluate(negated, { key: "carol", plan: "free" }).reason).toEqual({ kind: "rule", ruleId: "r1" });
  });

  it.each([
    ["in", "beta", ["alpha", "beta"], true],
    ["in", 5, ["5"], false],
    ["startsWith", "tr-istanbul", ["tr-"], true],
    ["endsWith", "user@peakup.org", ["@peakup.org"], true],
    ["contains", "enterprise-plus", ["prise"], true],
    ["contains", 42, ["4"], false],
    ["lt", 3, [5], true],
    ["lte", 5, [5], true],
    ["gt", 5, [5], false],
    ["gte", 5, [5], true],
    ["lt", "3", [5], false],
    ["semverEq", "2.1.0+build.4", ["2.1.0"], true],
    ["semverLt", "2.1.0-rc.1", ["2.1.0"], true],
    ["semverGt", "2.10.0", ["2.9.9"], true],
    ["semverGt", "not-a-version", ["1.0.0"], false],
  ] as const)("%s on %j against %j matches: %s", (op, actual, values, expected) => {
    const result = evaluate(flag(ruleOn({ attribute: "x", op, values })), { key: "k", x: actual });
    expect(result.reason.kind === "rule").toBe(expected);
  });

  it("buckets a rollout by the attribute named in bucketBy", () => {
    const byOrg = flag({ fallthrough: { rollout: { weights: [50_000, 50_000], bucketBy: "org" } } });
    const first = evaluate(byOrg, { key: "u1", org: "acme" });
    for (let i = 2; i < 50; i++) {
      expect(evaluate(byOrg, { key: `u${i}`, org: "acme" }).variation).toBe(first.variation);
    }
  });

  it("reports an error when the rollout attribute is missing", () => {
    const byOrg = flag({ fallthrough: { rollout: { weights: [50_000, 50_000], bucketBy: "org" } } });
    expect(evaluate(byOrg, { key: "u1" })).toEqual({
      variation: null,
      value: null,
      reason: { kind: "error", errorCode: "missing_bucket_attribute" },
    });
  });

  it("reports an error instead of throwing on a variation index out of range", () => {
    expect(evaluate(flag({ fallthrough: { variation: 7 } }), { key: "u1" }).reason).toEqual({
      kind: "error",
      errorCode: "variation_out_of_range",
    });
  });
});
