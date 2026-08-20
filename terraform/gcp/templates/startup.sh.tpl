#!/usr/bin/env bash
# Startup script for AI20K GCP Compute Engine instance.
# Installs Docker + compose plugin and mounts the persistent data disk at /opt/app.
set -euo pipefail

log() { echo "[startup] $*"; }

export DEBIAN_FRONTEND=noninteractive
DATA_DEVICE="/dev/disk/by-id/google-${data_disk_name}"

log "waiting for data disk $${DATA_DEVICE}..."
for i in $(seq 1 30); do
  if [ -e "$${DATA_DEVICE}" ]; then
    break
  fi
  sleep 2
done
if [ ! -e "$${DATA_DEVICE}" ]; then
  log "data disk not found after 60s; continuing without persistent mount"
fi

log "installing docker..."
apt-get update -y
apt-get install -y docker.io docker-compose-plugin
systemctl enable --now docker

log "preparing /opt/app mount..."
mkdir -p /opt/app/data /opt/app/certs

if [ -e "$${DATA_DEVICE}" ]; then
  FS_TYPE=$(blkid -o value -s TYPE "$${DATA_DEVICE}" 2>/dev/null || true)
  if [ -z "$${FS_TYPE}" ]; then
    log "formatting empty data disk..."
    mkfs.ext4 -F "$${DATA_DEVICE}"
    FS_TYPE="ext4"
  fi
  if ! grep -q "/opt/app" /etc/fstab; then
    echo "$${DATA_DEVICE} /opt/app ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
  fi
  if ! mountpoint -q /opt/app; then
    mount /opt/app
  fi
  log "data disk mounted:"
  df -h /opt/app
fi

chown 1000:1000 /opt/app/data 2>/dev/null || true

log "docker versions:"
docker --version
docker compose version
log "startup complete"