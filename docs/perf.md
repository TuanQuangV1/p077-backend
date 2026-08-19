# Đo hiệu năng hệ thống (Performance Measurement)

Hướng dẫn đo thời gian xử lý của RAV-13 (FastAPI + SQLite + numpy + LLM) để xác
định điểm nghẽn. Toàn bộ code đo đã nằm sẵn trong repo — không cần sửa code gì
khi chạy benchmark.

## 1. Bật instrumentation (mặc định bật)

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `PERF_SLOW_QUERY_MS` | `100` | Query chậm hơn ngưỡng này sẽ log WARNING |
| `PERF_SLOW_REQUEST_MS` | `1000` | Request chậm hơn ngưỡng này log WARNING |
| `RUN_DB_WAL` | `0` | Bật `PRAGMA journal_mode=WAL` (thử A/B để so sánh) |
| `EXPERIMENTS_CACHE_TTL_SEC` | `30` | TTL cache `list_experiments` (scan metadata bag) |

Mọi request được log 1 dòng `perf.request`:
```
method, path, status, durationMs, queries, dbMs, slowQueries
```
- `queries` = số lệnh SQLite phát sinh bởi request đó → **phát hiện N+1** (request
  lặp query nhiều lần với 1 run là N+1).
- `dbMs` = tổng thời gian query; `slowQueries` = số query vượt `PERF_SLOW_QUERY_MS`.
- Query chậm log kèm SQL tại event `perf.slow_query`.
- Pipeline `/analysis` log tách stage: `perf.phase.analysis.detect`,
  `perf.phase.analysis.ai`, `perf.phase.analysis.persist` (LLM upstream đã có
  sẵn `llm.chat_completion` với `latency_ms`).

## 2. Chạy server

```powershell
make run   # uvicorn :8000 (log ra console — dễ theo dõi perf.request)
```

## 3. Load test với k6

```powershell
k6 run --vus 10 --duration 30s scripts/k6/smoke.js
k6 run -e DATASET_ID=test_minimal scripts/k6/heavy.js
# nếu đã bật API_AUTH_TOKEN:
k6 run -e API_AUTH_TOKEN=<token> scripts/k6/smoke.js
```

- `smoke.js`: các endpoint nhẹ (`/health`, `/datasets`, `/dashboard/overview`,
  `/review`, `/review/stats`, ...) — đo p50/p95/p99, throughput, tỷ lệ lỗi.
- `heavy.js`: `POST /analysis` → `GET /analysis/{id}` → `GET .../health` với 1 VU
  (pipeline nặng, không dồn nhiều VU). Đổi dataset bằng `-e DATASET_ID=...`.

Xem song song log backend: endpoint nào có `queries` lớn / `dbMs` chiếm tỷ lệ lớn
trong `durationMs` là ứng viên tối ưu đầu tiên.

## 4. Kiểm tra Database (SQLite)

```powershell
python scripts/perf/explain_queries.py
```

In ra `EXPLAIN QUERY PLAN` (bản SQLite của `EXPLAIN ANALYZE`), thời gian chạy
thật x3 lần cho các query nóng (list_runs, get_run_anomalies, review_stats...),
journal_mode, danh sách index và số dòng mỗi bảng.

Mẹo thủ công:
```powershell
sqlite3 data/runs.db
.timer on
SELECT * FROM run_anomalies WHERE run_id = 'run_test_minimal';
```

## 5. Profiler Python (khi đã biết khu vực chậm)

```powershell
# cProfile + snakeviz — profile cả pipeline trên 1 bag thật
.\.venv\Scripts\python.exe scripts/perf/profile_analysis.py --dataset C_02_0 --view
.\.venv\Scripts\pip.exe install snakeviz
snakeviz perf_analysis.prof

# py-spy — sample CPU khi server đang chạy (không cần sửa code, tìm event-loop blocking)
.\.venv\Scripts\pip.exe install py-spy
py-spy record -p <PID uvicorn> -o profile.svg --duration 30
# tìm hàm chạy lâu: py-spy top -p <PID>
```

## 6. Báo cáo kết quả (điền sau khi đo)

| Endpoint | p50 | p95 | p99 | queries/req | dbMs/req | Ghi chú |
|---|---|---|---|---|---|---|
| GET /dashboard/overview | | | | | | đã sửa N+1 (1 query `IN`) |
| GET /analysis/{id} | | | | | | |
| GET /analysis/{id}/health | | | | | | |
| POST /analysis | | | | | | xem stage detect/ai/persist |

**Thứ tự ưu tiên tối ưu** (sau khi có số liệu — kết quả đo & tối ưu đã làm xem
`docs/perf-report.md`):
1. Endpoint có `queries` > 2-3 lần số thực thể → nghi N+1, gộp bằng query `IN (...)`.
2. `dbMs` lớn → tối ưu index / denormalize (dùng `explain_queries.py` để verify).
3. Endpoint async gọi sync sqlite trực tiếp → chuyển qua `anyio.to_thread.run_sync`
   (giảm blocking event loop dưới tải).
4. `RUN_DB_WAL=1` thử A/B nếu có ghi chồng.
