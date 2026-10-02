import type { JsonValue } from "@weathervane/core";
import { Type } from "typebox";

// Request schemas. Bounds exist so that one request cannot make every evaluation slow or every
// ruleset huge; docs/errors.md lists them.

export const Key = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" });

const Name = Type.String({ minLength: 1, maxLength: 100 });

const AttributeValue = Type.Union([Type.String({ maxLength: 1024 }), Type.Number(), Type.Boolean()]);

const VariationIndex = Type.Integer({ minimum: 0, maximum: 49 });

const ClauseOp = Type.Union(
  (
    [
      "in",
      "startsWith",
      "endsWith",
      "contains",
      "lt",
      "lte",
      "gt",
      "gte",
      "semverEq",
      "semverLt",
      "semverGt",
    ] as const
  ).map((op) => Type.Literal(op)),
);

const Clause = Type.Object(
  {
    attribute: Type.String({ minLength: 1, maxLength: 128 }),
    op: ClauseOp,
    values: Type.Array(AttributeValue, { maxItems: 1000 }),
    negate: Type.Boolean(),
  },
  { additionalProperties: false },
);

const Serve = Type.Union([
  Type.Object({ variation: VariationIndex }, { additionalProperties: false }),
  Type.Object(
    {
      rollout: Type.Object(
        {
          weights: Type.Array(Type.Integer({ minimum: 0, maximum: 100_000 }), { minItems: 1, maxItems: 50 }),
          bucketBy: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

const Rule = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    clauses: Type.Array(Clause, { maxItems: 50 }),
    serve: Serve,
  },
  { additionalProperties: false },
);

export const FlagConfigBody = Type.Object(
  {
    enabled: Type.Boolean(),
    offVariation: VariationIndex,
    rules: Type.Array(Rule, { maxItems: 200 }),
    fallthrough: Serve,
  },
  { additionalProperties: false },
);

const Json = Type.Unsafe<JsonValue>({});

export const CreateFlagBody = Type.Object(
  {
    key: Key,
    kind: Type.Union([
      Type.Literal("boolean"),
      Type.Literal("string"),
      Type.Literal("number"),
      Type.Literal("json"),
    ]),
    variations: Type.Optional(Type.Array(Json, { maxItems: 50 })),
    offVariation: Type.Optional(VariationIndex),
    description: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const CreateProjectBody = Type.Object(
  {
    key: Key,
    name: Name,
    environments: Type.Array(Type.Object({ key: Key, name: Name }, { additionalProperties: false }), {
      minItems: 1,
      maxItems: 20,
    }),
  },
  { additionalProperties: false },
);

export const CreateKeyBody = Type.Object(
  {
    kind: Type.Union([Type.Literal("admin"), Type.Literal("sdk")]),
    environment: Type.Optional(Key),
  },
  { additionalProperties: false },
);

export const PageQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,2}$" })),
  },
  { additionalProperties: false },
);

export const ContextBody = Type.Object(
  {
    context: Type.Intersect([
      Type.Object({ key: Type.String({ minLength: 1, maxLength: 1024 }) }),
      Type.Record(Type.String({ maxLength: 128 }), AttributeValue),
    ]),
  },
  { additionalProperties: false },
);
