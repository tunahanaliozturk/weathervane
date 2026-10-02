export type FlagKind = "boolean" | "string" | "number" | "json";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AttributeValue = string | number | boolean;

/** The subject a flag is evaluated for. `key` identifies it and is the default rollout attribute. */
export interface Context {
  readonly key: string;
  readonly [attribute: string]: AttributeValue;
}

export type ClauseOp =
  | "in"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "semverEq"
  | "semverLt"
  | "semverGt";

export interface Clause {
  readonly attribute: string;
  readonly op: ClauseOp;
  readonly values: readonly AttributeValue[];
  readonly negate: boolean;
}

/** Weights are hundred-thousandths, one per variation, summing to 100000. */
export interface Rollout {
  readonly weights: readonly number[];
  readonly bucketBy: string;
}

export type Serve = { readonly variation: number } | { readonly rollout: Rollout };

export interface Rule {
  readonly id: string;
  readonly clauses: readonly Clause[];
  readonly serve: Serve;
}

export interface FlagConfig {
  readonly enabled: boolean;
  readonly offVariation: number;
  readonly rules: readonly Rule[];
  readonly fallthrough: Serve;
}

/** Everything needed to evaluate one flag in one environment. */
export interface FlagDefinition {
  readonly key: string;
  readonly kind: FlagKind;
  readonly variations: readonly JsonValue[];
  readonly salt: string;
  readonly config: FlagConfig;
}

export type EvaluationErrorCode = "missing_bucket_attribute" | "variation_out_of_range";

export type Reason =
  | { readonly kind: "off" }
  | { readonly kind: "rule"; readonly ruleId: string }
  | { readonly kind: "fallthrough" }
  | { readonly kind: "error"; readonly errorCode: EvaluationErrorCode };

export type Evaluation =
  | {
      readonly variation: number;
      readonly value: JsonValue;
      readonly reason: Exclude<Reason, { kind: "error" }>;
    }
  | { readonly variation: null; readonly value: null; readonly reason: Extract<Reason, { kind: "error" }> };
