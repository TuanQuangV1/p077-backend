#!/usr/bin/env bash
# Install git pre-push hook for AI log submission (POSIX / Git Bash).
# Run once after cloning: bash scripts/setup_hooks.sh
set -e

HOOK_FILE=".git/hooks/pre-push"

cat > "$HOOK_FILE" <<'EOF'
#!/bin/sh
# Pre-push: sweep recent Antigravity / Gemini prompts, then submit AI logs.

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
EOF

chmod +x "$HOOK_FILE"
chmod +x scripts/_pyrun.sh 2>/dev/null || true
echo "[ai-log] Git pre-push hook installed."

mkdir -p .ai-log
touch .ai-log/.gitkeep

echo "[ai-log] Setup complete. Configure AI_LOG_SERVER in your .env file."
