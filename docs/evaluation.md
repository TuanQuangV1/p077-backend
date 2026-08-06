# Evaluation Evidence — RAV-13 Rosbag Diagnostics Platform

> Ngày: 2026-08-02 · Branch: `feat/rosbag-diagnostics-api` · Môi trường: Windows 11, Python 3.11.9, Node 22

Tài liệu này là bằng chứng kiểm thử và đánh giá cho toàn bộ nền tảng: từ unit test, API test, bảo mật, E2E đến kết quả chạy thật trên dữ liệu rosbag. Mọi con số đều chạy lại được bằng các lệnh ở mục [Cách tái lập](#cách-tái-lập).

---

## 1. Tóm tắt kết quả kiểm thử

| Hạng mục | Công cụ | Kết quả | Chi tiết |
|----------|---------|---------|----------|
| Backend unit + API | pytest | ✅ **52/52 passed** | Coverage **94.34%** (yêu cầu ≥ 75%) |
| Lint backend | Ruff | ✅ 0 lỗi | `ruff check src tests` |
| Frontend unit | Vitest | ✅ **25/25 passed** (3 files) | api mapping, flows, UI |
| Typecheck frontend | TypeScript | ✅ 0 lỗi | `tsc --noEmit` (strict) |
| Build frontend | Next.js | ✅ passed | `next build` |
| E2E | Playwright | ✅ **3/3 specs passed** | Datasets flow với server thật |
| CI/CD | GitHub Actions | ✅ 3 jobs xanh | backend-test, frontend-test, e2e-test |

## 2. Backend — những gì đã được kiểm thử

### 2.1 Dataset (upload / delete / scan) — `tests/test_api/test_routes.py`
- ✅ Upload `.db3` đơn → tạo đúng folder + `metadata.yaml`, trả về `DatasetItem` chuẩn
- ✅ Upload zip rosbag2 → giải nén an toàn, chuẩn hoá tên, không giữ thư mục lồng
- ✅ Upload extension không hỗ trợ → **400**
- ✅ Zip chứa path traversal (`../evil.db3`) → **400 "unsafe"**
- ✅ Delete dataset → xoá folder, xoá lại → **404**; dataset id traversal (`..%2F..`) → **404**
- ✅ Danh sách dataset scan từ `data/` đúng contract (metadata.yaml hoặc suy ra từ `.db3`, bỏ qua folder không có bag)

### 2.2 Phân tích thật — `tests/test_api/test_routes.py` + `tests/test_services/test_diagnostics.py`
- ✅ `parse_rosbag2_db3`: đọc bảng `topics`/`messages` từ sqlite rosbag2, timestamp **ns → s**, sắp xếp theo thời gian
- ✅ `POST /analysis` trên db3 hợp lệ → run `succeeded`, `progress=100`, `stage=done`
- ✅ Phát hiện **frequency_gap** trên dữ liệu có gap 2s: `anomalyCount=1`, `worstSeverity=medium`, `tSec/endSec` đúng cửa sổ, `topics` đúng
- ✅ Mọi detection đều mang `tSec`/`endSec` (cửa sổ thời gian)
- ✅ Db3 hỏng (không phải sqlite) → run `failed` với `stage=parse`, không crash API
- ✅ Dataset không tồn tại → **404**; chi tiết run không tồn tại → **404**
- ✅ `GET /analysis/{run_id}`: anomalies thật + aiResults khớp từng anomaly (`anomalyId` liên kết đúng)

### 2.3 Diagnostics & thresholds
- ✅ `POST /analysis/diagnose`: inline messages, file-backed (JSONL mcap), 404 cho file thiếu
- ✅ Path traversal file: `../../etc/passwd`, đường dẫn tuyệt đối → **400**
- ✅ `GET/POST /analysis/thresholds`: đọc defaults, merge + persist runtime overrides
- ✅ Detection tôn trọng thresholds overrides (`frequency_gap_min_threshold_sec`, `frequency_gap_multiplier`, `silent_node_min_span_sec`)

### 2.4 LLM (thay LangGraph/LangChain bằng httpx thuần)
- ✅ `validate_llm_config`: thiếu `openai_api_key` / `vllm_base_url` / `vllm_api_key`, provider không hỗ trợ → đều raise `ValueError` đúng
- ✅ `chat_completion`: POST đúng endpoint `/v1/chat/completions`, header `Bearer`, payload gồm `model`, `temperature`, `tools` (nền tảng tool-calling thủ công); trả về `message` với `content` + `tool_calls`
- ✅ `POST /chat` chưa cấu hình LLM → **200** với phản hồi hướng dẫn (không crash)
- ✅ `POST /chat` upstream lỗi → **500** kèm detail lỗi
- ✅ `explain_diagnostics`: summary JSON được đóng khung "data only", system prompt chống prompt injection, nội dung độc hại trong data không thể đổi role

### 2.5 Bảo mật
- ✅ Không có secret hardcode — toàn bộ cấu hình qua `.env` (`src/config.py`, pydantic-settings), `.env` không bao giờ commit
- ✅ Path traversal bị chặn ở 3 điểm: đường dẫn file diagnostics, dataset id, zip content
- ✅ Prompt injection: test chèn "Ignore previous instructions...", HTML tags, `tool_call` giả — system prompt bất biến
- ✅ Không dùng `except:` trần trong codebase (3 chỗ `except Exception` đều re-raise hoặc map sang lỗi chuẩn hoá)

## 3. Frontend — những gì đã được kiểm thử

### 3.1 Unit (Vitest, 25 tests)
- ✅ `lib/api.ts`: mapping `/api/rosbags/{id}` → `/api/v1/datasets/{id}` cho delete; `uploadRosbag` → multipart đúng endpoint
- ✅ Integration: toàn bộ luồng upload → list → analysis → delete gọi đúng URL/verb
- ✅ Flows: DatasetRegistry gửi `rosbag_id` khi Analyze, checkbox/select-all, delete có confirm

### 3.2 E2E (Playwright, 3 specs — chạy với backend + frontend thật)
- ✅ Upload rosbag thật → xuất hiện trong danh sách
- ✅ Chọn dataset → Analyze → gọi API phân tích thật
- ✅ Delete dataset → biến mất khỏi UI

## 4. Bằng chứng chạy thật trên dữ liệu rosbag

Chạy `POST /api/v1/analysis` với dataset thật **E1-1** (rosbag2 2024-03-11, 2 bag `.db3`, ~7.120 messages):

```text
POST /api/v1/analysis {"rosbag_id": "E1-1"}
→ 202 Accepted
  run.status       = succeeded
  run.stage        = done
  run.progress     = 100
  run.anomalyCount = 6
  run.worstSeverity = medium
  run.totalLatencyMs = 268
```

**6 anomaly được phát hiện thật từ dữ liệu:**

| # | kind | topic | tSec → endSec | severity | confidence |
|---|------|-------|---------------|----------|------------|
| 1 | frequency_gap | `/mobile_base_controller/cmd_vel` | 1710159301.98 → 1710159303.67 | medium | 0.81 |
| 2 | frequency_gap | `/sonar_base` | 1710159310.97 → 1710159311.93 | medium | 0.81 |
| 3 | frequency_gap | `/tf` | 1710159323.54 → 1710159323.89 | medium | 0.81 |
| 4 | frequency_gap | `/scan` | 1710159301.50 → 1710159328.63 | medium | 0.81 |
| 5 | frequency_gap | `/mobile_base_controller/odom` | 1710159300.11 → 1710159306.87 | medium | 0.81 |
| 6 | silent_node | `/unknown` | 1710159259.64 → 1710159335.22 | low | 0.72 |

Các cửa sổ phát hiện khớp với dữ liệu timestamp đọc trực tiếp từ bảng `messages` của bag (ví dụ gap 1.69s trên `/mobile_base_controller/cmd_vel`, span hoạt động 75.6s của node im lặng) — xác nhận rule engine đọc đúng dữ liệu thật trong file, không phải mô phỏng. Toàn bộ phát hiện đều có `tSec`/`endSec` cho phép khoanh vùng chính xác trên timeline.

Ngưỡng áp dụng (mặc định, có thể cấu hình qua API):

```json
{
  "frequency_gap_min_threshold_sec": 0.08,
  "frequency_gap_multiplier": 1.5,
  "silent_node_min_span_sec": 0.3
}
```

**Chi phí thời gian:** parse + detect toàn bộ bag E1-1 (~7k messages) mất **268ms** — đủ nhanh cho phân tích theo yêu cầu.

## 5. Coverage theo module (pytest-cov)

| Module | Coverage |
|--------|----------|
| `src/api/routes.py` | 98% |
| `src/config.py` | 100% |
| `src/main.py` | 100% |
| `src/models/schemas.py` | 100% |
| `src/services/diagnostics.py` | 95% |
| `src/services/diagnostics_config.py` | 97% |
| `src/services/experiments.py` | 89% |
| `src/services/llm.py` | 74% |
| **TOTAL** | **94.34%** |

## 6. Cách tái lập

```bash
# Backend tests + coverage
uv run --extra dev --with python-multipart pytest tests -q

# Lint
uv run --extra dev --with python-multipart ruff check src tests

# Frontend unit
cd frontend && pnpm test

# Frontend typecheck + build
cd frontend && pnpm lint && pnpm build

# E2E (start backend @8000 và frontend @3000 trước)
cd frontend && pnpm test:e2e

# Chạy thử phân tích thật (server đang chạy)
curl -X POST http://localhost:8000/api/v1/analysis -H "Content-Type: application/json" -d '{"rosbag_id":"E1-1"}'
```

## 7. Bằng chứng CI/CD

`.github/workflows/ci.yml` — tự động chạy khi push `main`/`develop` và mọi PR vào `main`:

1. **backend-test** (ubuntu-latest, Python 3.11): `pip install -e .[dev]` → `ruff check` → `pytest --cov-fail-under=75` → upload `coverage.xml` + `htmlcov/`
2. **frontend-test** (Node 22 + pnpm): `pnpm install` → `pnpm lint` (tsc) → `pnpm test` (vitest)
3. **e2e-test** (chạy sau khi 2 job trên xanh): cài Playwright chromium → `pnpm test:e2e` → upload `playwright-report/` nếu fail

## 8. Giới hạn đã biết

- Run lưu **in-memory**, mất khi restart backend (chưa có database) — bước tiếp theo
- AI results cho run là **canned** theo loại anomaly (chưa gọi LLM live cho phân tích) — `/chat` và `/analysis/explain` đã gọi LLM thật
- Timeline/simulation frontend vẫn dùng mock (`frontend/lib/server/store.ts`)
- Dataset E2-* (metadata lồng trong folder con) chưa được scan — có thể mở rộng `_bag_files`/`list_experiments`

## 9. Kết luận

Nền tảng đạt **94.34% coverage** với 52 pytest + 25 vitest + 3 e2e specs, có CI 3 jobs, phòng thủ path traversal/zip-slip/prompt injection, và **đã chứng minh phân tích đúng dữ liệu rosbag thật** (6/6 anomaly của bag E1-1 phù hợp đặc tả dữ liệu). Các hạn chế còn lại đều thuộc roadmap (persistence, live AI inference cho run) chứ không phải lỗi chức năng.
