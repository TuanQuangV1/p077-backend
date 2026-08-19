# Báo cáo đo hiệu năng & tối ưu — RAV-13

Ngày đo: 2026-08-18 · Môi trường: Windows 11, Python 3.11.9, FastAPI/uvicorn,
SQLite (`data/runs.db`), 14 dataset (~20 GB rosbag: MCAP + DB3), LLM chưa cấu
hình (fallback canned).

## 1. Tóm tắt

| Metric | Trước tối ưu | Sau tối ưu | Thay đổi |
|---|---|---|---|
| `GET /api/v1/datasets` (cold scan) | **4.73 s** (WARNING) | **~440 ms** | **10.7x nhanh hơn** |
| `POST /analysis` (test_minimal) | **9.16 s** | **~70–110 ms** | **~85x nhanh hơn** |
| `GET /dashboard/overview` p95 | 92 ms | 46–64 ms | ~1.5x |
| `GET /analysis/{id}` | 15 ms | ~15 ms | không đổi |
| `GET /analysis/{id}/health` | 10 ms | ~10 ms | không đổi |
| Slow requests (>1 s) khi k6 smoke 10s × 5 VU | nhiều (datasets) | **0** | — |
| Scan thư mục lạnh `list_experiments` (cProfile) | **15.6 s** (8 bag MCAP) | 615 ms | **25x** |
| `POST /analysis` trên `C_02_0` (82,692 msg) — decode-only | 3.76 s | **3.06 s** | **1.23x** |
| `POST /analysis` trên `C_02_0` — toàn pipeline | 4.37 s | **3.43 s** | **~21%** |

Kết luận: điểm nghẽn chính là **scan dataset lạnh** — đọc metadata từng bag
bằng cách **iterate toàn bộ message của file MCAP**. Đã xử lý bằng (a) cache
kết quả `list_experiments` và (b) đọc MCAP summary/message-index thay vì
iterate. Xem phần 3.

## 2. Phương pháp đo

- **Timing middleware** (`src/main.py`): mọi request log 1 dòng
  `perf.request ... durationMs=X queries=N dbMs=Y slowQueries=Z`; WARNING khi
  >1000 ms (`PERF_SLOW_REQUEST_MS`).
- **SQLite instrumentation** (`src/services/perf.py`): mọi lệnh SQLite được đo,
  đếm theo request (phát hiện N+1), log `perf.slow_query` khi >100 ms
  (`PERF_SLOW_QUERY_MS`).
- **Stage timing** (`analysis.py`): `perf.phase.analysis.detect/ai/persist`.
- **Load test**: k6 v2.2 — `scripts/k6/smoke.js` (5–10 VU, 10–30s),
  `scripts/k6/heavy.js` (1 VU, pipeline /analysis).
- **Profiler**: `scripts/perf/profile_analysis.py` (cProfile) trên dataset thật;
  `scripts/perf/explain_queries.py` (EXPLAIN QUERY PLAN + timing x3).

## 3. Phát hiện điểm nghẽn (bằng số liệu)

### 3.1. `GET /datasets` = 4.73 s — scan dataset là gánh nặng chính

Log trước khi tối ưu:

```
WARNING perf.request GET /api/v1/datasets status=200 durationMs=4734.19 queries=22 dbMs=3.62
```

- `dbMs` chỉ 3.6 ms → thời gian không nằm ở SQLite mà ở **đọc metadata bag**.
- Cache cũ ở tầng route (TTL 5 s, `_DatasetsCache`) vẫn phải trả phí scan mỗi
  5 s, và `POST /analysis` cố tình bỏ cache (`use_cache=False`) nên trả phí đủ.

### 3.2. `POST /analysis` = 9.16 s nhưng stage thật chỉ ~110 ms

```
WARNING perf.request POST /api/v1/analysis status=202 durationMs=9162.64 queries=55 dbMs=41.7
perf.phase.analysis.detect  durationMs=4.22
perf.phase.analysis.ai      durationMs=0.01
perf.phase.analysis.persist durationMs=104.65
```

~9 s "mất tích" nằm ngoài các stage: phần lớn là `_load_datasets(use_cache=False)`
→ scan dataset (xem 3.3) và parse bag thật trong `detect` (bag lớn hơn).

### 3.3. cProfile: `list_experiments()` chiếm 15.6 s / 15.8 s

```
15.437s total (run_analysis trên test_minimal)
  15.643 list_experiments
    15.606 _load_item ×17
      15.191 _read_bagfile_info_from_mcap (8 bag, 621,366 message)
         10.168 anyreader.messages()  ← iterate TOÀN BỘ message chỉ để đếm
```

