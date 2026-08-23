---
title: "Docker & CI/CD"
description: "Docker setup, GitHub Actions CI/CD pipelines, security scanning, and deployment workflows"
weight: 1
---

## Overview

This project uses **8 GitHub Actions workflows** running on a self-hosted runner (`[self-hosted, linux, x64]`) to automate testing, security scanning, and deployment across two environments:

```
main (production)
  └── develop (staging / daily work)
       ├── feature/xxx
       ├── feature/yyy
       └── ...
```

| Category | Workflows | Trigger |
|----------|-----------|---------|
| CI | `ci.yml` | push `main`/`develop`, PR → `main` |
| Security | `trivy.yml`, `docker-security.yml`, `gitleaks.yml`, `codeql.yml` | push + PR + schedule |
| CD (Azure) | `staging.yml`, `production.yml` | push `develop` / `main` |
| CD (GCP) | `gcp-deploy.yml` | push `main`/`develop` |

---

## CI Pipeline — `ci.yml`

Triggered on push to `main`/`develop` and PRs to `main`. Runs three sequential jobs:

```
backend-test ──┐
               ├──► e2e-test
frontend-test ─┘
```

### Job: `backend-test`

| Step | Description |
|------|-------------|
| Setup Python 3.11 | With pip cache |
| Install dependencies | `pip install -e .[dev]` |
| Lint | `ruff check src/ tests/` |
| Test | `pytest tests/ --cov=src --cov-fail-under=75` |
| Upload coverage | Artifact `backend-coverage` (coverage.xml + htmlcov/) |

### Job: `frontend-test`

| Step | Description |
|------|-------------|
| Setup pnpm 11 + Node 24 | With pnpm cache |
| Install | `pnpm install` |
| Typecheck | `pnpm lint` |
| Unit tests | `pnpm test` |

### Job: `e2e-test`

Depends on both `backend-test` and `frontend-test` passing.

| Step | Description |
|------|-------------|
| Seed fixture data | `python scripts/seed_e2e.py` |
| Install Playwright | Chromium only |
| Run E2E tests | `pnpm test:e2e` |
| Upload report | On failure: artifact `playwright-report` (retained 7 days) |

---

## Security Scanning

Four workflows run in parallel on every push and PR to catch vulnerabilities early.

### 1. Trivy Filesystem & IaC Scan — `trivy.yml`

Two independent jobs:

**Filesystem scan** — scans application source code for known CVEs in dependencies:

- Target: entire repo (`scan-ref: .`)
- Excludes: `terraform/`, `node_modules/`, `.venv/`, `.git/`, `docs/`, `presentation/`, `.agents/`, `.ai-log/`, `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.kilo/`, `.kiro/`, `dist/`, `build/`, `.next/`
- Severity: HIGH, CRITICAL
- Fails on any finding (`exit-code: 1`)

**Terraform/IaC scan** — scans infrastructure-as-code for misconfigurations:

- Target: `terraform/` directory only
- Severity: HIGH, CRITICAL
- Fails on any finding

### 2. Docker Image Scan — `docker-security.yml`

Builds Docker images locally and scans them with Trivy:

| Image | Build target | Scan |
|-------|-------------|------|
| `app-backend:{sha}` | `--target backend` | Trivy image scan, HIGH/CRITICAL |
| `app-frontend:{sha}` | `--target frontend` | Trivy image scan, HIGH/CRITICAL |

Uses `.trivyignore` for known unfixable CVEs in base images.

### 3. Secret Detection — `gitleaks.yml`

Scans entire git history (`fetch-depth: 0`) for accidentally committed secrets, API keys, tokens, and credentials. Fails if any secret is found.

### 4. CodeQL SAST — `codeql.yml`

Static Application Security Testing using GitHub's CodeQL engine.

**Languages analyzed** (matrix strategy, parallel jobs):
- `python`
- `javascript-typescript`

**Schedule**: push to `main`/`develop`, PRs, **plus** weekly scan on Monday at 2:30 AM UTC.

**Key configuration**:

```yaml
- name: Analyze
  uses: github/codeql-action/analyze@v3
  with:
    upload: false          # Do NOT upload to GitHub Security tab
```

#### Viewing CodeQL Results (SARIF Artifacts)

Since `upload: false`, results are **not** sent to the GitHub Security tab. Instead, they are saved as downloadable artifacts.

**Steps to view results:**

1. Go to **Actions** tab in the repository
2. Select the most recent **CodeQL** workflow run
3. Scroll down to the **Artifacts** section
4. Download the relevant artifact:
   - `codeql-python` — Python analysis results
   - `codeql-javascript-typescript` — JavaScript/TypeScript analysis results
