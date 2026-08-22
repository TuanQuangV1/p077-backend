# Báo cáo tối ưu hóa và hoàn thiện project AI/Robotics

**Ngày rà soát:** 2026-08-21
**Bản sửa đổi:** rev-3 — rev-2 được tái kiểm định độc lập: chạy lại detector trên 49 bag và **218 call LLM thật** (OpenAI `gpt-4o-mini`, temp 0,2, 0 fallback). Toàn bộ số liệu static và detector tái lập chính xác. Ba kết luận của rev-2 bị bác bỏ và sửa lại ở §4.2, §5.5, §5.6; một finding mới (P1-11) được bổ sung.
**Phạm vi:** Backend FastAPI/Python, detector và LLM analysis, frontend Next.js, Docker, Terraform, CI/CD, bảo mật và vận hành.
**Đối tượng đọc:** Technical lead, engineering manager và nhóm AI/Robotics.

## 1. Kết luận điều hành

Project **chưa sẵn sàng cho production**, nhưng khoảng cách nhỏ hơn đánh giá trước đây. Cần phân biệt rõ hai phần.

**Phần lõi chẩn đoán đã tốt và đã được đo lại.** Detector đạt strict recall 51/57 (89,5%) trên 57 fault được inject, và trên 10 bag healthy chỉ sinh 2 detection mức medium (0,2/bag, không có case high/critical). Episode aggregation, phân loại clock backward và TF edge attribution đều đã hoạt động đúng — đây là các hạng mục từng được liệt kê là lỗi trong bản rev-1 và nay đã được xác nhận là đã sửa. Đây là phần khó nhất của bài toán và nó đã xong.

**Phần chặn phát hành nằm ở ranh giới hệ thống và ở khâu suy luận nhân quả.** Bảy nhóm vấn đề:

1. API production **public hoàn toàn**: `_require_auth` no-op khi thiếu token, và Terraform không inject `API_AUTH_TOKEN` ở bất kỳ môi trường nào. Frontend cũng không gửi header `Authorization`.
2. Staging không khởi động được; ACR auth mâu thuẫn; frontend production proxy về loopback; compose production không parse được.
3. **HILT iterative debugging không hoạt động 100%**: một `AttributeError` từ API Pydantic v1 bị `except Exception` nuốt, nên mọi lời gọi đều trả canned result dù LLM chạy thành công.
4. **Cơ chế phân biệt nguyên nhân/hệ quả gần như chết**: 92,6% detection bị gán role `primary` trên path whole-bag, 91,9% trên path production. Nguồn gốc nằm ở chính model (raw output đã 90,5% `primary`), **không** phải ở guard `_enforce_simultaneity` — xem §4.2. Trên path production thật, root cause chỉ đúng 45,0% ở cấp cluster.
5. Run/anomaly ID không bất biến; timestamp trả về là absolute sim time nhưng frontend dùng như relative; ZIP hợp lệ có directory entry luôn fail khi upload.
6. Health panel key theo 7 kind demo backend không phát, bỏ sót 9/11 kind thật — operator thấy "healthy" giả. Observability drift: run ghi model `vllm/qwen2.5-coder-32b` trong khi provider thật là OpenAI.
7. **Cluster window 5s phân mảnh incident**: 39 bag sinh 140 cluster, 25% trong đó chỉ có 1 detection nên bắt buộc là `primary`. Đây là nghi phạm gốc của cả role inflation lẫn root cause kém (P1-11).

Thứ tự đúng: khóa security + deploy blocker trước (P0, làm trong ngày), sau đó sửa HILT (phạm vi hẹp, một dòng) và causal ranking (đòn bẩy cao nhất nhưng **phạm vi rộng hơn rev-2 ước tính** — xem §4.2), rồi mới tới data contract và persistence. **Không cần đổi model hay viết lại detector core**, nhưng cần làm lại clustering + prompt + pre-ranking chứ không chỉ sửa một guard.

## 2. Phương pháp và bằng chứng rà soát

### 2.1 Kiểm tra tĩnh đã thực hiện

Toàn bộ bảng dưới đây được **chạy lại ở rev-3** và tái lập chính xác, bao gồm cả các case fail (`APP_ENV=staging` → `literal_error` trên `app_env`; `compose config` exit 1 vì thiếu `env/production.env.example`; ZIP directory entry → `FileExistsError`; `IterativeDebugger.suggest()` với key OpenAI hợp lệ → `model=canned-fallback`).

| Hạng mục | Kết quả | Diễn giải |
|---|---:|---|
| `ruff check src tests --no-cache` | Pass | Không còn lỗi lint. |
| Backend tests (`pytest -q`) | 282 passed / 4,73s | Chưa bao phủ route production và lifecycle. |
| Backend coverage | 86,96% (3006 stmt, 392 miss) | `routes.py` ~74%, `bag_stream.py` ~48%. |
| Frontend TypeScript | Pass (exit 0) | `tsc --noEmit --incremental false`. |
| Frontend Vitest | 26 passed / 3 file | Chưa thay thế browser integration/contract test với backend thật. |
| `pnpm audit --prod --audit-level high` | `No known vulnerabilities found` | Chỉ phản ánh dependency đã biết tại thời điểm chạy; không thay cho scan image OS. |
| `pip-audit` | **Chưa chạy được** | Binary chưa cài. Bản rev-1 báo "không có advisory" — kết quả đó **không tái lập được**, không dùng làm bằng chứng. |
| Gitleaks | Chưa chạy được | Binary chưa cài. |
| `docker compose -f docker-compose.prod.yml config` | **Fail (exit 1)** | `env/production.env.example not found`. |
| `APP_ENV=staging Settings()` | **Fail** | `literal_error: Input should be 'development', 'production' or 'test'`. |
| `grep -rn "API_AUTH_TOKEN" terraform/` | **Rỗng** | Production không có token → auth no-op. |
| `grep -n "Authorization" frontend/lib/api.ts` | **Rỗng** | Frontend không gửi token. |
| Terraform validate | Chưa chạy được | Không có binary; lỗi logic phát hiện qua source review. |

### 2.2 Benchmark động đã thực hiện

Chạy trực tiếp trên `/home/haibk/ros2_doctor_ws/bags/`, không dùng fixture:

| Hạng mục | Quy mô |
|---|---|
| Faulty bags (MCAP + ground truth) | 39 bag / 57 fault labels |
| **Healthy bags** (đối chứng specificity) | **10 bag** |
| Detector | `iter_bag_messages` → `detect_anomalies` của project, 49 bag |
| LLM provider | OpenAI thật, `gpt-4o-mini`, key từ `.env` |
| LLM path A — `explain_diagnostics` | 39/39 call thành công |
| LLM path B-whole — `explain_detection_cluster`, **1 call / bag** | 39/39 call thành công |
| LLM path B-prod — `explain_detection_cluster` qua `_cluster_detections`, **path production thật** | 140/140 call thành công |
| Ablation `_enforce_simultaneity` (bắt role trước/sau trên cùng response) | 39/39 call thành công |
| Tổng call LLM thật | **218**, 0 lỗi transport, 0 fallback |
| Tổng detection sinh ra | 556 (faulty) + 2 (healthy) |