`_read_bagfile_info_from_mcap` dùng `AnyReader.messages()` đi qua từng message
để đếm per-topic + min/max timestamp. Với bag 35 MB (~83k message), mỗi lần
scan mất 0.5–0.7 s/bag; dataset không có `metadata.yaml` phải chịu phí này ở
**mọi** request.

### 3.4. N+1 query ở dashboard (đã sửa trước đó)

`GET /dashboard/overview` gọi `get_run_anomalies` N lần (1 query/run). Đã gộp
thành 1 query `WHERE run_id IN (...)` (`run_store.get_runs_anomalies`). Trước:
6–7 queries; sau: 6 (gồm 3 query store + 3 query đọc metadata bag).

## 4. Tối ưu đã thực hiện

| # | Thay đổi | File | Ảnh hưởng |
|---|---|---|---|
| 1 | **Cache `list_experiments`** — TTL 30 s (`EXPERIMENTS_CACHE_TTL_SEC`), thread-safe, tự invalidate khi upload/delete | `experiments.py` | Request thường trả 0 ms thay vì scan 0.6–4.7 s |
| 2 | **Đọc MCAP message index** — `McapReader.open()` (rosbags) đọc summary section: `statistics.channel_message_counts`, `start/end_time`, `channels` — không deserialize payload, không iterate message | `experiments.py:_read_bagfile_info_from_mcap` | Scan lạnh 0.5–0.7 s/bag → **13–19 ms/bag** (~40x), counts khớp 100% (71,103 / 82,692 / 61,120) |
| 3 | Bỏ cache trùng lặp ở tầng route (`_DatasetsCache`) — chỉ còn 1 cache ở service | `routes.py` | Đơn giản hóa, hết `use_cache=False` hack |
| 4 | (Đã làm trong đợt trước) fix N+1 dashboard + instrumentation toàn diện | `routes.py`, `perf.py`, ... | Nền tảng đo lường |
| 5 | **Sync → `anyio.to_thread.run_sync`** toàn bộ endpoint async gọi SQLite/IO (dashboard, datasets, analysis, review, hilt) — không chặn event loop | `routes.py` | Giữ event loop phản hồi dưới tải |
| 6 | **Lightweight CDR extractor** cho `detect_anomalies` — parse tay chỉ các field cần (`header`, `frame_id`, `child_frame_id`, `level`) thay vì deserialize CDR đầy đủ; kèm field-plan cache (`_CDR_PLANS`), static-size skip (`_CDR_STATIC_SIZES`) và gộp skip các field static liên tiếp trong walk | `bag_stream.py` | Decode nhanh 1.2–1.3x trên C_02_0 (xem mục 5); không tạo message object → giảm GC/peak memory |

## 5. CDR light extractor (C_02_0, chi tiết)

**Ý tưởng**: song song hóa decode theo topic đã bị loại — `Typestore.deserialize_cdr`
của rosbags là pure-Python CPU-bound, GIL khiến thread pool không cải thiện
throughput. Thay vào đó parse tay CDR bytes:

- Mỗi message CDR2 có 4-byte header (`rawdata[1]` = endianness); walk bắt đầu
  tại `pos=4`. Big-endian hoặc kiểu lạ → fallback `reader.deserialize` (đảm bảo
  đúng 100% kết quả).
- Chỉ đọc các field `detect_anomalies` cần (diagnostics.py): `header.stamp`
  (float giây), `frame_id`, `child_frame_id`, `level` (diagnostics) — không parse
  payload body (imu 9-DOF, scan 1,941 điểm, ...).
- Layout theo đúng quy tắc CDR của rosbags (`align`/`align_after` — padding trước
  field, string int32-length có NUL, sequence int32-count).
- **Field-plan cache** (`_CDR_PLANS`): plan `(fname, desc, pre_align, post_align,
  static_size)` per type, tránh đi lại typegraph mỗi message; các field static
  không thuộc nhóm cần extract được **gộp skip** một cú `pos += size` trong walk
  (Quaternion 32 B, Vector3 24 B, Transform 56 B, Imu tail 296 B...) — Imu (57%
  số message của C_02_0) còn lại 1 read_field cho header + 6 lần tăng con trỏ.
- **Static-size skip** (`_CDR_STATIC_SIZES`): message có layout tĩnh (mọi
  pre-align ≤ base-align, không string) thì skip nguyên một cú bằng kích thước
  đã precompute.

**Kết quả đo** (C_02_0, 82,692 messages / 8 topics — cùng máy, cùng quy trình
benchmark best-of-3, cache nóng):

