# 🤖 RAV-13 — Rosbag Diagnostics Platform

Nền tảng phân tích và chẩn đoán sự cố cho robot thông qua dữ liệu rosbag: tải lên dataset, chạy phát hiện anomaly thật trên file `*.db3` (rosbag2 SQLite), xem kết quả trên web console và trao đổi với LLM.

## 🎯 Problem Statement

Robot ghi lại dữ liệu cảm biến dưới dạng rosbag, nhưng việc tìm ra **tại sao robot gặp trục trặc** (topic chết, node im lặng, publish bị gián đoạn) vẫn là việc thủ công: phải mở công cụ nặng, kéo timeline, đo tần suất từng topic. RAV-13 tự động hoá quy trình đó:

- Phân tích **thật** dữ liệu trong bag (không dùng dữ liệu giả) ngay khi bấm **Analyze**
- Phát hiện các dạng anomaly theo thời gian: khoảng cách publish bất thường, node ngừng hoạt động
- AI hỗ trợ giải thích root cause và gợi ý cách khắc phục
- Giao diện web: quản lý dataset, xem kết quả, review đề xuất của AI

## ✨ Features

**Backend (FastAPI)**
- Upload dataset: file đơn `.db3` / `.mcap` / `.bag` hoặc zip rosbag2 (giải nén an toàn, chống zip-slip); xoá dataset
- Phân tích thật: đọc trực tiếp sqlite rosbag2 (`topics`/`messages`, timestamp ns → s) → `detect_anomalies` → run với `anomalyCount`, `worstSeverity`, cửa sổ `tSec`/`endSec`
- Quy tắc phát hiện: `frequency_gap` (gap publish), `silent_node` (node im lặng); ngưỡng cấu hình được qua API và persist tại `data/diagnostics/thresholds.json`
- API diagnostics: `POST /analysis/diagnose` (inline hoặc file), `POST /analysis/explain` (LLM, chống prompt injection)
- Chat: gọi endpoint OpenAI-compatible (vLLM / OpenAI) qua `httpx` thuần, có tham số `tools` làm nền tảng cho tool-calling thủ công — **không dùng LangGraph/LangChain**
- Tài liệu API tự động: `http://localhost:8000/docs`

**Frontend (Next.js/React)**
- RAV Console: registry dataset (upload/delete, chọn nhiều, "Analyze selected")
- Run detail: danh sách anomaly, timeline, log stream, kết quả AI + review
- Dashboard overview: tổng quan metrics, top issues, severity, xu hướng, recent runs

## 🏗️ Tech Stack

| Layer | Công nghệ |
|-------|-----------|
| Backend | Python 3.11+, FastAPI, Pydantic v2, uvicorn, httpx, numpy |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, shadcn/ui, Tailwind CSS v4, Recharts, SWR |
| Testing | pytest + pytest-asyncio + pytest-cov, Vitest, Playwright |
| Infrastructure | Terraform (IaC AWS ECR/ECS Fargate/ALB), Docker Multi-stage, Nginx |
| CI/CD | GitHub Actions (`staging.yml`, `production.yml`, `ci.yml`) |

## 📁 Cấu trúc dự án

```
├── src/
│   ├── api/routes.py            # REST API (datasets, analysis, chat, review, diagnostics)
│   ├── services/
│   │   ├── experiments.py       # Upload/delete/scan datasets từ data/
│   │   ├── diagnostics.py       # parse_rosbag2_db3, parse_mcap_file, detect_anomalies
│   │   ├── diagnostics_config.py# Ngưỡng phát hiện (defaults + persist)
│   │   └── llm.py               # chat_completion qua httpx (tool-calling thủ công)
│   ├── models/schemas.py        # Pydantic models
│   ├── config.py                # Settings từ .env (pydantic-settings)
│   └── main.py                  # FastAPI app
├── frontend/
│   ├── app/                     # Next.js App Router (console, runs, dashboard...)
│   ├── components/              # RAV Console, analysis UI, shadcn/ui
│   └── lib/                     # api client, types, mock store
├── terraform/                   # Infrastructure as Code (AWS ECR, ECS Fargate, ALB)
│   ├── main.tf                  # Định nghĩa VPC, Load Balancer, ECS Service
│   ├── variables.tf             # Biến cấu hình (region, app_name, ports)
│   ├── outputs.tf               # Load Balancer DNS, ECR URLs
│   ├── providers.tf             # AWS Provider & State Lock
│   └── environments/            # File cấu hình riêng biệt cho Staging & Production
├── env/                         # Mẫu cấu hình môi trường biệt lập
│   ├── staging.env.example      # Variable mẫu cho Staging
│   └── production.env.example   # Variable mẫu cho Production
├── nginx/                       # Reverse proxy SSL/TLS & API routing config
├── .github/workflows/
│   ├── staging.yml              # CI/CD tự động deploy Staging khi merge vào develop
│   ├── production.yml           # CI/CD tự động deploy Production khi merge vào main
│   └── ci.yml                   # CI PR Gatekeeper Tests
├── data/                        # Local storage data & thresholds
├── tests/                       # Pytest test suite
└── Dockerfile                   # Multi-stage Docker build
```

