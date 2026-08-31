#!/usr/bin/env bash
# Install git hooks for AI log submission (POSIX / Git Bash).
# Installs both post-commit (runs on git commit) and pre-push (runs on git push).
# Run once after cloning: bash scripts/setup_hooks.sh
set -e

POST_COMMIT_FILE=".git/hooks/post-commit"
PRE_PUSH_FILE=".git/hooks/pre-push"

HOOK_BODY='#!/bin/sh
# AI Log Hook: sweep recent Antigravity / Gemini prompts, then submit AI logs.

PY=""
if [ -x ".venv/Scripts/python.exe" ]; then
  PY=".venv/Scripts/python.exe"
elif [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
elif [ -x "/c/Program Files/Python313/python.exe" ]; then
  PY="/c/Program Files/Python313/python.exe"
elif [ -x "C:/Program Files/Python313/python.exe" ]; then
  PY="C:/Program Files/Python313/python.exe"
elif command -v py >/dev/null 2>&1; then
  PY="py"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
elif command -v python >/dev/null 2>&1; then
  PY="python"
fi

if [ -n "$PY" ]; then
  "$PY" scripts/log_antigravity.py --auto || true
  "$PY" scripts/submit_log.py || true
fi

exit 0
'

echo "$HOOK_BODY" > "$POST_COMMIT_FILE"
echo "$HOOK_BODY" > "$PRE_PUSH_FILE"

chmod +x "$POST_COMMIT_FILE" 2>/dev/null || true
chmod +x "$PRE_PUSH_FILE" 2>/dev/null || true
chmod +x scripts/_pyrun.sh 2>/dev/null || true

echo "[ai-log] Git post-commit hook installed."
echo "[ai-log] Git pre-push hook installed."

mkdir -p .ai-log
touch .ai-log/.gitkeep

echo "[ai-log] Setup complete. Configure AI_LOG_SERVER in your .env file."