Matching rule: quy đổi `t_rel = tSec − bag_t0_sim_ns/1e9`, khớp theo overlap thời gian ±10s **và** topic phải nằm trong `target_topics` của ground truth. Không có raw bag hay LLM response nào được commit vào repo.

**Định nghĩa metric `root_cause` (rev-2 thiếu, rev-3 bổ sung).** "Chọn đúng primary topic" = **topic được nêu đầu tiên** trong prose `root_cause` nằm trong `target_topics`. Đây là metric chặt. Nếu đổi sang "nêu **bất kỳ** GT topic nào", cùng bộ response cho **84,6%** thay vì 64,1% — chênh 20 điểm chỉ do định nghĩa. Mọi ngưỡng ở §8 chỉ có nghĩa khi kèm định nghĩa này.

**Mapping kind → fault group dùng cho "strict recall" (rev-2 thiếu):**

| Fault group | Kind được coi là khớp |
|---|---|
| `frequency` | `frequency_gap`, `hz_drop`, `hz_drop_critical`, `message_drop_burst`, `silent_node` |
| `timestamp` | `clock_drift`, `header_latency`, `timestamp_jitter` |
| `tf` | `tf_missing_gap`, `tf_conflict`, `tf_drift_jump` |
| `qos` | `message_drop_burst`, `frequency_gap`, `hz_drop`, `hz_drop_critical`, `silent_node` |
| `data_quality` | `payload_nan`, `payload_out_of_range`, `payload_zero_byte` |
| `node` | `silent_node`, `log_fatal`, `log_error_burst` |

Lưu ý về độ chặt: `silent_node` và `frequency_gap` hợp lệ cho 3/6 nhóm, mà đúng hai kind này chiếm 362/556 detection. Một bag phun dày hai kind này gần như trúng strict theo cấu trúc. 89,5% vì vậy là cận trên của recall, không phải thước đo chất lượng attribution.

### 2.3 Nguyên tắc phân loại

- **P0:** Không deploy được, public dữ liệu/API, mất dữ liệu, hoặc một tính năng đã công bố hoàn toàn không hoạt động.
- **P1:** Sai tính đúng đắn của run, anomaly, review hoặc kết luận chẩn đoán; xử lý trước beta.
- **P2:** Giảm độ chính xác/coverage; xử lý theo benchmark.
- **P3:** Rủi ro vận hành, maintainability, governance.

## 3. Bảng findings tổng hợp