---

## 🚀 Deployment & CI/CD Guide

### 🌐 1. Kiến Trúc Deployment

Hệ thống được thiết kế với 2 môi trường biệt lập (**Staging** và **Production**) đảm bảo không có rủi ro khi deploy tính năng mới:

```mermaid
graph TD
    DEV[Developer Code] --> FEATURE[Feature Branch: feature/*]
    FEATURE --> PR_DEV[Pull Request / Merge]
    PR_DEV --> BRANCH_DEV[Branch: develop]
    BRANCH_DEV --> CI_STG[GitHub Actions: staging.yml]
    CI_STG --> TEST_STG[Run Tests & Build Docker]
    TEST_STG --> TF_STG[Terraform Apply Staging]
    TF_STG --> DEPLOY_STG[Deploy to STAGING]
    DEPLOY_STG --> HEALTH_STG[Health Check: https://staging-api.yourdomain.com/health]

    BRANCH_DEV --> PR_MAIN[Pull Request / Merge]
    PR_MAIN --> BRANCH_MAIN[Branch: main]
    BRANCH_MAIN --> CI_PROD[GitHub Actions: production.yml]
    CI_PROD --> TEST_PROD[Run Full Tests & E2E]
    TEST_PROD --> TF_PROD[Terraform Apply Production]
    TF_PROD --> DEPLOY_PROD[Deploy to PRODUCTION]
    DEPLOY_PROD --> HEALTH_PROD[Health Check: https://api.yourdomain.com/health]
```

#### Endpoints & Domains:
- **Staging Environment**:
  - Web UI: `https://staging.yourdomain.com`
  - Backend API: `https://staging-api.yourdomain.com/api/v1`
  - Health Check: `https://staging-api.yourdomain.com/health`
- **Production Environment**:
  - Web UI: `https://yourdomain.com`
  - Backend API: `https://api.yourdomain.com/api/v1`
  - Health Check: `https://api.yourdomain.com/health`

---

### 💻 2. Cách Chạy Local

#### Option A: Uvicorn + Node (Khuyến nghị cho Dev)
```powershell
# 1. Backend:
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
Copy-Item .env.example .env
uvicorn src.main:app --reload --port 8000

# 2. Frontend:
cd frontend
pnpm install
pnpm dev
```

#### Option B: Docker Compose (Local & Production Simulation)
```bash
# Development (Hot reload):
docker compose --profile dev up --build

# Production Simulation Local:
docker compose -f docker-compose.prod.yml up --build
```

---

### 🧪 3. Quy Trình Deploy Staging

Deployment cho Staging diễn ra **hoàn toàn tự động** khi code được merge vào nhánh `develop`.

#### Các bước thực hiện thủ công bằng Terraform (nếu cần):
```bash
cd terraform
# 1. Khởi tạo Terraform
terraform init

# 2. Kiểm tra kế hoạch thay đổi hạ tầng Staging
terraform plan -var-file=environments/staging.tfvars

# 3. Apply hạ tầng Staging
terraform apply -var-file=environments/staging.tfvars -auto-approve
```

---

### 🏭 4. Quy Trình Deploy Production

Deployment cho Production diễn ra **hoàn toàn tự động** khi code từ `develop` được merge vào nhánh `main`.

