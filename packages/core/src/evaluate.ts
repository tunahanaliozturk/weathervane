import { bucketOf, pickVariation } from "./bucket.ts";
import { compareSemver, parseSemver } from "./semver.ts";
import type {
  AttributeValue,
  Clause,
  ClauseOp,
  Context,
  Evaluation,
  EvaluationErrorCode,
  FlagDefinition,
  Reason,
  Serve,
} from "./types.ts";

type SuccessReason = Exclude<Reason, { kind: "error" }>;

export function evaluate(flag: FlagDefinition, context: Context): Evaluation {
  const { config } = flag;
  if (!config.enabled) {
    return fixed(flag, config.offVariation, { kind: "off" });
  }
  for (const rule of config.rules) {
    if (rule.clauses.every((clause) => clauseMatches(clause, context))) {
      return serve(flag, rule.serve, context, { kind: "rule", ruleId: rule.id });
    }
  }
  return serve(flag, config.fallthrough, context, { kind: "fallthrough" });
}

export function clauseMatches(clause: Clause, context: Context): boolean {
  const actual = context[clause.attribute];
  // A missing attribute never matches, negated or not: a rule meant for users outside the beta must
  // not catch callers that simply forgot to send the attribute.
  if (actual === undefined) {
    return false;
  }
  const matched = clause.values.some((expected) => compare(clause.op, actual, expected));
  return matched !== clause.negate;
}

function serve(flag: FlagDefinition, target: Serve, context: Context, reason: SuccessReason): Evaluation {
  if ("variation" in target) {
    return fixed(flag, target.variation, reason);
  }
  const value = context[target.rollout.bucketBy];
  if (value === undefined) {
    return failure("missing_bucket_attribute");
  }
  const variation = pickVariation(target.rollout.weights, bucketOf(flag.key, flag.salt, String(value)));
  return variation === null ? failure("variation_out_of_range") : fixed(flag, variation, reason);
}

function fixed(flag: FlagDefinition, variation: number, reason: SuccessReason): Evaluation {
  const value = flag.variations[variation];
  return value === undefined ? failure("variation_out_of_range") : { variation, value, reason };
}

function failure(errorCode: EvaluationErrorCode): Evaluation {
  return { variation: null, value: null, reason: { kind: "error", errorCode } };
}

function compare(op: ClauseOp, actual: AttributeValue, expected: AttributeValue): boolean {
  switch (op) {
    case "in":
      return actual === expected;
    case "startsWith":
      return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected);
    case "endsWith":
      return typeof actual === "string" && typeof expected === "string" && actual.endsWith(expected);
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "semverEq":
      return semverOrder(actual, expected) === 0;
    case "semverLt":
      return semverOrder(actual, expected) === -1;
    case "semverGt":
      return semverOrder(actual, expected) === 1;
  }
}

function semverOrder(actual: AttributeValue, expected: AttributeValue): number | null {
  if (typeof actual !== "string" || typeof expected !== "string") {
    return null;
  }
  const a = parseSemver(actual);
  const b = parseSemver(expected);
  return a === null || b === null ? null : compareSemver(a, b);
}