| ID | Mức | Vấn đề | Nguyên nhân gốc | Bằng chứng (đã xác minh) | Hướng giải quyết | Nghiệm thu |
|---|---|---|---|---|---|---|
| P0-01 | P0 | Staging không khởi động | `Settings.app_env` không nhận `staging` | `src/config.py:17` vs `terraform/environments/staging.tfvars:2`; `Settings()` ném `literal_error` | Thêm `staging` vào Literal + test 4 môi trường | `Settings()` và staging plan/apply pass |
| P0-02 | P0 | Không có Terraform state; image không đổi revision | `terraform init -backend=false`; tag `latest` | `.github/workflows/staging.yml:121` và `production.yml:121` đều `terraform init -backend=false`; `terraform/environments/production.tfvars:5-6` dùng tag `:latest` | Remote backend có locking; tag theo commit SHA + digest | 2 lần deploy liên tiếp có state và revision khác nhau, rollback được |
| P0-03 | P0 | ACR auth mâu thuẫn | `admin_enabled=false` nhưng Container App dùng admin credential | `terraform/main.tf:28` vs `main.tf:92,171` | Managed identity + role `AcrPull`; bỏ admin references | Pull image thành công khi admin tắt |
| P0-04 | P0 | Frontend production proxy về localhost; compose fail | Dockerfile đọc `API_PROXY_TARGET`, compose truyền `NEXT_PUBLIC_API_BASE_URL`; thiếu `env/production.env.example` | `Dockerfile:55-56`, `frontend/next.config.mjs:2`, `docker-compose.prod.yml:29`; `compose config` exit 1 | Chuẩn hóa một biến proxy + internal DNS; thêm env example | `compose config` pass; UI→backend health/upload/analysis thành công |
| P0-05 | P0 | **API production public hoàn toàn** | Auth no-op khi thiếu token, và token không bao giờ được inject | `src/api/routes.py:96-106`; `grep API_AUTH_TOKEN terraform/` rỗng; `grep Authorization frontend/lib/api.ts` rỗng | Production fail-closed khi thiếu secret; frontend gọi BFF same-origin | Anonymous request bị 401; authenticated flow pass |
| P0-06 | P0 | SQLite không phù hợp multi-replica | Chỉ có process-local lock, IaC cho phép `max_replicas=2` | `src/services/run_store.py:99-137` chỉ có `threading.Lock()` (process-local); `terraform/environments/staging.tfvars:15` đặt `max_replicas = 2` | Managed DB, hoặc khóa `max_replicas=1` có backup drill | Policy replica/storage được kiểm thử và ghi rõ |
| P0-07 | P0 | **HILT iterative debugging trả canned 100%** | `FieldInfo.type_` không tồn tại ở Pydantic v2 → `AttributeError` bị `except Exception` nuốt | `iterative_debug.py:211` + catch tại `:53-64`; chạy thật với key hợp lệ vẫn trả `model='canned-fallback'` | Dùng `.annotation`; catch theo loại lỗi cụ thể; fallback phải giữ ID và gắn nhãn `source` | `suggest()` trả `model` thật và evidence từ LLM |
| P1-01 | P1 | Phân tích lại ghi đè run cũ | ID `run_{dataset_id}` + `INSERT OR REPLACE` | `analysis.py:85,111,144`; `run_store.py:146` | UUID/ULID mỗi analysis; unique immutable run | Hai analysis cùng dataset tạo hai run độc lập |
| P1-02 | P1 | HILT route luôn 404 với anomaly thật | Detection không có field `id`; route so khớp `a.get("id")` | `run_store.py:208-220` lưu raw payload; 556/556 detection **không có** key `id`; `routes.py:826` | Sinh anomaly ID tại detector layer, persist và dùng xuyên suốt | GET/POST HILT thành công với run thật |
| P1-03 | P1 | **Role cause/consequence bị vô hiệu** | **Model tự gán 90,5% `primary` ngay ở raw output.** `_enforce_simultaneity` chỉ đóng góp thêm 2,1 điểm, không phải nguyên nhân | Ablation trên chính response thật (§4.2): raw `primary` 389/430 = 90,5% → sau guard 398/430 = 92,6%; flip do guard 9/430 = **2,1%**. Path production: 509/554 = 91,9% | Topic dependency graph gate + pre-rank detection trước khi gửi LLM + sửa prompt. **Không** sửa `_enforce_simultaneity` (xem P1-11 cho clustering) | Tỉ lệ `primary` giảm về mức phản ánh cấu trúc nhân quả thật; root cause cấp cluster tăng từ baseline 45,0% |
| P1-04 | P1 | Timeline sai với timestamp epoch/sim | `tSec` là absolute sim time, frontend dùng như relative | Đo thật: F3_01 `tSec` = 1815–1856 trong khi `bag_duration_sec` = 182,4; `bag_stream.py:574-586`, `frontend/components/analysis/timeline-canvas.tsx:162-166` | API trả `bagStart/bagEnd` và `tRel`; UI chỉ dùng relative | Timeline, anomaly window và clock khớp trên bag epoch |
| P1-05 | P1 | Sửa root cause không bền vững | Review store chỉ lưu status/verdict/notes | `ai-conclusion.tsx:63-87`, `run_store.py:301-357` | Thêm `corrected_root_cause` versioned hoặc append-only review event | Reload vẫn giữ kết luận human + audit trail |
| P1-06 | P1 | Health panel không hiển thị detection thật | Panel key theo kind demo, không theo kind backend phát ra | `types.ts:16-45` khai đủ catalogue, nhưng `frontend/components/health/*.tsx` chỉ tham chiếu **2/17 kind thật** (`header_latency`, `timestamp_jitter`) và **7 kind không tồn tại trong backend** (`cpu_spike`, `lidar_dropout`, `localization_jump`, `message_drop`, `nav_recovery`, `tf_timeout`, `topic_hz_drop`) | Panel render theo canonical enum backend + contract test; unknown kind hiện trạng thái rõ | Cả 17 kind catalogue có mapping/render hoặc trạng thái unknown rõ |
| P1-07 | P1 | Deep-dive gắn nhãn LLM nhưng là heuristic client | Panel không gọi backend endpoint | `llm-deep-dive-panel.tsx:185-202` vs `routes.py:572-610` | Gọi backend làm nguồn chuẩn; fallback ghi rõ `source` | UI hiển thị source, model/prompt version, evidence |
| P1-08 | P1 | Model/observability drift | Run ghi `_DEFAULT_MODEL`; AI row ghi nhãn tổng quát | `analysis.py:74` = `"vllm/qwen2.5-coder-32b"` (provider thật là `openai/gpt-4o-mini`); `analysis.py:290` = `"llm-explain"` | Ghi provider/model/prompt version thật từ response | Số liệu cost và so sánh model dùng được |
| P1-09 | P1 | **ZIP hợp lệ có directory entry luôn fail** | `_extract_zip_safely` coi mọi member là file, `dest.open("wb")` trên dir entry rồi mkdir đè lên | Tái hiện được: ZIP chứa `bag/` + `bag/metadata.yaml` → `FileExistsError: File exists: .../out/bag`. `experiments.py:335-359`; cleanup `:370-433` không phủ mọi nhánh | Bỏ qua member có `is_dir()`; `finally` cleanup | ZIP có thư mục extract thành công; file hỏng không để lại folder |
| P1-10 | P1 | 202 nhưng xử lý đồng bộ; WS không có route | `analyze` chạy thread nhưng chờ hoàn tất | `src/api/routes.py:450-455` | Job queue thật + status polling | 202 chỉ trả job; trạng thái quan sát được |
| P1-11 | P1 | **Cluster window 5s phân mảnh incident** | `_CLUSTER_WINDOW_SEC = 5.0` cắt một sự cố kéo dài thành nhiều cluster rời; cluster 1 phần tử không có gì để so sánh nên bắt buộc `primary` | `analysis.py:320-337`, `_CLUSTER_WINDOW_SEC` tại `analysis.py:78`; đo thật: 39 bag → **140 cluster**, **35 (25%) có đúng 1 detection**; root cause cấp cluster chỉ đúng 45,0% | Cluster theo episode/causal window thay vì khoảng cách onset cố định; cluster singleton không sinh kết luận nhân quả; hợp nhất root cause ở cấp run | Số cluster/bag phản ánh số incident thật; không còn cluster 1 phần tử tự xưng root cause |
| P2-01 | P2 | Thiếu node lifecycle detector | Crash/restart chỉ suy ra từ hậu quả TF/frequency | 5/8 fault nhóm node miss strict (xem §5.3) | Heartbeat, restart boundary, last-seen gap, mapping node↔topic | 4 case crash/restart tạo diagnosis cấp node |
| P2-02 | P2 | Payload `Inf` không được phát hiện | Chỉ có rule NaN và out-of-range | F5_02 miss; kind histogram không có `payload_inf` | Thêm rule `Inf` đối xứng với NaN, có field/ratio/count | F5_02 sinh kind data-quality đúng |
| P2-03 | P2 | Severity chưa gắn impact | Cascade `/cmd_vel` được gán `critical` ngang fault gốc | F3_01: `silent_node /cmd_vel critical` trong khi fault thật là TF | Calibrate severity theo tác động localization/control/safety | Severity confusion matrix đạt ngưỡng |
| P2-04 | P2 | LLM suy diễn quá mức, thiếu evidence bắt buộc | Chưa bắt buộc citation/confidence/schema version | Path A: 51,3% số ca nêu topic ngoài ground truth (§5.5) | Structured output, evidence span, uncertainty, model registry | Không chấp nhận kết luận thiếu evidence |
| P3-01 | P3 | Rate limit bypass và tăng memory | Tin `X-Forwarded-For` đầu tiên; dict không TTL | `routes.py:109-120`, `rate_limit.py:23-31` | Trusted proxy chain; TTL/LRU/Redis | Spoofed header không bypass |
| P3-02 | P3 | Endpoint nặng chưa rate-limit | Diagnose/threshold/review/delete không dùng helper | `src/api/routes.py` | Quota theo endpoint/user/run | Load test không vượt quota |
| P3-03 | P3 | Build không reproducible; CVE suppress thiếu expiry | `Dockerfile:4-5` ghi comment "Pin to a specific digest" nhưng `:6` vẫn `FROM python:3.11-slim` (floating); install không frozen | `Dockerfile:4-6,13-14,43,50`; `.trivyignore` có 22 entry — **đã có lý do và ngày rà soát**, nhưng thiếu owner, expiry và ticket thay thế | Pin digest thật + lockfile frozen; thêm owner/expiry cho mỗi suppression | Build lặp lại cùng artifact; scan gate có exception governance |
| P3-04 | P3 | Upload lớn bị nginx chặn; build context chứa data | Thiếu `client_max_body_size`; `.dockerignore` không loại `data/` | `nginx/nginx.conf`, `.dockerignore` | Đồng bộ limit; loại data/cache khỏi context | Upload tới giới hạn; context sạch |
| P3-05 | P3 | Docs/config lệch stack thật | `.env.example` khai PostgreSQL/Chroma/LangChain; code dùng SQLite + OpenAI | `.env`, `README.md`, `ARCHITECTURE.md` | Một source of truth; redact metadata hạ tầng | Docs pass checklist, không chứa secret |

### 3.1 Các finding của bản rev-1 nay đã đóng

Bốn hạng mục P2 trong bản trước được trích từ `report_llm.md` (bằng chứng lịch sử). Chạy lại hôm nay xác nhận **đã fix**, và chúng đã được gỡ khỏi bảng trên:

| Finding rev-1 | Kết quả chạy lại 2026-08-21 |
|---|---|
| Frequency drop 80s co thành gap 0,1s | `frequency_gap /odom high rel=50,0..130,0 occurrence_count=800` — **đúng trọn 80s**, khớp GT `[50, 130]` |
| Timestamp backwards gọi nhầm `header_latency` | `clock_drift /imu critical rel=65,0..140,0 drift_sec=5,0003 direction=backward` — **đúng**, khớp GT `[65, 140]` |
| TF edge cụ thể không xác định được | `tf_missing_gap /tf critical child_frame=base_footprint parent_frame=odom gap_sec=40,02` — **đúng edge được inject** |
| F6_03 chỉ phát hiện 1/3 gap | Phát hiện **đủ 3 gap** `/scan` tại rel 39,9–45,0 / 84,9–90,0 / 129,9–135,0, khớp GT `[40,85,130]` |

Không được tái sử dụng các con số của `report_llm.md` cho quyết định release nữa.

### 3.2 Các kết luận của rev-2 bị bác bỏ ở rev-3

Toàn bộ số liệu static và detector của rev-2 tái lập chính xác (§2.1, §2.2, §5.2–5.4 giữ nguyên). Ba kết luận **suy luận** bị bác bỏ:

| Kết luận rev-2 | Bằng chứng rev-3 | Trạng thái |
|---|---|---|
| `_enforce_simultaneity` lan truyền dây chuyền; fix = dùng snapshot `primaries` ban đầu | `llm.py:308-317` **đã** snapshot sẵn. Ablation: guard chỉ gây 9/430 = 2,1% flip; raw model đã 90,5% `primary` | **Sai. Fix đề xuất là no-op.** Viết lại §4.2 |
| `explain_detection_cluster` 1 call/bag = "path production", đạt 64,1% | `analysis.py:353` gọi 1 call **mỗi cluster 5s**: 39 bag → 140 call. Đo path thật: **45,0%** | **Sai nhãn. Over-report ~19 điểm.** Viết lại §5.1, §5.5 |
| Sau khi sửa P1-03 + P2-03, root cause đạt ~85% | Suy ra từ giả định đã bị bác bỏ ở dòng 1 | **Rút lại.** §5.6 không thay bằng con số khác |

Một finding mới xuất hiện khi đo đúng path production: **P1-11 — cluster window 5s phân mảnh incident** (140 cluster/39 bag, 25% singleton).

## 4. Phân tích chi tiết

### 4.1 P0 — Release blockers

#### P0-05: Auth fail-open (nghiêm trọng nhất)

`_require_auth` trả về ngay khi `api_auth_token` rỗng. Đây được ghi chú là "development default", nhưng `grep -rn "API_AUTH_TOKEN" terraform/` **không trả về kết quả nào**: không môi trường nào inject token. Nghĩa là toàn bộ API — bao gồm upload, delete, review và các endpoint state-changing — public khi deploy.

Đồng thời `frontend/lib/api.ts` không chứa chuỗi `Authorization`. Nên nếu bật token mà không sửa frontend thì mọi request thành 401. Hai lỗi này phải sửa cùng lúc.

Cách xử lý: production/staging **fail startup** nếu thiếu secret (không im lặng bỏ qua); frontend gọi route same-origin của Next làm BFF để token chỉ tồn tại phía server. Không hard-code token trong bundle.

#### P0-07: HILT iterative debugging không hoạt động

`IterativeDebugger.suggest()` gọi LLM thành công, rồi `_build_ai_result` chạy `AIResultSummary.model_fields["evidence"].type_(...)`. Pydantic 2.13.4 không có thuộc tính `type_` (chỉ có `.annotation`), nên ném `AttributeError`. Block `except Exception` tại `iterative_debug.py:53` bắt trọn và trả `_canned_result()`.

Đã kiểm chứng end-to-end với key OpenAI hợp lệ:

```
WARNING iterative_debug.llm_failed
rootCause: Message header stamps drift from the bag recording timestamps.
model:     canned-fallback
```

Đây không phải "thường rơi về fallback" mà là **không bao giờ dùng được output của LLM**. Kết hợp với P1-02 (route HILT luôn 404 vì detection không có `id`), toàn bộ tính năng human-in-the-loop hiện là non-functional. Fix chính chỉ là đổi `.type_` → `.annotation` và thu hẹp phạm vi `except`.

#### P0-01 → P0-04, P0-06

Bốn mục này đã được xác nhận bằng runtime/compose/source, chi tiết ở bảng §3. Điểm cần nhấn: không nên map `staging` thành `production` để "cho chạy" — sẽ che mất khác biệt vận hành. Và rollback phải trỏ được về image digest, không phụ thuộc tag mutable.

### 4.2 P1-03 — Vì sao LLM chọn sai root cause

**rev-2 quy sai nguyên nhân ở mục này. rev-3 viết lại toàn bộ dựa trên ablation.**

Project **đã có** cơ chế đúng: `explain_detection_cluster` yêu cầu model gán mỗi detection role `primary` hoặc `consequence`, để tách fault gốc khỏi các consumer chết theo. Cơ chế này không hoạt động, nhưng lý do khác với những gì rev-2 kết luận.

#### Điều rev-2 nói sai

rev-2 viết: *"`_enforce_simultaneity` … lan truyền dây chuyền: mỗi lần nâng cấp lại tạo thêm một `primary` mới làm mốc cho vòng sau"*, và đề xuất fix số 1 là *"dùng snapshot `primaries` ban đầu, không cập nhật trong vòng lặp"*.

Đọc `src/services/llm.py:308-317`: `primaries` **đã** được snapshot một lần **trước** vòng lặp, và kết quả ghi vào dict `corrected` tách biệt khỏi `findings` đang duyệt. Không có lan truyền dây chuyền. **Fix số 1 của rev-2 là no-op — code đã làm đúng điều đó rồi.**

#### Đo thật: ablation guard

Instrument `_enforce_simultaneity` để bắt role **trước** và **sau** trên chính response LLM thật, 39 bag:

```
raw model roles       : primary=389 (90,5%),  consequence=41 (9,5%)
after _enforce_simult : primary=398 (92,6%),  consequence=32 (7,4%)
consequence → primary flips do guard gây ra: 9/430 = 2,1%
```

Guard đóng góp **2,1 điểm** trên tổng ~92%. **Model tự nó đã gán 90,5% `primary` ngay ở raw output.** Gỡ hẳn `_enforce_simultaneity` chỉ đưa tỉ lệ từ 92,6% về 90,5%.

Đây là bài toán **đầu vào** (prompt, thứ tự trình bày, ranking, kích thước cluster), không phải bài toán **đầu ra** (guard). Bỏ một sprint đi sửa guard sẽ thu về 2 điểm.

#### Nghi phạm gốc: clustering (P1-11)

`_cluster_detections` cắt theo khoảng cách onset cố định 5s. Trên 39 bag, 556 detection sinh **140 cluster**, trong đó **35 (25%) chỉ có 1 detection**. Một cluster 1 phần tử không có gì để so sánh, nên nó bắt buộc là `primary` — tỉ lệ primary cao một phần là artefact của cluster window, không phải của model.

Đồng thời một sự cố kéo dài (ví dụ TF gap 40s kéo `/cmd_vel` chết theo trong suốt cửa sổ đó) bị cắt thành nhiều cluster rời, nên model không bao giờ nhìn thấy fault gốc và hệ quả trong cùng một payload.

