#!/usr/bin/env bash
# Deploy script executed on the GCP VM (via gcloud compute ssh).
# Usage: sudo bash /opt/app/deploy.sh <backend_image> <frontend_image>
# Pulls the given Artifact Registry images and restarts the compose stack.
set -euo pipefail

BACKEND_IMAGE="$1"
FRONTEND_IMAGE="$2"

cd /opt/app

export BACKEND_IMAGE
export FRONTEND_IMAGE

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

echo "[deploy] backend NOT healthy after 150s; dumping logs:"
docker compose -f docker-compose.gcp.yml logs --tail 50 || true
exit 1
