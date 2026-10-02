# Errors and limits

Every error response has the same shape, whatever raised it:

```json
{
  "code": "version_mismatch",
  "message": "The config changed since you read it; it is now at version 4.",
  "traceId": "0b8f3f9e-5a8e-4f0e-9d0b-3c2d1f6e7a10"
}
```

Branch on `code`. It is part of the contract and does not change between releases. `message` is for
people and may be reworded. `details`, when present, lists every problem found, as `{ field, issue }`.
`traceId` matches the request id in the server log.

## Codes

| Status | Code                                      | What to do                                                                               |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| 400    | `invalid_request`                         | The body, path or query does not match the schema. Fix the fields named in `details`.    |
| 400    | `invalid_json`                            | The body is not JSON, or is empty.                                                       |
| 400    | `invalid_cursor`                          | Pass back a `nextCursor` exactly as you received it.                                     |
| 400    | `invalid_if_match`                        | Send the config version, such as `If-Match: "3"`.                                        |
| 400    | `variations_required`                     | Only boolean flags get default variations; send `variations`.                            |
| 400    | `duplicate_environment`                   | Give each environment in the project a different key.                                    |
| 400    | `environment_required_for_sdk_keys`       | SDK keys need `environment`; admin keys must not have one.                               |
| 400    | `bad_request`                             | Any other malformed request.                                                             |
| 401    | `unauthorized`                            | Send a valid, unrevoked key as `Authorization: Bearer <key>`.                            |
| 403    | `forbidden`                               | The key is valid but not allowed this action, such as an admin key creating admin keys.  |
| 403    | `sdk_key_not_allowed`                     | SDK keys only call `/sdk` routes.                                                        |
| 403    | `sdk_key_required`                        | The `/sdk` routes take an SDK key.                                                       |
| 404    | `project_not_found`                       | No such project, or the key belongs to another project.                                  |
| 404    | `environment_not_found`, `flag_not_found` | Check the key in the path.                                                               |
| 404    | `route_not_found`                         | Check the method and path.                                                               |
| 409    | `project_exists`, `flag_exists`           | The key is taken. Pick another, or read the existing one.                                |
| 412    | `version_mismatch`                        | Someone changed the config after you read it. Read it again, reapply your change, retry. |
| 413    | `body_too_large`                          | Bodies are capped at 256 KiB.                                                            |
| 415    | `unsupported_media_type`                  | Send `Content-Type: application/json`.                                                   |
| 422    | `invalid_variations`                      | The variations break a rule listed below; `details` names each.                          |
| 422    | `invalid_flag_config`                     | The config breaks a rule listed below; `details` names each.                             |
| 428    | `if_match_required`                       | Read the config, then send its `version` in `If-Match`.                                  |
| 500    | `internal_error`                          | Retry with backoff. Report it with the `traceId` if it persists.                         |

## Rules checked beyond the schema

The `issue` values in `details` for 422 responses:

| Issue                        | Meaning                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `too_few_variations`         | A flag needs at least two variations.                                            |
| `variation_kind_mismatch`    | A variation's type does not match the flag's `kind`.                             |
| `duplicate_variation`        | Two variations are equal.                                                        |
| `variation_out_of_range`     | A variation index points past the last variation.                                |
| `one_weight_per_variation`   | A rollout needs exactly one weight per variation.                                |
| `weights_must_sum_to_100000` | Rollout weights are hundred-thousandths and must add up to 100000.               |
| `weights_not_whole_numbers`  | Weights are non-negative integers.                                               |
| `duplicate_rule_id`          | Rule ids are unique within a config.                                             |
| `rule_without_clauses`       | A rule needs at least one clause; use the fallthrough to serve everyone.         |
| `values_empty`               | A clause needs at least one value.                                               |
| `value_does_not_fit_op`      | String operators take strings, numeric ones numbers, semver ones valid versions. |

## Limits

| What                               | Limit                       |
| ---------------------------------- | --------------------------- |
| Project, environment and flag keys | `^[a-z0-9][a-z0-9-]{0,62}$` |
| Environments per project           | 20                          |
| Variations per flag                | 50                          |
| Rules per config                   | 200                         |
| Clauses per rule                   | 50                          |
| Values per clause                  | 1000                        |
| Clause string value                | 1024 characters             |
| Request body                       | 256 KiB                     |
| Page size                          | 50 by default, 200 at most  |
