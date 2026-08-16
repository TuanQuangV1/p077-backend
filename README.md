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
| Infrastructure | Terraform (Azure Container Apps, Azure Container Registry, Azure Storage File Share) |
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
├── terraform/                   # Infrastructure as Code (AzureRM Provider)
│   ├── main.tf                  # Resource Group, ACR, Azure Storage Share, Azure Container Apps
│   ├── variables.tf             # Biến cấu hình (azure_location, app_name, ports)
│   ├── outputs.tf               # Azure Container App FQDNs, ACR login server
│   ├── providers.tf             # AzureRM Provider configuration
│   └── environments/            # File cấu hình riêng biệt cho Staging & Production
├── env/                         # Mẫu cấu hình môi trường biệt lập
│   ├── staging.env.example      # Variable mẫu cho Staging
│   └── production.env.example   # Variable mẫu cho Production
├── nginx/                       # Reverse proxy SSL/TLS & API routing config
├── .github/workflows/
│   ├── staging.yml              # CI/CD tự động deploy Azure Staging khi merge vào develop
│   ├── production.yml           # CI/CD tự động deploy Azure Production khi merge vào main
│   └── ci.yml                   # CI PR Gatekeeper Tests
├── data/                        # Local storage data & thresholds
├── tests/                       # Pytest test suite
└── Dockerfile                   # Multi-stage Docker build
```

---

## 🚀 Deployment & CI/CD Guide (Microsoft Azure)

### 🌐 1. Kiến Trúc Deployment Azure

Hệ thống được triển khai trên hạ tầng **Microsoft Azure** với 2 môi trường biệt lập (**Staging** và **Production**):

```mermaid
graph TD
    DEV[Developer Code] --> FEATURE[Feature Branch: feature/*]
    FEATURE --> PR_DEV[Pull Request / Merge]
    PR_DEV --> BRANCH_DEV[Branch: develop]
    BRANCH_DEV --> CI_STG[GitHub Actions: staging.yml]
    CI_STG --> AZ_STG[Azure Login & Docker Push to ACR]
    AZ_STG --> TF_STG[Terraform Apply Staging]
    TF_STG --> DEPLOY_STG[Deploy to Azure Container Apps STAGING]
    DEPLOY_STG --> HEALTH_STG[Health Check: https://app-ai20krosbag-staging-backend.eastus.azurecontainerapps.io/health]

    BRANCH_DEV --> PR_MAIN[Pull Request / Merge]
    PR_MAIN --> BRANCH_MAIN[Branch: main]
    BRANCH_MAIN --> CI_PROD[GitHub Actions: production.yml]
    CI_PROD --> AZ_PROD[Azure Login & Docker Push to ACR]
    AZ_PROD --> TF_PROD[Terraform Apply Production]
    TF_PROD --> DEPLOY_PROD[Deploy to Azure Container Apps PRODUCTION]
    DEPLOY_PROD --> HEALTH_PROD[Health Check: https://app-ai20krosbag-production-backend.eastus.azurecontainerapps.io/health]
```

#### Ánh Xạ Dịch Vụ Hạ Tầng:
- **Compute Platform**: **Azure Container Apps (ACA)** — serverless container execution với auto-scaling & ingress HTTP/HTTPS.
- **Container Registry**: **Azure Container Registry (ACR)** — lưu trữ & bảo mật các Docker image Backend & Frontend.
- **Persistent Data Volume**: **Azure Files Share** — mount trực tiếp vào Container App tại `/app/data` bảo toàn dữ liệu SQLite (`runs.db`) và rosbag upload.
- **Logging**: **Azure Log Analytics Workspace** — thu thập log ứng dụng tập trung.

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

### 🧪 3. Quy Trình Deploy Staging (Azure)

Deployment cho Staging diễn ra **hoàn toàn tự động** khi code được merge vào nhánh `develop`.

#### Các bước thực hiện thủ công bằng Terraform:
```bash
# Đăng nhập Azure CLI
az login

cd terraform
# Khởi tạo Terraform Azure Provider
terraform init

# Kiểm tra kế hoạch thay đổi hạ tầng Staging trên Azure
terraform plan -var-file=environments/staging.tfvars

# Apply hạ tầng Staging
terraform apply -var-file=environments/staging.tfvars -auto-approve
```

---

### 🏭 4. Quy Trình Deploy Production (Azure)

Deployment cho Production diễn ra **hoàn toàn tự động** khi code từ `develop` được merge vào nhánh `main`.

#### Các bước thực hiện thủ công bằng Terraform:
```bash
cd terraform
# Khởi tạo & Apply hạ tầng Production trên Azure
terraform init
terraform plan -var-file=environments/production.tfvars
terraform apply -var-file=environments/production.tfvars -auto-approve
```

---

### 🔄 5. Quy Trình Rollback Trên Azure Container Apps

Trong trường hợp có sự cố phiên bản mới:

#### Rollback Instant Revision (Ứng cứu sự cố < 1 phút):
Azure Container Apps tự động lưu vết toàn bộ các Revision trước đó. Để chuyển sang Revision ổn định cũ:
```bash
# Xem danh sách revisions hiện tại
az containerapp revision list --name app-ai20krosbag-production-backend --resource-group rg-ai20krosbag-production -o table

# Switch 100% traffic về revision cũ
az containerapp revision set-mode --name app-ai20krosbag-production-backend --resource-group rg-ai20krosbag-production --mode single
az containerapp revision activate --name app-ai20krosbag-production-backend --resource-group rg-ai20krosbag-production --revision <previous_revision_name>
```

---

### 🔑 6. Danh Mục Biến Môi Trường (Environment Variables)

| Biến Môi Trường | Mô Tả | Mặc Định Staging | Mặc Định Production |
|---|---|---|---|
| `APP_ENV` | Môi trường ứng dụng | `staging` | `production` |
| `APP_PORT` | Port lắng nghe Backend | `8000` | `8000` |
| `CORS_ORIGINS` | Tên miền CORS được phép | `https://staging.yourdomain.com` | `https://yourdomain.com` |
| `API_AUTH_TOKEN` | Bearer Token bảo vệ API | Staging Secret | Production Secret |
| `RUN_DB_PATH` | File đường dẫn SQLite | `data/runs.db` | `data/runs.db` |
| `OPENAI_API_KEY` | Key gọi LLM | Staging Key | Production Key |
| `LOG_LEVEL` | Cấp độ ghi Log | `DEBUG` | `INFO` |

---

### 🔀 7. Quy Trình Thử Nghiệm CI/CD Flow Chi Tiết

1. **Feature Branch Work**:
   ```bash
   git checkout -b feature/terraform-deploy-model
   git add .
   git commit -m "feat: migrate terraform infrastructure to azure container apps"
   git push origin feature/terraform-deploy-model
   ```

2. **Deploy STAGING (Merge vào `develop`)**:
   - Tạo PR từ `feature/terraform-deploy-model` vào `develop`.
   - Workflow `.github/workflows/staging.yml` tự động chạy test, push Docker image lên ACR `acrai20krosbagstaging.azurecr.io`, apply Terraform Azure và verify healthcheck.

3. **Deploy PRODUCTION (Merge vào `main`)**:
   - Tạo PR từ `develop` vào `main`.
   - Workflow `.github/workflows/production.yml` tự động chạy testsuite, push Docker image lên ACR `acrai20krosbagprod.azurecr.io`, apply Terraform Azure và verify healthcheck.

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
```