#### Hệ quả quan sát được ở F3_01 (fault thật: mất TF edge `odom→base_footprint`)

```
13/16 detection là /cmd_vel  (frequency_gap, silent_node, message_drop_burst)
   trong đó: silent_node /cmd_vel  severity=critical
tf_missing_gap /tf child_frame=base_footprint  ← fault thật, nằm gần cuối danh sách
→ LLM kết luận root cause là /cmd_vel
```

Prose thật của model (path whole-bag):

> The /cmd_vel topic failed first due to a silent node condition, which caused subsequent frequency gaps and silent node issues. The /tf topic also experienced critical failures, compounding the issues with the /cmd_vel topic.

Model nhìn thấy `/tf`, nhưng chọn `/cmd_vel` làm nguyên nhân vì `/cmd_vel` chiếm 13/16 số dòng và mang `severity=critical`. Đây là failure mode **áp đảo theo khối lượng và severity**, khớp với P2-03 (severity chưa gắn impact).

#### Hướng sửa, theo thứ tự đòn bẩy giảm dần

1. **Pre-rank detection trước khi gửi LLM**: sensor/TF/payload lên đầu, actuator/cascade xuống cuối, kèm nhãn `likely_cascade`. Model đang chọn theo thứ tự và khối lượng — đổi thứ tự là can thiệp rẻ nhất và trực tiếp nhất.
2. **Gate bằng topic dependency graph tĩnh**: `/cmd_vel` là consumer cuối chuỗi, không bao giờ được là primary khi có sensor/TF anomaly overlap.
3. **Sửa clustering (P1-11)**: cluster theo episode/causal window thay vì khoảng cách onset 5s; cluster singleton không được sinh kết luận nhân quả.
4. **Nén khối lượng cascade trong payload**: gộp 13 detection `/cmd_vel` thành 1 dòng có `occurrence_count`, để model không bị áp đảo theo số dòng.
5. `_enforce_simultaneity`: **để nguyên**. Không phải nguyên nhân, và sửa nó chỉ đổi 2,1%.

### 4.3 Run, anomaly và review phải bất biến

`run_{dataset_id}` không phải identity của một lần phân tích. Retry, chạy lại sau khi đổi detector, hoặc hai user chạy đồng thời đều ghi đè dữ liệu. Mỗi analysis cần UUID/ULID riêng, lưu `dataset_id`, detector version, model/prompt version, thời điểm tạo và quan hệ parent/retry. Thay `INSERT OR REPLACE` bằng transaction có unique constraint.

Anomaly ID phải sinh tại detector. Hiện `save_run_anomalies` lưu nguyên raw payload, và cả 556 detection sinh ra trong benchmark **đều không có key `id`** — keys thực tế chỉ gồm `kind, topic, severity, confidence, tSec, endSec, evidence`. Vì vậy `routes.py:826` so khớp `a.get("id") == anomaly_id.replace("anomaly_", "")` luôn thất bại.

Review nên là record versioned hoặc append-only event có `corrected_root_cause`, reviewer, timestamp và source, để lần chạy model mới không xóa quyết định của con người.

### 4.4 Timestamp contract

Detector trả `tSec` theo absolute sim time của bag, không phải relative. Đo thật:

| Bag | `bag_t0` (s) | `bag_duration` (s) | `tSec` range |
|---|---:|---:|---|
| F3_01 | 1761,1 | 182,4 | 1815,0 – 1856,1 |
| F1_03 | 832,1 | 181,2 | 882,1 |
| C_01 | 115,5 | 212,6 | 155,5 – 251,6 |

Frontend dùng trực tiếp giá trị này để tính duration/bucket nên event dồn về cuối và clock hiển thị sai. Backend cần trả `bagStart`, `bagEnd` và `tRel = tSec − bagStart`; anomaly window và density chỉ dùng relative time.

### 4.5 Frontend contract và ingestion

**Health panel key sai enum.** `frontend/lib/types.ts` khai `BackendAnomalyKind` phủ đủ catalogue backend — phần type đã đúng, không cần sửa. Vấn đề nằm ở chỗ dùng: các panel trong `frontend/components/health/` chỉ tham chiếu 2 kind thật (`header_latency`, `timestamp_jitter`) và 7 kind **không tồn tại trong backend** (`cpu_spike`, `lidar_dropout`, `localization_jump`, `message_drop`, `nav_recovery`, `tf_timeout`, `topic_hz_drop`).

Nghĩa là 15/17 kind của catalogue không có nhánh render nào — bao gồm ba kind chiếm gần như toàn bộ khối lượng detection thực tế: `frequency_gap` (199), `silent_node` (163) và `message_drop_burst` (122). Operator nhìn thấy hệ thống "healthy" giả trong khi detector đang báo hàng trăm anomaly.

**ZIP directory entry.** `_extract_zip_safely` đã xử lý tốt path traversal và giới hạn kích thước (cả `total_uncompressed` lẫn `written` streaming) — phần bảo mật này không cần sửa. Nhưng vòng lặp coi mọi member là file: gặp một directory entry tường minh, nó `open(dest,"wb")` tạo ra một *file* trùng tên thư mục, rồi member tiếp theo `mkdir` đè lên và ném lỗi.

Tái hiện được với ZIP hoàn toàn hợp lệ:

```
ZIP: bag/ , bag/metadata.yaml , bag/bag_0.db3
→ FileExistsError: [Errno 17] File exists: .../out/bag
```

Nhiều công cụ nén (Windows Explorer, `zip -r`) mặc định ghi directory entry, nên đây là đường upload hỏng với người dùng thật, không phải edge case lý thuyết. Fix: `if member.is_dir(): continue`.

### 4.6 P3 — Vận hành và bảo mật

Rate limiter không được tin `X-Forwarded-For` tùy tiện; chỉ proxy trong allowlist mới được set chain. Bộ nhớ cần TTL/LRU hoặc Redis có expiry, và helper phải áp cho mọi endpoint tốn tài nguyên.

`Dockerfile:4-5` có comment hướng dẫn pin digest kèm cả lệnh lấy digest, nhưng dòng `:6` vẫn là `FROM python:3.11-slim` — ý định đã đúng, chỉ chưa thực hiện. Dependency cũng cần cài frozen từ lockfile.

`.trivyignore` (22 entry) tốt hơn mức thường thấy: mỗi cụm đều có lý do và ngày rà soát (`No upstream fix available as of 2026-08-19`), kèm ghi chú "Remove entries as fixes land". Thiếu duy nhất là owner và ngày hết hạn cho từng entry để suppression không tồn tại vĩnh viễn. Lưu ý: audit dependency trực tiếp không phải bằng chứng image sạch.

`nginx/nginx.conf` **không có** directive `client_max_body_size` (mặc định nginx là 1MB) trong khi backend cho phép tới `MAX_UPLOAD_BYTES` — upload rosbag sẽ bị chặn ở proxy trước khi tới app. `.dockerignore` không loại `data/`, nên build context kéo theo cả bag và cache. Logs cần correlation ID theo request/run/job.

`.env.example` hiện khai `DATABASE_URL=postgresql://...`, `CHROMA_PERSIST_DIR` và `LANGCHAIN_*` trong khi code dùng SQLite và gọi thẳng OpenAI qua `httpx`. Đây là nguồn nhầm lẫn onboarding cần dọn.

