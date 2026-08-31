---
title: "Quick Start"
description: "Khởi tạo project trong 5 phút"
weight: 1
---

## Quick Start Guide

### Bước 1: Clone Template

```bash
git clone https://github.com/AI20K-Build-Cohort-2/starter-code-template.git C2-App-XXX
cd C2-App-XXX
```

### Bước 2: Environment Setup

```bash
# Tạo virtual environment
python3 -m venv .venv
source .venv/bin/activate  # macOS/Linux
# Windows PowerShell:
# python -m venv .venv; .\.venv\Scripts\Activate.ps1

# Cài dependencies
pip install -e ".[dev]"

# Tạo .env từ template
cp .env.example .env
# → Mở .env và điền API keys + JWT auth
```

> **Auth (bắt buộc cho prod, dev có bypass):**
> ```env
> JWT_SECRET=dev-insecure-jwt-secret-change-me-32-chars-minimum-length
> AUTH_USERNAME=admin
> AUTH_PASSWORD=test-pass
> # hoặc AUTH_PASSWORD_HASH=$2b$12$...
> JWT_EXPIRE_MINUTES=60
> ```
> * `JWT_SECRET` ≥32 ký tự. Dev/Test có thể để rỗng để bypass open (`APP_ENV != production` → không cần token). **Production thiếu `JWT_SECRET` → `503` fail-closed.**
> * Mọi `/api/v1/*` (trừ `/auth/login`, `/auth/signup`, `/auth/verify`, `/health`) yêu cầu `Authorization: Bearer <JWT>`.
> * `docker compose up` hardcode `APP_ENV=production` (`docker-compose.yml:12`) nên phải có `JWT_SECRET` trong `.env` mới chạy được.

```bash
# Lấy token thủ công (dev):
curl -X POST http://localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"test-pass"}'
# → copy access_token rồi:
curl http://localhost:8000/api/v1/datasets \
  -H "Authorization: Bearer <token>"
```

### Bước 3: Verify Setup

```bash
# Chạy server
uvicorn src.main:app --reload --port 8000

# Mở browser: http://localhost:8000/docs
# → Phải thấy Swagger UI (nếu JWT bật, click Authorize và dán Bearer token từ /auth/login)
```

**Verify auth:**
```bash
curl http://localhost:8000/api/v1/datasets
# Dev không JWT: 200 (bypass) | Prod hoặc dev có JWT: 401 {"detail":"invalid or missing JWT token"}
```

### Bước 4: Git Setup

```bash
# Đổi remote origin sang repo của team
git remote set-url origin https://github.com/AI20K-Build-Cohort-2/C2-App-XXX.git

# Tạo branch develop
git checkout -b develop

# Push lần đầu
git push -u origin develop
```

## Folder Structure

```
C2-App-XXX/
├── src/                    ← Source code chính
│   ├── agents/             ← LangGraph agents
│   │   ├── graph.py        ← Graph definition
│   │   ├── state.py        ← State schema
│   │   ├── nodes/          ← Processing nodes
│   │   └── tools/          ← Agent tools
│   ├── api/                ← FastAPI routes
│   ├── models/             ← Pydantic schemas
│   ├── services/           ← Business logic
│   ├── config.py           ← Settings
│   └── main.py             ← App entry point
├── tests/                  ← Test suite
├── docs/                   ← Documentation
├── eval/                   ← Evaluation results
├── presentation/           ← Demo materials
├── Dockerfile              ← Multi-stage build
├── docker-compose.yml      ← Full stack
└── .github/workflows/      ← CI/CD
```

## Nguyên tắc tổ chức code

1. **Một file một trách nhiệm** — `graph.py` chỉ build graph, `state.py` chỉ định nghĩa state
2. **Nodes vào folder `nodes/`** — Mỗi node là một file riêng
3. **Tools vào folder `tools/`** — Mỗi tool là một file riêng
4. **API routes tách riêng** — Không trộn logic vào main.py
5. **Config centralized** — Tất cả settings trong `config.py`
