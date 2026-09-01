# 🔍 Báo cáo Kiểm toán Toàn diện Hệ thống RAV-13

> **Ngày kiểm tra**: 01/09/2026  
> **Nhánh**: `fix/ui-1`  
> **Phương pháp**: 2 lượt rà soát độc lập (6 nhóm kiểm tra chuyên sâu)  
> **Đánh giá bởi**: Senior AI & Robotics Engineer (10 năm kinh nghiệm)

---

## Tổng quan Đánh giá

| Hạng mục | Trạng thái | Mức nghiêm trọng |
|---|---|---|
| Backend API | ⚠️ Có stub/mock | 🟡 Trung bình |
| Frontend UI | ⚠️ Có mock data + memory leaks | 🟡 Trung bình |
| Tích hợp BE ↔ FE | 🔴 Không nhất quán | 🔴 Nghiêm trọng |
| Bảo mật | 🔴 CORS `*`, thiếu headers | 🔴 Nghiêm trọng |
| Infrastructure | ⚠️ Lỗi cấu hình | 🟡 Trung bình |
| Test Coverage | 🔴 67% routes, 7 API chưa test | 🔴 Nghiêm trọng |
| Dữ liệu | ⚠️ 100% synthetic | 🟡 Cần xác nhận |
| Error Handling | ⚠️ Nuốt lỗi | 🟡 Trung bình |
| CI/CD | 🔴 Không có pipeline | 🔴 Nghiêm trọng |

**Tổng cộng: 25 vấn đề** (9 nghiêm trọng, 12 trung bình, 4 thấp)

---

## I. BACKEND — Các vấn đề

### 🔴 1. Fake Signup — In-memory, mất khi restart

- **File**: `src/services/auth.py` (dòng 28)
- Biến `_USERS: dict[str, str] = {}` lưu user **trên RAM**.
- Endpoint `POST /auth/signup` trong `src/api/routes.py` (dòng 389) ghi rõ: *"Fake signup — tạo user in-memory (không DB) và trả JWT."*

> **⚠️ CAUTION**: Khi server restart, toàn bộ user đã đăng ký sẽ **bị mất hoàn toàn**. Auth system không production-ready.

---

### 🟡 2. HILT Loop — Dummy Data

- **File**: `src/services/iterative_debug.py` (dòng 293-300)
- Human-in-the-loop gán cứng `test_pass=False` và `test_comment="awaiting engineer test"`.
- Comment: *"In real usage, this would wait for engineer test input"*.

---

### 🟡 3. Canned AI Fallback — Hardcoded text

- **File**: `src/services/analysis.py` (dòng 366-403)
- `_canned_ai_results` và `_canned_explanation` trả về text phân tích hardcoded khi LLM không khả dụng.
- Cơ chế fallback hợp lý, nhưng UI không đánh dấu rõ ràng kết quả **không phải từ AI thực**.

---

### 🟡 4. Database — Raw Migration, nuốt lỗi

- **File**: `src/services/run_store.py` (dòng 26)
- Schema SQLite định nghĩa bằng text string thô (`_SCHEMA`), không dùng Alembic hay migration tool nào.
- Migration chạy `ALTER TABLE` rồi **nuốt lỗi** bằng `except sqlite3.Error: pass` (dòng 135-147).

> **⚠️ WARNING**: Schema thay đổi có thể **phá hỏng dữ liệu âm thầm** mà không ai biết.

---

### 🟡 5. Error Handling — Lạm dụng `except: pass`

- `src/services/run_store.py`: nuốt lỗi WAL pragma, nuốt lỗi migrate column.
- `src/services/auth.py` (dòng 66-69): `verify_password` bắt `Exception` chung, trả `False` mà không log.

---

### 🟡 6. Blacklist & Rate Limiter — In-memory

- **File**: `src/services/auth.py` (dòng 25) và `src/api/routes.py` (dòng 133)
- JWT blacklist (`_BLACKLIST`) và rate limiter đều là dict/object in-memory.
- Khi restart server hoặc scale nhiều instance: blacklist bị reset, rate limit bị phân mảnh.

---

### 🟡 7. Python Version mâu thuẫn

- `pyproject.toml`: `requires-python = ">=3.11"`
- `ruff`: `target-version = "py311"`
- `mypy`: `python_version = "3.12"` ← **Mâu thuẫn**

---

## II. FRONTEND & UI — Các vấn đề

### 🔴 8. Latency/Jitter Panel — Mock Data 100%