## 5. Kết quả benchmark thật

### 5.1 Thiết kế

39 bag faulty (57 fault labels) + **10 bag healthy** đối chứng, đọc bằng `iter_bag_messages`, chạy qua `detect_anomalies` của project. Output detector thật gửi qua **ba** cấu hình LLM. Provider OpenAI, model `gpt-4o-mini`, temperature 0,2, **218 request evaluation**, 0 lỗi transport, 0 fallback.

| Cấu hình | Cách gọi | Số call | Có phải path production? |
|---|---|---:|---|
| Path A | `explain_diagnostics(summary + detections)` | 39 | Không — chỉ dùng trong `IterativeDebugger` |
| Path B-whole | `explain_detection_cluster(toàn bộ detection của bag)` | 39 | **Không** |
| Path B-prod | `explain_detection_cluster` qua `_cluster_detections`, 1 call/cluster | **140** | **Có** — đây là cái `analysis.py:353` chạy |
| Ablation guard | như B-whole, bắt role trước/sau `_enforce_simultaneity` | 39 | n/a |

**Đính chính rev-2.** rev-2 gọi path B-whole là "path production". Sai. `analysis.py:353` gọi `explain_detection_cluster` **một lần mỗi cluster 5s**, không phải một lần mỗi bag; mỗi call sinh một `root_cause` riêng và gắn vào từng detection qua `_ai_result_from_explanation`. Không tồn tại một `root_cause` cấp bag trong production. Số liệu 64,1% của rev-2 mô tả một đường code mà ứng dụng chưa từng chạy.

### 5.2 Phân bố detection

556 detection trên 39 bag faulty:

| Kind | Số lượng | | Kind | Số lượng |
|---|---:|---|---|---:|
| `frequency_gap` | 199 | | `header_latency` | 6 |
| `silent_node` | 163 | | `hz_drop_critical` | 5 |
| `message_drop_burst` | 122 | | `payload_out_of_range` | 4 |
| `tf_missing_gap` | 29 | | `payload_nan` | 3 |
| `tf_conflict` | 12 | | `hz_drop` | 3 |
| `clock_drift` | 10 | | **Tổng** | **556** |

Đây là 11 kind **quan sát được trên dataset này**. Catalogue đầy đủ của backend là **17 kind** (`_KIND_LABELS`, `src/services/analysis.py:54`); 6 kind còn lại không kích hoạt vì dataset không chứa fault tương ứng: `timestamp_jitter`, `tf_drift_jump`, `payload_zero_byte`, `log_fatal`, `log_error_burst`, `log_warn_storm`.

Canonical enum ở P1-06 phải phát hành theo 17 kind của catalogue, không phải 11 kind quan sát được.

### 5.3 Recall detector đối chiếu ground truth

Matching: overlap thời gian ±10s **và** topic thuộc `target_topics`.

| Nhóm fault | n | Strict (đúng kind + topic) | Đúng topic | Có tín hiệu |
|---|---:|---:|---:|---:|
| Frequency | 10 | 10 (100%) | 10 (100%) | 10 (100%) |
| Timestamp/clock | 10 | 10 (100%) | 10 (100%) | 10 (100%) |
| TF | 9 | 9 (100%) | 9 (100%) | 9 (100%) |
| QoS/message gap | 12 | 12 (100%) | 12 (100%) | 12 (100%) |
| Data quality | 8 | 7 (87,5%) | 7 (87,5%) | 8 (100%) |
| Node crash/restart | 8 | **3 (37,5%)** | 7 (87,5%) | 8 (100%) |
| **Tổng** | **57** | **51 (89,5%)** | **55 (96,5%)** | **57 (100%)** |

Sáu case miss strict:

| Bag | Fault | Kind quan sát được trong window | Diễn giải |
|---|---|---|---|
| C_03, F4_02 | `F4_02_crash` | `silent_node`, `tf_missing_gap`, `hz_drop_critical` | Có tín hiệu đúng `/tf`, thiếu diagnosis cấp node |
| C_10, F4_04 | `F4_04_restart` | `silent_node`, `tf_missing_gap`, `header_latency` | Như trên |
| F4_05 | `F4_05_restart` | cascade trên `/imu`, `/odom`, `/cmd_vel` | `/plan` không xuất hiện trong bag; chỉ có bằng chứng gián tiếp |
| F5_02 | `F5_02_inf` | không có kind data-quality | Thiếu rule `Inf` (P2-02) |

### 5.4 Specificity trên healthy bags — phép đo quyết định

| Bag | Detection | Severity tổng thể |
|---|---:|---|
| healthy_01, 02, 03, 05, 07, 08, 09, 10 | **0** | low |
| healthy_04 | 1 (`frequency_gap`) | medium |
| healthy_06 | 1 (`frequency_gap`) | medium |
| **Tổng** | **2 (0,2/bag)** | **0 case high/critical** |

**Đây là kết quả tốt và nó thay đổi chẩn đoán của bản rev-1.**

Bản trước xếp cụm detection `/cmd_vel` vào diện false-positive của detector. Phép đo mới bác bỏ điều đó: `healthy_01` có 3.568 message `/cmd_vel` và sinh **0 detection**, trong khi `F3_01` có 3.376 message và sinh 13 detection. Nghĩa là `/cmd_vel` **thực sự ngừng publish** trong bag faulty, vì nav stack đứng khi mất TF.

Đối chiếu attribution trên bag faulty: 164/556 detection (29,5%) khớp topic+window của ground truth; 392 còn lại phân bố `/cmd_vel` 291, `/odom` 29, `/imu` 28, `/scan` 24, `/tf` 20. Kết hợp với kết quả healthy, 392 detection này là **cascade thật, không phải nhiễu**.

Hệ quả cho roadmap: **không siết threshold detector** — làm vậy sẽ giết tín hiệu thật và kéo recall xuống. Vấn đề cần giải là causal ranking (P1-03) và clustering (P1-11), không phải tuning.

**Giới hạn của lập luận này (rev-3 bổ sung).** Healthy bag không chứa fault nào, nên phép đo trên chỉ chứng minh detector không tự phát nhiễu ở trạng thái nghỉ. Nó **không** trả lời được câu hỏi thực sự đang treo: khi có fault, khối lượng cascade sinh ra có tương xứng không. 13 detection `/cmd_vel` cho một TF gap 40s có thể vừa là cascade thật vừa là quá phát về số dòng — và chính khối lượng đó là thứ áp đảo LLM ở §4.2. Cần một phép đo riêng: số detection trên mỗi fault được inject, so với số episode thật, trước khi khẳng định 392 detection ngoài GT là hợp lý.

### 5.5 Chất lượng LLM — ba cấu hình

Metric `root_cause`: **topic được nêu đầu tiên** trong prose phải nằm trong `target_topics` (định nghĩa đầy đủ ở §2.2).

