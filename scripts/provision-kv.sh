#!/usr/bin/env bash
# WebWaka Transport Suite — KV Namespace Provisioning
# Run once per environment to create Cloudflare KV namespaces.
# After running, copy the printed IDs into wrangler.toml.
#
# Usage:
#   chmod +x scripts/provision-kv.sh
#   ./scripts/provision-kv.sh staging
#   ./scripts/provision-kv.sh production
#
# Prerequisites: wrangler installed + authenticated (wrangler login)

set -euo pipefail

ENV="${1:-staging}"

if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
  echo "Usage: $0 <staging|production>"
  exit 1
fi

echo "=== Provisioning KV namespaces for environment: $ENV ==="

# Create SESSIONS_KV
echo ""
echo "Creating SESSIONS_KV ($ENV)..."
wrangler kv:namespace create "SESSIONS_KV" --env "$ENV"

# Create TENANT_CONFIG_KV
echo ""
echo "Creating TENANT_CONFIG_KV ($ENV)..."
wrangler kv:namespace create "TENANT_CONFIG_KV" --env "$ENV"

# Create SEAT_CACHE_KV
echo ""
echo "Creating SEAT_CACHE_KV ($ENV)..."
wrangler kv:namespace create "SEAT_CACHE_KV" --env "$ENV"

# Create IDEMPOTENCY_KV
echo ""
echo "Creating IDEMPOTENCY_KV ($ENV)..."
wrangler kv:namespace create "IDEMPOTENCY_KV" --env "$ENV"

echo ""
echo "=== Done. Copy the 'id' values printed above into wrangler.toml under [env.$ENV]. ==="
echo ""
echo "Example wrangler.toml snippet:"
echo ""
echo "[[env.$ENV.kv_namespaces]]"
echo 'binding = "SESSIONS_KV"'
echo 'id = "<paste id here>"'
echo ""
echo "[[env.$ENV.kv_namespaces]]"
echo 'binding = "TENANT_CONFIG_KV"'
echo 'id = "<paste id here>"'
echo ""
echo "[[env.$ENV.kv_namespaces]]"
echo 'binding = "SEAT_CACHE_KV"'
echo 'id = "<paste id here>"'
echo ""
echo "[[env.$ENV.kv_namespaces]]"
echo 'binding = "IDEMPOTENCY_KV"'
echo 'id = "<paste id here>"'
echo ""
echo "IMPORTANT: Replace all 'placeholder-*' entries in wrangler.toml with real IDs."
echo "The CI pipeline will BLOCK production deploys if placeholder IDs are present."
