#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || ! $1 =~ ^https?:// ]]; then
  echo "Usage: scripts/smoke.sh <base-url>" >&2
  exit 2
fi
base_url=${1%/}
smoke_dir=$(mktemp -d)
trap 'rm -rf "$smoke_dir"' EXIT

status=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
  --output "$smoke_dir/health" --write-out '%{http_code}' "$base_url/health")
[[ $status == 200 ]] || { echo "health: expected 200, got $status" >&2; exit 1; }
node --input-type=module - "$smoke_dir/health" <<'JS'
import { readFileSync } from "node:fs"
const body = JSON.parse(readFileSync(process.argv[2], "utf8"))
if (body.ok !== true || body.db !== "ok" || !["dev", "prod"].includes(body.stage)) {
  throw new Error("health: expected { ok: true, stage: dev|prod, db: ok }")
}
JS

status=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
  --output "$smoke_dir/docs" --write-out '%{http_code}' "$base_url/api/docs")
[[ $status == 200 ]] || { echo "docs: expected 200, got $status" >&2; exit 1; }
node --input-type=module - "$smoke_dir/docs" <<'JS'
import { readFileSync } from "node:fs"
if (!readFileSync(process.argv[2], "utf8").includes("api-reference")) {
  throw new Error("docs: expected the Scalar API documentation page")
}
JS

status=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
  --output /dev/null --write-out '%{http_code}' "$base_url/api/v1/brands")
[[ $status == 401 ]] || { echo "brands: expected unauthenticated 401, got $status" >&2; exit 1; }
echo "Smoke passed: Hyperdrive health, API docs, unauthenticated 401 ($base_url)"
