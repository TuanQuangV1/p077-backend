#!/usr/bin/env bash
# Startup script for AI20K GCP Compute Engine instance.
# Mounts the persistent data disk at /opt/app, then installs Docker from the
# official Docker apt repository — Debian 12 stock repos ship docker.io but
# NOT docker-compose-plugin (Compose V2), which the compose stack requires.
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

log "preparing /opt/app mount (before docker install so storage issues are independent)..."
mkdir -p /opt/app/data /opt/app/certs

if [ -e "$${DATA_DEVICE}" ]; then
  FS_TYPE=""
  if ! FS_TYPE=$(blkid -o value -s TYPE "$${DATA_DEVICE}" 2>/dev/null); then
    rc=$?
    if [ "$rc" -eq 2 ]; then
      log "formatting empty data disk..."
      mkfs.ext4 -F "$${DATA_DEVICE}"
      FS_TYPE="ext4"
    else
      log "blkid failed (rc=$rc); skipping format to avoid data loss"
      FS_TYPE="unknown"
    fi
  elif [ -z "$${FS_TYPE}" ]; then
    log "blkid returned empty; formatting empty data disk..."
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
else
  log "data disk not found after 60s; continuing without persistent mount"
fi

chown 1000:1000 /opt/app/data 2>/dev/null || true

log "installing docker from download.docker.com (Debian stock repos have no docker-compose-plugin)..."
export DEBIAN_FRONTEND
apt_retry() {
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    log "attempt $attempt of '$*' failed; retrying in 10s..."
    sleep 10
  done
  return 1
}

apt_retry apt-get update -y
apt_retry apt-get install -y curl ca-certificates gnupg

install -m 0755 -d /etc/apt/keyrings
# Codename comes from the OS itself so a future Debian upgrade (trixie...)
# does not silently point the repo at bookworm.
. /etc/os-release
curl_retry() {
  for attempt in 1 2 3; do
    if curl -fsSL --retry 3 --retry-delay 5 "$1" -o "$2"; then return 0; fi
    log "attempt $attempt of downloading $1 failed; retrying in 10s..."
    sleep 10
  done
  return 1
}
curl_retry https://download.docker.com/linux/debian/gpg /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt_retry apt-get update -y
apt_retry apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

log "docker versions:"
docker --version
docker compose version
log "startup complete"