```
decode-only (light)   3.06 s   vs  full deserialize 3.76 s   (1.23x)
đọc raw không decode   0.45 s   ← chi phí rosbags merge/chunk không đổi được
lần đo 2 (máy bận)    8.75 s   vs  11.61 s                  (1.33x)
run_analysis pipeline  3.43 s   vs  trước tối ưu     4.37 s  (~21%)
```

cProfile (máy bận): deserialize trước đây chiếm 71% wall; light extract giờ chỉ
còn ~33% — phần còn lại là chi phí chung không đổi: `storage_mcap.messages()`
(chunk decompress + `heapq.merge` theo timestamp) và `detect_anomalies` loop.

Verify chéo trên toàn bộ 82,692 messages: `header` / `frame_id` / `level` **0
mismatch**, fallback **0**; `child_frame_id` None ≡ "" (chuẩn hóa về "" trong
`_decode_message`, khớp hành vi cũ).

## 6. Kết quả sau tối ưu (đo lại trên cùng máy)

### k6 smoke (5 VU × 10 s) — không còn slow request

```
GET /api/v1/datasets   durationMs≈440  (cold scan đầu tiên, rồi ~0 ms cached)
GET /dashboard/overview p95 ≈ 46–64 ms, 6 queries
slow requests: 0/1261
```

### k6 heavy (1 VU, test_minimal)

```
POST /analysis        durationMs ≈ 70–110 ms (trước: 9162 ms), queries=11
```

Ghi chú: ở tải 161 req/s, rate limiter (120 req/min/IP) bắt đầu trả 429 — là
hành vi đúng thiết kế, không phải lỗi hệ thống.

### Scan lạnh `list_experiments` (cProfile-free, thực đo)

```
cold scan:  615 ms  (14 dataset, đọc index MCAP + SQLite metadata)
cache hit:  ~0 ms
```

## 7. Khuyến nghị tiếp theo (theo thứ tự ưu tiên)

1. **Bottleneck còn lại của decode là tầng storage của rosbags** — chunk
   decompress + `heapq.merge` (~0.45 s/82k msg) và `detect_anomalies` loop; cả
   hai không đổi được từ light extract. Muốn nhanh hơn nữa: đọc MCAP chunks
   trực tiếp (mcap-py, index-topic đã có trong summary) thay vì đi qua
   `AnyReader.messages()`; hoặc parse CDR bằng Rust/numpy vectorized.
2. **A/B `RUN_DB_WAL=1`** nếu có ghi chồng; hiện `PRAGMA journal_mode` của
   `data/runs.db` đã là `wal` trên máy đo.
3. **LLM latency** — khi cấu hình vLLM/OpenAI: log `llm.chat_completion` đã có
   `latency_ms`; nếu upstream chậm, tính cache summary/result.
4. `_read_bagfile_info_from_db3` (bag không có `metadata.yaml`) vẫn đọc
   `COUNT(*)/GROUP BY` trên bảng `messages` — nhanh nhờ index đã tạo lúc upload,
   nhưng có thể gộp các bag nhỏ.

## 8. Cách lặp lại phép đo

```powershell
make run                                                        # 1. start server
k6 run --vus 5 --duration 10s scripts/k6/smoke.js               # 2. light endpoints
k6 run -e DATASET_ID=test_minimal scripts/k6/heavy.js           # 3. pipeline
python scripts/perf/explain_queries.py                          # 4. SQLite plan
python scripts/perf/profile_analysis.py --dataset C_02_0 --view # 5. deep profile
```

So sánh light vs full deserialize (82,692 msg C_02_0, chạy trong cùng tiến
trình, best-of-3 — light trước sẽ làm nóng page cache nên lần full sau hơi
hưởng lợi; kết quả vẫn 1.2–1.3x nghiêng về light):
```python
# trong Python session:
from pathlib import Path
from src.services.bag_stream import iter_rosbag2_decoded
from rosbags.highlevel import AnyReader
bag = Path("data/C_02_0/C_02_0.mcap")
def consume(gen):
    n = 0
    for _ in gen:
        n += 1
    return n
import time
t0 = time.perf_counter(); consume(iter_rosbag2_decoded(bag))   # light
print("light", time.perf_counter() - t0)
def full():
    with AnyReader([bag]) as reader:
        for conn, ts, raw in reader.messages():
            yield reader.deserialize(raw, conn.msgtype) if raw else None
t0 = time.perf_counter(); consume(full())                      # full
print("full ", time.perf_counter() - t0)
```

Xem log server tìm `perf.request` / `perf.slow_query` / `perf.phase.*`. Chi tiết
config: `docs/perf.md`.