| Metric | Path A `explain_diagnostics` | Path B-whole (1 call/bag) | **Path B-prod (production, 140 cluster call)** |
|---|---:|---:|---:|
| Call thành công, không fallback | 39/39 (100%) | 39/39 (100%) | 140/140 (100%) |
| **`root_cause` chọn đúng primary topic** | **22/39 (56,4%)** | **25/39 (64,1%)** | **63/140 cluster (45,0%)** |
| `root_cause` nêu ít nhất một GT topic | 25/39 (64,1%) | 33/39 (84,6%) | — |
| `findings` role=`primary` chứa GT topic | không áp dụng | 36/39 (92,3%) | — |
| Tỉ lệ detection gán role `primary` | không áp dụng | 450/465 (96,8%) | **509/554 (91,9%)** |
| Chọn `/cmd_vel` làm root cause | 19/39 (48,7%) | 15/39 (38,5%) | 64/140 (45,7%) |

Quy chiếu path B-prod về cấp bag (một bag có nhiều cluster, nhiều `root_cause`):

| Cách chọn cluster đại diện | Đúng GT topic |
|---|---:|
| **Bất kỳ** cluster nào đúng | 37/39 (94,9%) |
| Cluster có severity cao nhất | 35/39 (89,7%) |
| Cluster khởi phát sớm nhất | 31/39 (79,5%) |

#### Ba kết luận

1. **Đính chính rev-2: path production không tốt hơn path flat, mà tệ hơn cả hai.** rev-2 viết *"path production tốt hơn path flat 10 điểm (64,1% vs 53,8%)"*. Thứ hạng thật khi đo đúng đường code đang chạy: **B-whole 64,1% > A 56,4% > B-prod 45,0%**. Cái đang ship là cái kém nhất; rev-2 over-report hệ thống ~19 điểm. Operator mở một AI result bất kỳ hiện có ~55% khả năng đọc được một root cause trỏ sai topic.

2. **Evidence structured vẫn tốt hơn prose.** `findings(primary)` đạt 92,3% trong khi `root_cause` (B-whole) chỉ 64,1% — khoảng cách 28 điểm cho thấy model nhận diện đúng anomaly liên quan nhưng khâu tổng hợp thành một câu root cause thì chọn nhầm topic nổi bật nhất. Vẫn là bài toán ranking + prompt, **không phải năng lực model**.

3. **Failure mode duy nhất và lặp lại: chọn `/cmd_vel` cascade làm nguyên nhân.** Phân bố topic được nêu đầu tiên trên path B-whole: `/cmd_vel` 15, `/imu` 12, `/scan` 5, `/odom` 4, `/tf` 3 — trong khi `/cmd_vel` chỉ là GT của 2/39 bag. **12/14 số ca sai** nêu `/cmd_vel` đầu tiên (con số này của rev-2 đúng và được giữ nguyên); 2 ca còn lại là C_10 và F4_05, cả hai nêu `/imu`. Trên path production, `/cmd_vel` được nêu đầu tiên ở 64/140 cluster (45,7%).

Ví dụ đại diện (path B-whole):

| Bag | GT topic | LLM nêu đầu tiên | Kết quả |
|---|---|---|---|
| F2_04 | `/imu` | `/imu` | Đúng — clock drift backward 5s, cả detector lẫn explanation chuẩn |
| F3_01 | `/tf` | `/cmd_vel` | Sai — detector chỉ đúng edge `odom→base_footprint` nhưng bị 13 detection `/cmd_vel` lấn át |
| F3_03, F3_05 | `/tf` | `/cmd_vel` | Sai — cùng failure mode |
| C_08 | `/scan`, `/tf` | `/cmd_vel` | Sai — prose nói `/cmd_vel` "failed first", rồi `/imu` và `/odom` là hệ quả |
| F6_03 | `/scan` | `/scan` | Đúng — cả 3 gap được nêu |

Không được dùng `root_cause` hiện tại làm ground truth tự động cho safety decision.

### 5.6 Ước lượng sau khi sửa — **rút lại**

rev-2 ước lượng *"root-cause accuracy đạt ~85% sau khi sửa P1-03 và P2-03"*. Ước lượng đó suy ra từ giả định "12/14 ca sai thuộc một failure mode loại bỏ được bằng cách sửa `_enforce_simultaneity`". Ablation ở §4.2 bác bỏ giả định: sửa guard chỉ đổi 2,1%.

**rev-3 rút lại con số 85% và không thay bằng con số khác.** Lý do:

- Baseline thật của path production là 45,0%, không phải 64,1% — khoảng cách tới bất kỳ ngưỡng nào cũng lớn hơn rev-2 tưởng.
- Đòn bẩy thật (pre-ranking, dependency graph, clustering, nén cascade) chưa có cái nào được thử nghiệm, nên không có cơ sở ngoại suy.
- Chênh lệch giữa hai lần chạy độc lập cùng cấu hình đã là 3–5 điểm (path A: 53,8% rev-2 vs 56,4% rev-3; `findings`: 87,2% vs 92,3%) ở temperature 0,2, n=1. Bất kỳ ngưỡng đơn lẻ nào cũng cần n≥3 lượt và khoảng tin cậy trước khi dùng làm gate.

Ngưỡng mục tiêu phải do đội robotics chốt theo use case (xem câu hỏi mở §9.3), rồi đo lại từ baseline 45,0% sau khi triển khai từng bước ở §4.2.

## 6. Kiến trúc đích

`Upload/BFF có auth → durable job → object storage/raw bag → detector pipeline → immutable run/anomaly store → causal ranking → backend LLM explanation → review events → frontend contract-driven panels`

Invariant bắt buộc:

- Mỗi run có identity riêng, không bị overwrite khi retry hoặc re-analysis.
- Mỗi anomaly có ID ổn định sinh tại detector, kèm raw evidence và detector version.
- Mọi timestamp hiển thị quy về cùng một relative time basis.
- Detection được xếp hạng primary/cascade **trước** khi tới LLM, không để LLM tự suy từ danh sách phẳng.
- Một sự cố = một cluster = một root cause. Cluster không được cắt theo khoảng cách onset cố định, và cluster 1 phần tử không sinh kết luận nhân quả.
- AI conclusion không vượt quá evidence; fallback và uncertainty phải nhìn thấy được, và phải ghi model/provider thật.
- Review của con người là dữ liệu audit độc lập.
- Production topology khớp storage/locking model.

## 7. Lộ trình

### Phase 0 — Chặn rủi ro phát hành (P0, ước tính 1–2 ngày)

Auth fail-closed + frontend BFF; thêm `staging` vào enum; remote Terraform backend; ACR managed identity; image digest bất biến; thống nhất biến proxy + thêm `env/production.env.example`; sửa `.type_` → `.annotation` và thu hẹp `except` trong `iterative_debug`. Chốt policy SQLite single-replica hoặc khởi động migration managed DB.

### Phase 1 — Causal ranking và HILT (đòn bẩy cao nhất, phạm vi rộng hơn rev-2 ước tính)

**Không sửa `_enforce_simultaneity`** — ablation cho thấy nó chỉ chiếm 2,1% (§4.2). Thay vào đó, theo thứ tự đòn bẩy:

1. Pre-rank detection trước khi gửi LLM (sensor/TF/payload trước, actuator/cascade sau, nhãn `likely_cascade`).
2. Topic dependency graph tĩnh gate role `primary`.
3. Sửa clustering (P1-11): episode/causal window thay cho khoảng cách onset 5s; cluster singleton không sinh kết luận nhân quả.
4. Nén cascade trong payload gửi LLM (gộp theo topic + `occurrence_count`).
5. Sinh anomaly ID tại detector và persist (P1-02).