- **File**: `frontend/components/health/latency-jitter-panel.tsx` (dòng 62-95)
- `generateMockData` dùng `Math.sin()` + `Math.random()` vẽ biểu đồ.
- **Không kết nối backend API nào** — biểu đồ hiển thị dữ liệu giả cho người dùng.

> **⚠️ CAUTION**: Panel này hiển thị dữ liệu **GIẢ** mà không có bất kỳ cảnh báo nào trên UI.

---

### 🔴 9. LLM Deep Dive Panel — Fake Analysis

- **File**: `frontend/components/health/llm-deep-dive-panel.tsx` (dòng 19-85)
- `generateFallbackAnalysis` tạo kết quả phân tích giả bằng `if/else` client-side.
- Không gọi endpoint LLM backend thực tế.

---

### 🔴 10. Thiếu Error Boundaries & Loading States

- **Thư mục**: `frontend/app/`
- Không tồn tại file `error.tsx` hay `loading.tsx` nào trong App Router.
- Nếu có lỗi render hoặc data fetch ở route level → **app crash trắng trang** thay vì hiện UI lỗi.

> **ℹ️ IMPORTANT**: Next.js App Router cần `error.tsx` và `loading.tsx` ở mỗi route group để xử lý graceful.

---

### 🟡 11. Memory Leaks — useEffect thiếu cleanup

- **File**: `frontend/components/rav-console.tsx`
- Nhiều `useEffect` gọi API bất đồng bộ nhưng **không có cơ chế cleanup** hoặc cờ `cancelled`:
  - Dòng ~157: Gọi `/api/overview` mà không có cleanup
  - Dòng ~158: `Promise.all` fetch chi tiết run — không huỷ khi unmount
  - Dòng ~202-203: Load LLM runs và thresholds — không có cleanup

---

### 🟡 12. Hardcoded Data trong Components

| File | Dòng | Vấn đề |
|---|---|---|
| `frontend/components/health/topic-health-table.tsx` | 29-46 | `HZ_EXCLUDED_TOPIC_NAMES`, `HZ_EXCLUDED_MESSAGE_TYPES` hardcode |
| `frontend/components/health/data-bandwidth-panel.tsx` | 261 | Anomaly ID hardcode `"PLD-01"` |
| `frontend/components/dashboard/fleet-trend-chart.tsx` | 37 | `CustomTooltip` dùng type `any` |

---

### 🟢 13. Placeholder Assets không sử dụng

- Thư mục `frontend/public/` chứa 5 file placeholder:
  - `placeholder-logo.png`, `placeholder-logo.svg`, `placeholder-user.jpg`, `placeholder.jpg`, `placeholder.svg`

---

## III. TÍCH HỢP BE ↔ FE — Không nhất quán

### 🔴 14. Missing API Endpoints (Frontend gọi → Backend 404)

Frontend gọi các endpoint **không tồn tại** ở backend:

| Frontend gọi | Backend có? | Kết quả |
|---|---|---|
| `GET /api/v1/analysis/{run_id}/logs` | ❌ | HTTP 404 |
| Các endpoint `/timeline` | ❌ | HTTP 404 |
| Các endpoint `/ai` | ❌ | HTTP 404 |
| Các endpoint `/simulation` | ❌ | HTTP 404 |
| `POST /api/reports` | ❌ | HTTP 404 |

> **⚠️ CAUTION**: Nhiều tính năng frontend sẽ **hoàn toàn không hoạt động** khi kết nối backend thực.

---

### 🔴 15. Data Model Mismatches

| Trường | Backend | Frontend | Vấn đề |
|---|---|---|---|
| `runRootCause` | ✅ Có trong `AnalysisDetailResponse` | ❌ Frontend bỏ qua | FE không render |
| `evidence` (Anomaly) | ✅ Có trong `AnomalySummary` | ❌ Thiếu trong type `Anomaly` | Type mismatch |

---

## IV. BẢO MẬT — Các vấn đề

### 🔴 16. CORS `*` trên Production (Render)

- **File**: `render.yaml` (dòng 15)
- `CORS_ORIGINS` được set thành `"*"` cho production deploy trên Render.

> **⚠️ CAUTION**: Bất kỳ domain nào cũng có thể gọi API backend. Đây là lỗi bảo mật **nghiêm trọng**.

---

### 🔴 17. Thiếu Security Headers