#### Các bước thực hiện thủ công bằng Terraform:
```bash
cd terraform
# 1. Khởi tạo Terraform
terraform init

# 2. Kiểm tra kế hoạch thay đổi hạ tầng Production
terraform plan -var-file=environments/production.tfvars

# 3. Apply hạ tầng Production
terraform apply -var-file=environments/production.tfvars -auto-approve
```

---

### 🔄 5. Quy Trình Rollback (Khôi Phục Phân Cấp)

Trong trường hợp có sự cố phiên bản mới:

#### A. Rollback Docker Image Tag (Ứng cứu sự cố tức thì < 2 phút):
1. Mở GitHub Actions hoặc AWS ECS Console.
2. Cập nhật Task Definition về tag commit SHA trước đó (ví dụ: `ai20k-rosbag-production-backend:<previous_sha>`).
3. Chạy lệnh cập nhật ECS Service:
   ```bash
   aws ecs update-service --cluster ai20k-rosbag-production-cluster --service ai20k-rosbag-production-backend-service --force-new-deployment
   ```

#### B. Rollback Hạ Tầng Terraform:
1. Revert commit thay đổi cấu hình trên Git.
2. Chạy lệnh:
   ```bash
   cd terraform
   terraform apply -var-file=environments/production.tfvars -auto-approve
   ```

---

### 🔑 6. Danh Mục Biến Môi Trường (Environment Variables)

| Biến Môi Trường | Mô Tả | Mặc Định Staging | Mặc Định Production |
|---|---|---|---|
| `APP_ENV` | Môi trường ứng dụng | `staging` | `production` |
| `APP_PORT` | Port lắng nghe Backend | `8000` | `8000` |
| `CORS_ORIGINS` | Tên miền CORS được phép | `https://staging.yourdomain.com` | `https://yourdomain.com` |
| `API_AUTH_TOKEN` | Bearer Token bảo vệ API | Staging Secret | Production Secret |
| `RUN_DB_PATH` | File đường dẫn SQLite | `data/staging_runs.db` | `data/prod_runs.db` |
| `OPENAI_API_KEY` | Key gọi LLM | Staging OpenAI Key | Production OpenAI Key |
| `LOG_LEVEL` | Cấp độ ghi Log | `DEBUG` | `INFO` |
| `NEXT_PUBLIC_API_BASE_URL` | Endpoint API cho Frontend | `https://staging-api.yourdomain.com` | `https://api.yourdomain.com` |

---

### 🔀 7. Quy Trình Thử Nghiệm CI/CD Flow Chi Tiết

Để kiểm thử quy trình thực tế từ Feature branch đến Production:

1. **Feature Branch Work**:
   ```bash
   git checkout -b feature/terraform-deploy-model
   # Thực hiện các cập nhật code...
   git add .
   git commit -m "feat: setup terraform and staging/production ci/cd"
   git push origin feature/terraform-deploy-model
   ```

2. **Deploy STAGING (Merge vào `develop`)**:
   - Tạo Pull Request từ `feature/terraform-deploy-model` vào `develop`.
   - Khi merge vào `develop`, `.github/workflows/staging.yml` sẽ tự động kích hoạt:
     - Tự động chạy Unit Test / Lint.
     - Build Docker image Staging.
     - Deploy hạ tầng Staging via Terraform.
     - Thực hiện Health Check tại `https://staging-api.yourdomain.com/health`.

3. **Deploy PRODUCTION (Merge vào `main`)**:
   - Tạo Pull Request từ `develop` vào `main`.
   - Khi merge vào `main`, `.github/workflows/production.yml` sẽ tự động kích hoạt:
     - Chạy toàn bộ Gatekeeper Test Suite (Pytest + Typecheck + E2E).
     - Build Docker image Production.
     - Deploy hạ tầng Production via Terraform.
     - Thực hiện Health Check tại `https://api.yourdomain.com/health`.

---

## 🧪 Testing

```powershell
# Backend (venv):
.\.venv\Scripts\Activate.ps1
pytest tests -q

# Lint
ruff check src tests

# Frontend: unit + typecheck
npm run frontend:lint

# Docker Compose Production Simulation:
docker compose -f docker-compose.prod.yml config
```

Chi tiết kết quả kiểm thử và bằng chứng chạy thật trên dữ liệu rosbag: [docs/evaluation.md](docs/evaluation.md).
