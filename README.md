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
| Code quality | Ruff, mypy, black |
| CI/CD | GitHub Actions (backend lint/test/coverage, frontend lint/test, Playwright e2e) |

## 📁 Cấu trúc dự án

```
├── src/
│   ├── api/routes.py            # REST API (datasets, analysis, chat, review, diagnostics)
│   ├── services/
│   │   ├── experiments.py       # Upload/delete/scan datasets từ data/experiments
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
├── data/
│   ├── experiments/             # Dataset thật: <id>/metadata.yaml + *.db3
│   └── diagnostics/             # thresholds.json
├── tests/                       # pytest (API + services)
├── docs/                        # Tài liệu kiến trúc, hướng dẫn, evaluation
└── .github/workflows/ci.yml     # CI/CD
```

## 🚀 Setup & Chạy

### Yêu cầu
- Python 3.11+ (khuyến nghị cài bằng [uv](https://docs.astral.sh/uv/) hoặc venv chuẩn)
- Node.js 20+ và pnpm (bắt buộc — script root `npm run frontend:dev` gọi `pnpm` nội bộ)

### Backend

**Cách 1 — venv + uvicorn (khuyến nghị):**

```powershell
# 1. Cài dependencies lần đầu (tạo .venv)
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"

# 2. Cấu hình .env (xem .env.example)
Copy-Item .env.example .env
#    - LLM_PROVIDER: "vllm" (mặc định kèm VLLM_BASE_URL/VLLM_API_KEY) hoặc "openai"
#    - OPENAI_API_KEY: dùng khi LLM_PROVIDER=openai

# 3. Chạy server
uvicorn src.main:app --reload --port 8000
```

**Cách 2 — uv:**

```bash
uv sync --extra dev
uv run --extra dev --with python-multipart uvicorn src.main:app --port 8000
```

### Frontend

```bash
npm install   # cài dependencies root lần đầu
npm run frontend:dev
```

Mở `http://localhost:3000` — frontend rewrite mọi request `/api/v1/*` về backend tại `127.0.0.1:8000`. Tương đương: `cd frontend && pnpm install && pnpm dev`.

### 🐳 Chạy bằng Docker

Cần có Docker + file `.env` (xem `.env.example`) trước khi chạy:

```bash
# Production: backend :8000 + frontend :3000
docker compose up --build

# Development (hot-reload, mount src/ và frontend/)
docker compose --profile dev up --build

# Dừng
docker compose down
```

Lưu ý: volume `./data:/app/data` chia sẻ dữ liệu rosbag giữa host và container; healthcheck cho phép frontend chỉ start sau khi backend sẵn sàng.

### Dữ liệu mẫu
Đặt rosbag thật vào `data/experiments/<dataset_id>/` kèm `metadata.yaml`, hoặc upload trực tiếp từ UI. Dataset mẫu: `data/experiments/E1-1/` (rosbag2 2024-03-11, 2 bag).

## 🧪 Testing

```powershell
# Backend (venv): 52 tests, coverage ≥ 75%
.\.venv\Scripts\Activate.ps1
pytest tests -q

# Lint
ruff check src tests

# Backend (uv)
uv run --extra dev --with python-multipart pytest tests -q
uv run --extra dev --with python-multipart ruff check src tests

# Frontend: unit (Vitest) + typecheck + build
npm run frontend:lint
npm run frontend:build

# E2E (cần backend @8000 + frontend @3000 đang chạy)
pnpm test:e2e
```

Chi tiết kết quả kiểm thử và bằng chứng chạy thật trên dữ liệu rosbag: [docs/evaluation.md](docs/evaluation.md).

## 🔌 API chính

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| `GET` | `/api/v1/datasets` | Danh sách dataset |
| `POST` | `/api/v1/datasets/upload` | Upload rosbag (.db3/.mcap/.bag/zip) |
| `DELETE` | `/api/v1/datasets/{id}` | Xoá dataset |
| `POST` | `/api/v1/analysis` | Chạy phân tích thật (`{"rosbag_id": "..."}`) |
| `GET` | `/api/v1/analysis/{run_id}` | Chi tiết run: anomalies + AI results |
| `GET/POST` | `/api/v1/analysis/thresholds` | Đọc/cập nhật ngưỡng phát hiện |
| `POST` | `/api/v1/analysis/diagnose` | Chạy diagnostics trên inline/file input |
| `POST` | `/api/v1/analysis/explain` | LLM giải thích kết quả diagnostics |
| `POST` | `/api/v1/chat` | Chat với LLM (vLLM/OpenAI) |
| `GET` | `/api/v1/dashboard/overview` | Số liệu dashboard + recent runs |
| `POST` | `/api/v1/review/{id}/decision` | Approve/reject kết quả AI |

## ⚠️ Giới hạn hiện tại

- Run lưu **in-memory** — mất khi restart backend (chưa có database)
- AI results cho run là **canned** theo loại anomaly (chưa gọi LLM live cho phân tích)
- Timeline/simulation trên frontend vẫn dùng mock server (`frontend/lib/server/store.ts`)
- Dataset có `metadata.yaml` lồng trong folder con (E2-*) chưa được scan

## 📚 Tài liệu

- [ARCHITECTURE.md](ARCHITECTURE.md) — kiến trúc hệ thống
- [docs/evaluation.md](docs/evaluation.md) — bằng chứng kiểm thử & đánh giá
- [docs/guide/](docs/guide/) — tài liệu kỹ thuật tham khảo
