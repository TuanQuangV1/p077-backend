# Install git hooks for AI log submission (Windows PowerShell).
# Installs both post-commit (runs on git commit) and pre-push (runs on git push).
# Run once after cloning: powershell -ExecutionPolicy Bypass -File scripts\setup_hooks.ps1

$ErrorActionPreference = 'Stop'

$PostCommitFile = '.git/hooks/post-commit'
$PrePushFile = '.git/hooks/pre-push'

# Git on Windows runs hooks via Git Bash, so the hook body must be bash.
$HookBody = @'
#!/bin/sh
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
'@

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $PostCommitFile), $HookBody.Replace("`r`n", "`n"), $Utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $PrePushFile), $HookBody.Replace("`r`n", "`n"), $Utf8NoBom)
Write-Host "[ai-log] Git post-commit hook installed."
Write-Host "[ai-log] Git pre-push hook installed."

if (-not (Test-Path .ai-log)) { New-Item -ItemType Directory -Path .ai-log | Out-Null }
if (-not (Test-Path .ai-log/.gitkeep)) { New-Item -ItemType File -Path .ai-log/.gitkeep | Out-Null }

Write-Host "[ai-log] Setup complete. Configure AI_LOG_SERVER in your .env file."
