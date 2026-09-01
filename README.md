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

## 📊 Benchmark

Đo trên 48 bản ghi ROS 2 thật (38 bag tiêm 56 lỗi + 10 bag sạch),
n=3 lượt, `gpt-4.1` — median [min–max]:

| Chỉ số | Giá trị |
|---|---|
| Phát hiện lỗi | **98.2%** (55/56 lỗi tiêm) |
| Báo nhầm trên bag sạch | **0.2 cảnh báo/bag** |
| Root cause đúng | **87.7%** [87.7–89.2] (baseline ban đầu: 44.9%) |
| Mỗi lỗi có chẩn đoán riêng | **82.1%** [82.1–83.9] |
| Trần lý thuyết (cụm chứa manh mối) | **96.9%** |
| Chi phí một lượt chạy đủ 48 bag | ~0.48 USD |

Tái lập: `python scripts/eval_root_cause.py --runs 3` ·
Phương pháp & lịch sử các vòng tối ưu: [docs/benchmark.md](docs/benchmark.md)

## 🏗️ Tech Stack

| Layer | Công nghệ |
|-------|-----------|
| Backend | Python 3.11+, FastAPI, Pydantic v2, uvicorn, httpx, numpy |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, shadcn/ui, Tailwind CSS v4, Recharts, SWR |
| Testing | pytest + pytest-asyncio + pytest-cov, Vitest, Playwright |
| Deploy | Render (backend blueprint `render.yaml`) + Vercel (frontend). Self-host tuỳ chọn: `docker-compose.prod.yml` + nginx + `terraform/gcp/` |
| CI/CD | GitHub Actions (`.github/workflows/ci.yml` — backend + frontend gate trên mọi PR) |

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
│   ├── app/                     # Next.js App Router (console, dashboard, login, error/loading boundaries)
│   │   └── api/                 # route handlers proxying to the FastAPI backend
│   ├── components/              # RAV Console, analysis + health UI, shadcn/ui
│   └── lib/                     # api client (resolveApiUrl), types
├── render.yaml                  # Render backend blueprint
├── nginx/nginx.conf             # Reverse proxy (SSL, security headers, rate-limit) for self-host
├── terraform/gcp/               # Optional GCP infra (main.tf, environments/)
├── .github/workflows/ci.yml     # Backend + frontend CI gate
├── scripts/seed_*.py            # Generate synthetic rosbag datasets into data/
├── data/                        # Local dataset storage + SQLite (git-ignored except runs.db)
├── tests/                       # pytest suite
└── Dockerfile                   # Multi-stage build (backend + frontend targets)
```

---

## 🚀 Chạy Local & Deployment

### 💻 1. Chạy Local

#### Option A: Uvicorn + Node (khuyến nghị cho dev)
```bash
# Backend (uv — nhanh, deterministic)
uv sync --extra dev            # hoặc: python -m venv .venv && pip install -e ".[dev]"
cp .env.example .env           # JWT_SECRET rỗng → dev bỏ qua auth
uv run uvicorn src.main:app --reload --port 8000

# Frontend (chạy trong frontend/)
cd frontend
pnpm install
pnpm dev                       # http://localhost:3000, proxy /api/v1 → :8000
```

Seed dữ liệu mô phỏng để có gì đó phân tích:
```bash
uv run python scripts/seed_10_datasets.py
```

#### Option B: Docker Compose
```bash
docker compose up --build              # dev-mode (APP_ENV=development, không cần secret)
docker compose --profile dev up        # + hot-reload
```

### ✅ 2. Kiểm tra trước khi push

```bash
make check-all        # backend (ruff + mypy + pytest) + frontend (tsc + vitest + build)
```
GitHub Actions (`.github/workflows/ci.yml`) chạy đúng các bước này trên mọi PR.

### 🌐 3. Deployment

| Thành phần | Nền tảng | Cấu hình |
|---|---|---|
| Backend | **Render** | `render.yaml` blueprint — `pip install -r requirements.txt && pip install -e .`, `uvicorn src.main:app`. Đặt `JWT_SECRET`, `AUTH_PASSWORD`, `CORS_ORIGINS`, `OPENAI_API_KEY` trong Render dashboard (`sync: false`) |
| Frontend | **Vercel** | Next.js, `NEXT_PUBLIC_API_URL` / `API_PROXY_TARGET` trỏ về Render backend |
| Self-host (tuỳ chọn) | VPS + nginx | `docker-compose.prod.yml` + `nginx/nginx.conf` (đã có security headers + rate-limit); `terraform/gcp/` cho hạ tầng |

**Bắt buộc khi deploy production:** `JWT_SECRET` ≥ 32 ký tự (thiếu → 503 fail-closed), `CORS_ORIGINS` là allowlist tường minh (`"*"` bị từ chối lúc khởi động).

---

### 🔑 4. Biến môi trường

Xem `.env.example` (khớp 1-1 với `src/config.py`). Các biến quan trọng khi deploy:

| Biến | Mô tả | Dev | Production |
|---|---|---|---|
| `APP_ENV` | `development` \| `staging` \| `production` | `development` | `production` |
| `JWT_SECRET` | HS256 secret ≥ 32 ký tự (`openssl rand -hex 32`) | rỗng → bypass auth | **bắt buộc** (thiếu → 503) |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | Tài khoản login | `admin` / `test-pass` | đổi mật khẩu mạnh |
| `CORS_ORIGINS` | Allowlist origin, phẩy ngăn cách | `http://localhost:3000` | domain thật (`"*"` bị từ chối) |
| `OPENAI_API_KEY` + `MODEL_NAME` | LLM (id model, không phải display name) | tuỳ chọn | cần cho AI thật |
| `RUN_DB_PATH` / `RUN_DB_WAL` | SQLite runs/anomalies/review/auth | `data/runs.db` | `data/runs.db`, `RUN_DB_WAL=1` |
| `MAX_UPLOAD_BYTES` | Giới hạn upload rosbag | `1GiB` | tăng cho bag nhiều GB |

> `API_AUTH_TOKEN` đã bỏ (100% JWT). `POST /api/v1/auth/{login,signup,verify}` public, còn lại cần `Authorization: Bearer <JWT>`. `docker compose up` chạy dev-mode nên không cần secret.

---

### 🔄 5. Rollback

- **Render**: dashboard → service → "Rollback" về deploy trước, hoặc redeploy commit cũ.
- **Vercel**: dashboard → Deployments → "Promote to Production" bản cũ.

---

## 🧪 Testing

```bash
# Tất cả (backend + frontend) — đúng những gì CI chạy
make check-all

# Chỉ backend
uv run pytest                    # 463 test, gate coverage 80% (routes.py ~86%)
uv run ruff check src/ tests/
uv run mypy src/

# Chỉ frontend (từ frontend/)
cd frontend && pnpm lint && pnpm test && pnpm build
```

> `tests/conftest.py` tự set `JWT_SECRET` strict và `client` auto-inject JWT nên
> clone về chạy `pytest` **không cần key**. `unauth_client` dùng để assert
> `401/503`. Chỉ deploy thật mới cần `JWT_SECRET`/`AUTH_*`/`OPENAI_API_KEY`.
>
> `pnpm test` phải chạy trong `frontend/` — chạy ở root sẽ nhặt nhầm file
> Playwright `e2e/*.spec.ts`.