Đo lại sau **từng bước**, không gộp, để biết bước nào thực sự có tác dụng. Baseline để so: **45,0% cấp cluster / 91,9% primary rate** trên path production. Mỗi lần đo n≥3 lượt.

### Phase 2 — Contract và persistence

Chuẩn hóa `tRel` ở API contract; UUID cho run và bỏ `INSERT OR REPLACE`; review versioned; canonical anomaly enum từ 17 kind catalogue (§5.2); nối deep-dive qua backend; ghi model/provider thật.

### Phase 3 — Ingestion và vận hành

Job lifecycle thật; harden ZIP cleanup; đồng bộ upload limit; trusted proxy + TTL cho rate limiter; structured logging, metrics, retention/backup.

### Phase 4 — Coverage detector còn lại

Node lifecycle detector; rule `Inf`; severity calibration theo impact. Đo lại trên cả faulty và healthy set.

### Phase 5 — Governance

Contract tests, browser E2E, detector golden set, LLM regression, dependency/image scan gate, CVE exception expiry, model registry, runbook.

## 8. Release gate

### Functional và data integrity

- Hai analysis cùng dataset không overwrite nhau; retry giữ quan hệ parent.
- HILT GET/POST hoạt động với anomaly raw thật, và `suggest()` trả model thật (không `canned-fallback`).
- Review corrected root cause còn nguyên sau reload, có audit history.
- Unknown anomaly kind được hiển thị hoặc cảnh báo, không silently dropped.

### Deployment và security

- `docker compose -f docker-compose.prod.yml config` exit 0; Terraform validate/plan/apply staging pass.
- Container pull được image bằng managed identity khi ACR admin disabled.
- **Anonymous API request bị 401 ở production** — đây là gate cứng.
- Frontend authenticated request tới đúng backend target.
- Rate-limit, upload-size và trusted proxy được kiểm thử bằng abuse/load case.

### Detector và AI quality

- Recall strict ≥ 89,5% theo **đúng mapping kind→group ở §2.2** (không được tụt so với baseline hiện tại).
- **Healthy bags ≤ 0,5 detection/bag, 0 case high/critical** — chống regression khi tuning.
- Tỉ lệ detection gán role `primary` giảm rõ rệt so với baseline **91,9%** trên path production.
- `root_cause` chọn đúng primary topic: đo trên **path B-prod** (cấp cluster), baseline **45,0%**. **Ngưỡng pass chưa được chốt** — chờ đội robotics quyết định theo use case (§9.3). Không dùng lại con số 85% của rev-2, đã rút lại ở §5.6.
- Mọi phép đo LLM chạy **n≥3 lượt**, báo cáo kèm khoảng biến thiên; không chấp nhận gate dựa trên một lượt.
- Timeline epoch và relative timeline cho cùng bag có cùng event ordering.
- LLM response thiếu evidence hoặc sai schema bị reject/đánh dấu fallback.

### Operational readiness

- Backup/restore drill, retention policy, health/readiness probe và alert.
- Build từ cùng commit tạo artifact reproducible.
- Mọi security-scan exception có owner và expiry.
- Runbook cho deploy failure, DB lock, stuck job, LLM outage, storage full.

**Release chỉ mở production khi toàn bộ P0 pass, P1-03 và P1-11 được xác nhận bằng rerun đầy đủ trên path production (n≥3), ngưỡng root-cause được đội robotics chốt (§9.3), policy persistence được quyết định rõ, và benchmark detector đạt ngưỡng §8.**

## 9. Giới hạn của đợt rà soát

- Terraform, Gitleaks và `pip-audit` chưa chạy được do thiếu binary; các finding liên quan dựa trên source review, không phải plan/apply thật.
- Chấm điểm LLM dùng proxy lexical (**topic được nêu đầu tiên** trong `root_cause` — định nghĩa ở §2.2), không phải human rubric. Proxy này nhạy với cách diễn đạt: cùng bộ response cho 64,1% (first-topic) hay 84,6% (any-topic). Nó đủ để phát hiện regression giữa các lần chạy nhưng không đo được chất lượng lập luận. Cần rubric người chấm cho: primary topic, fault type, temporal ordering, severity, evidence citation.
- Metric "strict recall" dùng mapping kind→group ở §2.2, trong đó `silent_node` và `frequency_gap` hợp lệ cho 3/6 nhóm fault. Vì hai kind này chiếm 362/556 detection, 89,5% là cận trên chứ không phải thước đo attribution. Chưa có phép đo precision đúng nghĩa.
- Phép đo specificity chỉ chạy trên healthy bag (không có fault). Chưa đo được tỉ lệ cascade trên mỗi fault được inject, tức chưa biết 392 detection ngoài GT có tương xứng hay quá phát (§5.4).
- Ground truth `target_topics` được coi là chân lý; các case cascade hợp lệ (ví dụ `/cmd_vel` chết vì mất TF) bị tính là "không khớp" trong phép đo attribution ở §5.4. Con số 29,5% vì vậy là cận dưới, không phải precision thật.
- Chỉ chạy `gpt-4o-mini`, một lượt, temperature mặc định. Chưa đo variance giữa các lần chạy và chưa so sánh model.
- Báo cáo không thay thế threat model, load test production hoặc safety validation trên robot thật.
- Không có code/config migration nào được thực hiện kèm báo cáo này; script benchmark chạy ngoài repo và không ghi dữ liệu vào project.
- rev-3 tái kiểm định toàn bộ số liệu static, detector và LLM của rev-2. Các hạng mục rev-2 tự nhận chưa chạy được (Terraform, Gitleaks, `pip-audit`) vẫn chưa chạy được ở rev-3 — trạng thái không đổi.

### Câu hỏi chưa có lời giải

1. Production sẽ chốt single-replica SQLite hay migrate managed DB? Quyết định này chặn Phase 0.
2. `/plan` không tồn tại trong bag `F4_05` — do injector hay do recording config? Ảnh hưởng tới việc case này có tính vào recall hay không.
3. Ngưỡng accuracy nào là chấp nhận được cho đội robotics? Baseline path production hiện là **45,0% cấp cluster**. Con số 85% của rev-2 đã bị rút lại vì không có cơ sở. Câu hỏi này chặn gate §8 và chặn việc biết Phase 1 đã xong hay chưa.
4. Cascade như `/cmd_vel` nên bị ẩn khỏi UI, hay hiển thị nhưng gắn nhãn `consequence`? Ảnh hưởng tới thiết kế contract ở Phase 2.
5. Production nên trả một `root_cause` cấp run hay giữ nhiều `root_cause` cấp cluster như hiện nay? Nếu giữ nhiều, cần định nghĩa cluster nào được UI surface làm kết luận chính (severity cao nhất cho 89,7%, khởi phát sớm nhất chỉ 79,5% — §5.5). Chặn P1-11.
6. Cluster window nên thay bằng gì: episode-based, causal-graph-based, hay window động theo loại fault? Chặn Phase 1 bước 3.