**Nginx** (`nginx/nginx.conf`) thiếu:
- `X-Frame-Options` → clickjacking
- `Content-Security-Policy` (CSP) → XSS
- `Strict-Transport-Security` (HSTS) → downgrade attack
- `X-Content-Type-Options` → MIME sniffing

**Frontend** (`frontend/next.config.mjs`) cũng thiếu cấu hình security headers.

---

### 🟡 18. Nginx thiếu Rate Limiting

- Không có `limit_req_zone` trong `nginx/nginx.conf`.
- Backend có rate limiter in-memory, nhưng Nginx layer **không có**, dễ bị DDoS.
- `client_max_body_size 1g` (dòng 14) quá lớn nếu không kèm rate limiting.

---

### 🟡 19. Firewall mở rộng (Terraform)

- **File**: `terraform/gcp/main.tf` (dòng 132)
- HTTP firewall cho phép `source_ranges = ["0.0.0.0/0"]` — mọi IP trên internet.
- SSH đã giới hạn tốt bằng `ssh_source_ranges`.

---

## V. INFRASTRUCTURE & DEPLOYMENT — Các vấn đề

### 🔴 20. Docker Compose gây 503 khi Dev Setup

- `docker-compose.yml` (dòng 12) set `APP_ENV=production`.
- Production cần `JWT_SECRET` → nếu không có → **toàn bộ API trả 503**.
- `.env.example` (dòng 52) để `JWT_SECRET=` (rỗng).
- Dev copy `.env.example` → `.env` → `docker compose up` → **backend chết**.

---

### 🟡 21. Rác cấu hình trong `.env.example`

Biến boilerplate cũ **mâu thuẫn** với `ARCHITECTURE.md`:

| Biến rác | Thực tế hệ thống |
|---|---|
| `DATABASE_URL=postgresql://...` | Dùng SQLite |
| `CHROMA_PERSIST_DIR=./data/chroma` | Không dùng Vector DB |
| `PINECONE_API_KEY=` | Không dùng Pinecone |
| `LANGCHAIN_API_KEY=...` | Không dùng Langchain/LangSmith |

---

### 🟡 22. Dependency Versions không lock chặt

- **Backend**: `requirements.txt` và `pyproject.toml` dùng `>=` → Dependency Drift khi build lại.
- **Frontend**: `package.json` chứa version lạ — `"next": "16.2.12"` (Next.js chưa có v16 chính thức tại thời điểm kiểm tra, cần xác nhận).
- `passlib[bcrypt]>=1.7.4` — thư viện ít bảo trì, có issue với Python 3.11+.

---

### 🟡 23. Hardcoded Paths trong Scripts

- `scripts/_pyrun.sh` (dòng 26): `/c/Users/*/AppData/Local/Programs/Python/Python*/python.exe`
- `scripts/setup_hooks.ps1` (dòng 22) và `scripts/setup_hooks.sh` (dòng 20): `C:/Program Files/Python313/python.exe`
- Nhiều scripts hardcode `http://localhost:8000` thay vì dùng env vars.

---

## VI. TEST COVERAGE — Các vấn đề

### 🔴 24. Coverage thấp, nhiều API chưa test

- **File**: `src/api/routes.py` — chỉ đạt **67% line coverage**.
- **7 API endpoints hoàn toàn chưa có test:**

| Endpoint | Test? |
|---|---|
| `GET /analysis/{run_id}/health` | ❌ |
| `GET /analysis/{run_id}/deep-dive` | ❌ |
| `GET /analysis/{run_id}/export/windows` | ❌ |
| `GET /review/stats` | ❌ |
| `GET /hilt/summary/{run_id}` | ❌ |
| `POST /hilt/iterate` | ❌ |
| `POST /hilt/fix/{run_id}` | ❌ |

- Auth endpoints thiếu test cho **error paths** (JWT expired, invalid token, etc.).
- Upload endpoint chưa test trường hợp file lỗi, sai format.

---

### 🔴 25. Không có CI/CD Pipeline

- Không có `.github/workflows/` hay bất kỳ CI config nào.
- `Makefile` chỉ chạy lint/format/test backend — **thiếu frontend hoàn toàn**.

---

## VII. DỮ LIỆU — 100% Synthetic

### 🟡 26. Rosbag Data tổng hợp

- **Toàn bộ** `.mcap` và `.db3` trong `data/` là dữ liệu synthetic.
- Tạo bởi `scripts/seed_10_datasets.py` và `scripts/seed_e2e.py`.
- Có **inject lỗi cố ý** vào dữ liệu để test anomaly detection.

