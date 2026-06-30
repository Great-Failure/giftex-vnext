#!/usr/bin/env bash
###############################################################################
# Zava Gift Exchange — Local SWA App Content Deployment
#
# Deploys the built frontend + API to an Azure Static Web App from your local
# machine, without going through GitHub Actions. Useful for hotfixes,
# validating against a newly-provisioned environment, or smoke-testing the
# infra changes the conventional CI/CD path makes harder to test in isolation.
#
# This script does NOT deploy infrastructure. Run ./deploy.sh first for that,
# or use Git-Ape (recommended).
#
# Usage:
#   ./deploy-app-to-swa.sh [qa|prod] [--skip-build]
#
# Examples:
#   ./deploy-app-to-swa.sh qa
#   ./deploy-app-to-swa.sh prod --skip-build
#
# Prerequisites:
#   - az CLI logged in (az login)
#   - The target resource group + Static Web App already deployed
#   - npm + Node 20+
#
# Why this script exists (deployment-pattern notes):
#   1. SWA Functions have a hard package-size limit. Deploying api/ directly
#      ships ~1.5 GB of devDependencies (jest, azure-functions-core-tools,
#      @types/*) which the platform-side deploy rejects with the unhelpful
#      "Failed to deploy the Azure Functions" message. We stage a clean
#      production-only API package in a temp directory first.
#   2. The compiled API includes test files under dist/__tests__/. Those have
#      no business in production — we strip them.
#   3. The deployment token is fetched at runtime, used once, then deleted
#      from disk. Never logged or printed.
#
# The GitHub Action azure/static-web-apps-deploy@v1 handles (1) and (2)
# automatically via Oryx. This script reproduces the same shape locally.
###############################################################################

set -euo pipefail

# ---------------------------------------------------------------------------
# Config + arg parsing
# ---------------------------------------------------------------------------

PROJECT_NAME="zavaexchangegift"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

ENV="${1:-}"
SKIP_BUILD=false
for arg in "${@:2}"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *) echo -e "${RED}Unknown flag: $arg${NC}" >&2; exit 1 ;;
  esac
done

case "$ENV" in
  qa|prod) ;;
  *)
    echo -e "${RED}Usage: $0 [qa|prod] [--skip-build]${NC}" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Resolve resource group + SWA
# ---------------------------------------------------------------------------

case "$ENV" in
  qa)   RG="${PROJECT_NAME}-qa" ;;
  prod) RG="${PROJECT_NAME}" ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo -e "${CYAN}=== Deploying app content to $ENV ===${NC}"
echo "  Repo root:      $REPO_ROOT"
echo "  Resource group: $RG"

# Verify az login + RG exists
if ! az account show --query name -o tsv >/dev/null 2>&1; then
  echo -e "${RED}Not logged in. Run 'az login' first.${NC}" >&2
  exit 1
fi

if ! az group show --name "$RG" --query name -o tsv >/dev/null 2>&1; then
  echo -e "${RED}Resource group $RG does not exist. Deploy infrastructure first.${NC}" >&2
  exit 1
fi

SWA_NAME=$(az resource list --resource-group "$RG" \
  --resource-type Microsoft.Web/staticSites \
  --query "[0].name" -o tsv)

if [ -z "$SWA_NAME" ] || [ "$SWA_NAME" = "null" ]; then
  echo -e "${RED}No Static Web App found in resource group $RG.${NC}" >&2
  exit 1
fi

SWA_HOSTNAME=$(az staticwebapp show --name "$SWA_NAME" --resource-group "$RG" \
  --query defaultHostname -o tsv)
echo "  Static Web App: $SWA_NAME"
echo "  Hostname:       https://$SWA_HOSTNAME"
echo ""

# ---------------------------------------------------------------------------
# Build (unless --skip-build)
# ---------------------------------------------------------------------------

if [ "$SKIP_BUILD" = false ]; then
  echo -e "${CYAN}=== Building frontend ===${NC}"
  npm run build

  echo ""
  echo -e "${CYAN}=== Building API ===${NC}"
  (cd api && npm run build)
fi

if [ ! -d "dist" ] || [ ! -d "api/dist" ]; then
  echo -e "${RED}Build outputs missing. Run without --skip-build, or build manually.${NC}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Stage clean production-only API package
# ---------------------------------------------------------------------------

API_STAGE="$(mktemp -d)/swa-api-deploy"
mkdir -p "$API_STAGE"
echo ""
echo -e "${CYAN}=== Staging clean prod-only API package: $API_STAGE ===${NC}"

cp api/host.json api/package.json api/package-lock.json "$API_STAGE/"
cp -r api/dist "$API_STAGE/dist"
rm -rf "$API_STAGE/dist/__tests__"
find "$API_STAGE/dist" -name "*.js.map" -delete

(cd "$API_STAGE" && npm install --omit=dev --no-audit --no-fund --no-progress --silent)

API_SIZE=$(du -sh "$API_STAGE" | cut -f1)
echo -e "  ${GREEN}✓${NC} API package size: $API_SIZE"

# ---------------------------------------------------------------------------
# Fetch deployment token (file with mode 600, deleted on exit)
# ---------------------------------------------------------------------------

TOKEN_FILE="$(mktemp -t swa-token.XXXXXX)"
chmod 600 "$TOKEN_FILE"

cleanup() {
  rm -rf "$API_STAGE"
  rm -f "$TOKEN_FILE"
}
trap cleanup EXIT

az staticwebapp secrets list --name "$SWA_NAME" --resource-group "$RG" \
  --query "properties.apiKey" -o tsv > "$TOKEN_FILE"

if [ ! -s "$TOKEN_FILE" ]; then
  echo -e "${RED}Failed to fetch deployment token.${NC}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Ensure SWA CLI is available (use local install if present)
# ---------------------------------------------------------------------------

if command -v swa >/dev/null 2>&1; then
  SWA_BIN=swa
elif [ -x "./node_modules/.bin/swa" ]; then
  SWA_BIN="./node_modules/.bin/swa"
else
  echo -e "${YELLOW}=== Installing @azure/static-web-apps-cli locally ===${NC}"
  npm install --no-save --no-audit --no-fund --silent @azure/static-web-apps-cli
  SWA_BIN="./node_modules/.bin/swa"
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

echo ""
echo -e "${CYAN}=== Deploying via swa CLI ===${NC}"

SWA_TOKEN=$(cat "$TOKEN_FILE")
"$SWA_BIN" deploy ./dist \
  --api-location "$API_STAGE" \
  --api-language node \
  --api-version 20 \
  --deployment-token "$SWA_TOKEN" \
  --env production

# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

echo ""
echo -e "${CYAN}=== Smoke tests (waiting 10s for Functions warm-up) ===${NC}"
sleep 10

FE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "https://$SWA_HOSTNAME")
API_LIVE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "https://$SWA_HOSTNAME/api/health/live")
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "https://$SWA_HOSTNAME/api/health")

printf "  Frontend (/):           HTTP %s\n" "$FE_STATUS"
printf "  API /api/health/live:   HTTP %s\n" "$API_LIVE"
printf "  API /api/health (full): HTTP %s\n" "$API_HEALTH"

if [ "$FE_STATUS" = "200" ] && [ "$API_LIVE" = "200" ] && [ "$API_HEALTH" = "200" ]; then
  echo ""
  echo -e "${GREEN}✓ Deploy + smoke tests passed${NC}"
  echo "  https://$SWA_HOSTNAME"
  exit 0
else
  echo ""
  echo -e "${YELLOW}⚠ Some smoke tests did not return 200. Check the SWA portal.${NC}"
  exit 2
fi