5. Extract the `.zip` file
6. Open the `.sarif` file inside using one of:
   - **VS Code**: Install the [SARIF Viewer](https://marketplace.visualstudio.com/items?itemName=ms-vscode.sarif-viewer) extension, then open the `.sarif` file
   - **Web**: Go to [SARIF Web Viewer](https://microsoft.github.io/sarif-web-viewer/) and upload the `.sarif` file

Artifacts are retained for **14 days**.

---

## CD Pipeline — Azure

### Staging — `staging.yml`

Triggered on push to `develop`. Deploys to Azure Container Apps (East US).

```
test-and-lint ──► build-and-deploy-staging
```

**Job 1: `test-and-lint`**

Runs backend (ruff + pytest) and frontend (typecheck) verification before any deployment.

**Job 2: `build-and-deploy-staging`**

| Step | Description |
|------|-------------|
| Azure Login | Service Principal via `AZURE_CREDENTIALS` |
| ACR Login | `acrai20krosbagstaging.azurecr.io` |
| Build & Push Backend | Tagged with `{sha}` + `staging-latest` |
| Build & Push Frontend | Tagged with `{sha}` + `staging-latest`, with API proxy build arg |
| Terraform Apply | `terraform/environments/staging.tfvars` |
| Health Check | `curl --retry 6 --retry-delay 10` against `/health` |

**Environment**:
- Frontend: `https://app-ai20krosbag-staging-frontend.eastus.azurecontainerapps.io`
- Backend: `https://app-ai20krosbag-staging-backend.eastus.azurecontainerapps.io`

### Production — `production.yml`

Triggered on push to `main`. Same structure as staging, but with stricter controls:

| Difference | Staging | Production |
|-----------|---------|------------|
| Concurrency cancel | `true` | `false` (never cancel mid-deploy) |
| ACR | `acrai20krosbagstaging` | `acrai20krosbagprod` |
| Image tags | `staging-latest` | `latest` |
| Terraform vars | `staging.tfvars` | `production.tfvars` |

**Environment**:
- Frontend: `https://app-ai20krosbag-production-frontend.eastus.azurecontainerapps.io`
- Backend: `https://app-ai20krosbag-production-backend.eastus.azurecontainerapps.io`

---

## CD Pipeline — GCP — `gcp-deploy.yml`

Triggered on push to `main`/`develop` and manual dispatch. Deploys to Google Compute Engine VMs.

```
verification ──► deploy-gcp (matrix: staging | production)
```

**Job 1: `verification`** — same backend + frontend checks as Azure.

**Job 2: `deploy-gcp`** — matrix strategy per environment:

| Environment | Branch | VM | Machine Type |
|------------|--------|-----|-------------|
| staging | develop | `ai20k-p077-staging` | e2-small |
| production | main | `ai20k-p077-production` | e2-medium |

| Step | Description |
|------|-------------|
| GCP Auth | Workload Identity Federation (no service account key) |
| Bootstrap | Create GCS tfstate bucket + enable APIs (idempotent) |
| Build & Push | Push to Artifact Registry (`asia-southeast1-docker.pkg.dev`) |
| Terraform | `terraform/gcp/environments/{env}.tfvars` |
| Deploy to VM | SCP files → SSH → `deploy.sh` |
| Health Check | `curl` against VM public IP `/health` |

**Infrastructure**:
- Region: `asia-southeast1` (Singapore)
- State backend: GCS bucket `tfstate-ai20k-p077-gcp`

---

## Trigger Matrix

| Workflow | push main | push develop | PR (→ main) | Schedule |
|----------|:---------:|:------------:|:-----------:|:--------:|
| `ci.yml` | ✅ | ✅ | ✅ | — |
| `trivy.yml` | ✅ | ✅ | ✅ | — |
| `docker-security.yml` | ✅ | ✅ | ✅ | — |
| `gitleaks.yml` | ✅ | ✅ | ✅ | — |
| `codeql.yml` | ✅ | ✅ | ✅ | Mon 2:30 UTC |
| `staging.yml` | — | ✅ | — | — |
| `production.yml` | ✅ | — | — | — |
| `gcp-deploy.yml` | ✅ | ✅ | — | — |

---

## Required Secrets

### Azure

| Secret | Used by | Purpose |
|--------|---------|---------|
| `AZURE_CREDENTIALS` | `staging.yml`, `production.yml` | Service Principal JSON for `azure/login` |
| `REGISTRY_USERNAME` | `staging.yml`, `production.yml` | ACR login username |
| `REGISTRY_PASSWORD` | `staging.yml`, `production.yml` | ACR login password |

### GCP

| Secret | Used by | Purpose |
|--------|---------|---------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `gcp-deploy.yml` | Workload Identity Federation provider |
| `GCP_SERVICE_ACCOUNT` | `gcp-deploy.yml` | GCP service account email |
| `GCP_DOTENV` | `gcp-deploy.yml` | Environment variables for the deployed VM |

### Built-in

| Secret | Used by | Purpose |
|--------|---------|---------|
| `GITHUB_TOKEN` | `gitleaks.yml` | Auto-provided, used for API access |

---

## Docker

### Multi-stage Dockerfile

The project uses multi-stage builds for optimized images:

```dockerfile
# Backend — Python
FROM python:3.11-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

FROM python:3.11-slim
WORKDIR /app
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH
COPY . .
RUN mkdir -p /app/data
EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Common Commands

```bash
# Build
docker build --target backend -t app-backend:latest .
docker build --target frontend -t app-frontend:latest .

# Run
docker compose up -d
docker compose logs -f backend
docker compose down

# Scan locally
trivy fs --severity HIGH,CRITICAL .
trivy image app-backend:latest
```

---

## Git Workflow & Conventions

### Branch Strategy

```
main ──────── production releases
  └── develop ──── daily work, staging deploys
       ├── feature/xxx
       ├── fix/yyy
       └── docs/zzz
```

### Commit Messages (Conventional Commits)

```
feat: add agent graph with analyze + respond nodes
fix: resolve CORS blocking on frontend
docs: update architecture diagram
test: add tests for chat endpoint
refactor: extract analyze node to separate file
chore: update CI workflow triggers
```