> **ℹ️ IMPORTANT**: Với PoC/demo thì chấp nhận được. Production cần test với rosbag thực từ robot.

---

## Bảng Tổng hợp — 25 Vấn đề theo Ưu tiên

### 🔴 Ưu tiên CAO — Cần sửa ngay (9 vấn đề)

| # | Vấn đề | Phân loại | File chính |
|---|---|---|---|
| 1 | Fake Signup in-memory | Backend | `auth.py` |
| 8 | Latency/Jitter panel hiển thị dữ liệu GIẢ | Frontend | `latency-jitter-panel.tsx` |
| 9 | LLM Deep Dive panel phân tích GIẢ | Frontend | `llm-deep-dive-panel.tsx` |
| 10 | Thiếu Error Boundaries / Loading States | Frontend | `app/` |
| 14 | Frontend gọi 5+ API không tồn tại (404) | Tích hợp | `api.ts` ↔ `routes.py` |
| 15 | Data model BE ↔ FE không khớp | Tích hợp | `schemas.py` ↔ `types.ts` |
| 16 | CORS `*` trên Production | Bảo mật | `render.yaml` |
| 17 | Thiếu Security Headers (Nginx + Next.js) | Bảo mật | `nginx.conf`, `next.config.mjs` |
| 20 | Docker Compose gây 503 khi dev setup | Deployment | `docker-compose.yml` |

### 🟡 Ưu tiên TRUNG BÌNH (12 vấn đề)

| # | Vấn đề | Phân loại | File chính |
|---|---|---|---|
| 2 | HILT loop dùng dummy data | Backend | `iterative_debug.py` |
| 3 | Canned AI fallback thiếu label trên UI | Backend | `analysis.py` |
| 4 | SQLite migration nuốt lỗi | Backend | `run_store.py` |
| 5 | Lạm dụng `except: pass` | Backend | `run_store.py`, `auth.py` |
| 6 | Blacklist & Rate Limiter in-memory | Backend | `auth.py`, `routes.py` |
| 7 | Python version mâu thuẫn | Backend | `pyproject.toml` |
| 11 | Memory leaks useEffect | Frontend | `rav-console.tsx` |
| 12 | Hardcoded data trong components | Frontend | Nhiều files |
| 18 | Nginx thiếu rate limiting | Bảo mật | `nginx.conf` |
| 21 | Rác cấu hình `.env.example` | Deployment | `.env.example` |
| 22 | Dependencies không lock chặt | Deployment | `requirements.txt`, `package.json` |
| 24 | Test coverage 67%, 7 API chưa test | Testing | `tests/` |

### 🟢 Ưu tiên THẤP (4 vấn đề)

| # | Vấn đề | Phân loại | File chính |
|---|---|---|---|
| 13 | Placeholder assets chưa dọn | Frontend | `frontend/public/` |
| 19 | Firewall `0.0.0.0/0` cho HTTP | Infra | `main.tf` |
| 23 | Hardcoded paths trong scripts | Infra | `scripts/` |
| 25 | Không có CI/CD pipeline | DevOps | `.github/` |

---

## Điểm TÍCH CỰC của hệ thống

Không chỉ liệt kê vấn đề — hệ thống cũng có nhiều điểm làm tốt:

| ✅ Điểm tốt | Chi tiết |
|---|---|
| **JWT Auth đúng chuẩn** | HS256, timing-safe compare, dummy hash chống enumeration, token blacklist |
| **Prompt Injection Guard** | `src/services/leak_guard.py` — 3 lớp bảo vệ (exact, normalized, fuzzy) chống rò rỉ secret/prompt |
| **Rate Limiting** | Login brute-force protection (5 req/min), general API (120 req/min), configurable proxy hops |
| **Path Traversal Protection** | `_resolve_diagnostics_file_path` kiểm tra `..` và resolve path an toàn |
| **LLM Output Cap** | `llm_max_tokens=1024` giới hạn chi phí mỗi completion (LLM10) |
| **Docker Best Practices** | Non-root user, multi-stage build, slim base image |
| **Production fail-closed** | Missing `JWT_SECRET` → 503 thay vì mở cửa hoàn toàn |
| **Structured Logging** | Performance middleware đo request timing, query counts, slow queries |
| **Canned fallback block** | Server-side chặn approve kết quả `canned-fallback` (dòng 1583 routes.py) |
| **UI Component Library** | shadcn/ui + Radix UI — nhất quán, accessible by default |
