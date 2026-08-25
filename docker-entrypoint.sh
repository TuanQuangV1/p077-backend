#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
    chown -R appuser:appuser /app/data
    exec runuser -u appuser -- "$@"
fi

exec "$@"