import { BUCKET_SCALE } from "./bucket.ts";
import { parseSemver } from "./semver.ts";
import type { AttributeValue, ClauseOp, FlagConfig, FlagKind, JsonValue, Serve } from "./types.ts";

export interface Issue {
  readonly path: string;
  readonly issue: string;
}

const STRING_OPS = new Set<ClauseOp>(["startsWith", "endsWith", "contains"]);
const NUMBER_OPS = new Set<ClauseOp>(["lt", "lte", "gt", "gte"]);
const SEMVER_OPS = new Set<ClauseOp>(["semverEq", "semverLt", "semverGt"]);

/** Invariants a JSON schema cannot express. An empty result means the variations are valid. */
export function validateVariations(kind: FlagKind, variations: readonly JsonValue[]): Issue[] {
  const issues: Issue[] = [];
  if (variations.length < 2) {
    issues.push({ path: "variations", issue: "too_few_variations" });
  }
  variations.forEach((value, index) => {
    if (!matchesKind(kind, value)) {
      issues.push({ path: `variations[${index}]`, issue: "variation_kind_mismatch" });
    }
  });
  if (new Set(variations.map((value) => JSON.stringify(value))).size !== variations.length) {
    issues.push({ path: "variations", issue: "duplicate_variation" });
  }
  return issues;
}

export function validateConfig(config: FlagConfig, variationCount: number): Issue[] {
  const issues: Issue[] = [];
  if (!isIndex(config.offVariation, variationCount)) {
    issues.push({ path: "offVariation", issue: "variation_out_of_range" });
  }
  validateServe(config.fallthrough, variationCount, "fallthrough", issues);

  const ruleIds = new Set<string>();
  config.rules.forEach((rule, ruleIndex) => {
    const path = `rules[${ruleIndex}]`;
    if (ruleIds.has(rule.id)) {
      issues.push({ path: `${path}.id`, issue: "duplicate_rule_id" });
    }
    ruleIds.add(rule.id);
    if (rule.clauses.length === 0) {
      issues.push({ path: `${path}.clauses`, issue: "rule_without_clauses" });
    }
    rule.clauses.forEach((clause, clauseIndex) => {
      const clausePath = `${path}.clauses[${clauseIndex}]`;
      if (clause.values.length === 0) {
        issues.push({ path: `${clausePath}.values`, issue: "values_empty" });
      }
      clause.values.forEach((value, valueIndex) => {
        if (!valueFitsOp(clause.op, value)) {
          issues.push({ path: `${clausePath}.values[${valueIndex}]`, issue: "value_does_not_fit_op" });
        }
      });
    });
    validateServe(rule.serve, variationCount, `${path}.serve`, issues);
  });
  return issues;
}

function validateServe(serve: Serve, variationCount: number, path: string, issues: Issue[]): void {
  if ("variation" in serve) {
    if (!isIndex(serve.variation, variationCount)) {
      issues.push({ path: `${path}.variation`, issue: "variation_out_of_range" });
    }
    return;
  }
  const { weights } = serve.rollout;
  if (weights.length !== variationCount) {
    issues.push({ path: `${path}.rollout.weights`, issue: "one_weight_per_variation" });
  }
  if (weights.some((weight) => !Number.isInteger(weight) || weight < 0)) {
    issues.push({ path: `${path}.rollout.weights`, issue: "weights_not_whole_numbers" });
  }
  if (weights.reduce((sum, weight) => sum + weight, 0) !== BUCKET_SCALE) {
    issues.push({ path: `${path}.rollout.weights`, issue: "weights_must_sum_to_100000" });
  }
}

function isIndex(value: number, count: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < count;
}

function valueFitsOp(op: ClauseOp, value: AttributeValue): boolean {
  if (STRING_OPS.has(op)) return typeof value === "string";
  if (NUMBER_OPS.has(op)) return typeof value === "number";
  if (SEMVER_OPS.has(op)) return typeof value === "string" && parseSemver(value) !== null;
  return true;
}

function matchesKind(kind: FlagKind, value: JsonValue): boolean {
  switch (kind) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "json":
      return true;
  }
}
