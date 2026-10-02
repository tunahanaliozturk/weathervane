#!/usr/bin/env bash
# The README's quick start, as a script CI runs against `docker compose up`. Needs curl and jq.
set -euo pipefail

API=${API:-http://localhost:8080}
ROOT_KEY=local-root-key-change-me-0123456789 # the root key from compose.yaml

post() { curl -sSf -X "$1" "$API$2" -H "authorization: Bearer $3" -H "content-type: application/json" "${@:5}" -d "$4"; }

# 1. A project with one environment.
post POST /api/v1/projects "$ROOT_KEY" \
  '{"key":"demo","name":"Demo","environments":[{"key":"production","name":"Production"}]}' >/dev/null

# 2. An admin key for the project and an SDK key for production. Secrets are shown once.
ADMIN_KEY=$(post POST /api/v1/projects/demo/keys "$ROOT_KEY" '{"kind":"admin"}' | jq -r .token)
SDK_KEY=$(post POST /api/v1/projects/demo/keys "$ADMIN_KEY" '{"kind":"sdk","environment":"production"}' | jq -r .token)

# 3. A boolean flag. New flags start off in every environment.
post POST /api/v1/projects/demo/flags "$ADMIN_KEY" '{"key":"new-checkout","kind":"boolean"}' >/dev/null

# 4. What does alice get? `false`, because the flag is off.
post POST /sdk/v1/evaluate "$SDK_KEY" '{"context":{"key":"alice","plan":"pro"}}' | jq -c '.flags["new-checkout"]'

# 5. Turn it on for pro users, and for 25% of everyone else. If-Match carries the version we read.
post PUT /api/v1/projects/demo/flags/new-checkout/environments/production "$ADMIN_KEY" '{
  "enabled": true,
  "offVariation": 1,
  "rules": [{"id": "pro", "clauses": [{"attribute": "plan", "op": "in", "values": ["pro"], "negate": false}],
             "serve": {"variation": 0}}],
  "fallthrough": {"rollout": {"weights": [25000, 75000], "bucketBy": "key"}}
}' -H 'if-match: "1"' >/dev/null

# 6. Ask again: `true`, by the `pro` rule.
RESULT=$(post POST /sdk/v1/evaluate "$SDK_KEY" '{"context":{"key":"alice","plan":"pro"}}' | jq -c '.flags["new-checkout"]')
echo "$RESULT"
[ "$(jq -r .value <<<"$RESULT")" = "true" ]
