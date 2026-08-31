#!/usr/bin/env bash
# Deploy script executed on the GCP VM (via gcloud compute ssh).
# Usage: sudo bash /opt/app/deploy.sh <backend_image> <frontend_image>
# Pulls the given Artifact Registry images and restarts the compose stack.
set -euo pipefail

BACKEND_IMAGE="$1"
FRONTEND_IMAGE="$2"

log() { echo "[deploy] $*"; }

cd /opt/app

export BACKEND_IMAGE
export FRONTEND_IMAGE

# Authenticate Docker against Artifact Registry using the VM service account
# token from the metadata server (SA needs roles/artifactregistry.reader).
# Token lives ~1h, so re-login on every deploy. The registry host is derived
# from the backend image URI (first path segment before the first slash).
REGISTRY_HOST="${BACKEND_IMAGE%%/*}"
log "authenticating docker against ${REGISTRY_HOST}"
TOKEN=$(curl -sS -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeInstance/v1/instance/service-accounts/default/token")
printf '%s' "$TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' \
  | docker login -u oauth2 --password-stdin "$REGISTRY_HOST"

echo "[deploy] pulling backend=${BACKEND_IMAGE}"
echo "[deploy] pulling frontend=${FRONTEND_IMAGE}"

docker compose -f docker-compose.gcp.yml pull
docker compose -f docker-compose.gcp.yml up -d --remove-orphans

echo "[deploy] waiting for backend /health..."
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 http://localhost/health >/dev/null 2>&1; then
    echo "[deploy] backend healthy after ${i}x5s"
    exit 0
  fi
  sleep 5
done

# Nginx path failed — distinguish a proxy problem from a backend problem so
# the log dump below points at the right container.
if curl -fsS --max-time 5 http://localhost:8000/health >/dev/null 2>&1; then
  echo "[deploy] backend is healthy on :8000; nginx/proxy is the broken hop."
fi

echo "[deploy] backend NOT healthy after 150s; dumping logs:"
docker compose -f docker-compose.gcp.yml logs --tail 50 || true
exit 1
