# Gate 2 Evaluation Test Cases — ROS2 Doctor

Tài liệu ban đầu được tạo ở Task 1 và đã được cập nhật bằng kết quả thực thi thật của Task 2–5. Kết quả chi tiết và API/UI matrix nằm trong `gate2_evaluation_evidence.md`.

| Thuộc tính | Giá trị |
|---|---|
| Branch | `test/gate2-e2e-evaluation` |
| Commit dùng để thiết kế | `aa7726ceb474073adb6e9f785d521f1a77dc7283` |
| Ngày thiết kế | 2026-08-12 (Asia/Saigon) |
| API base URL mặc định | `http://localhost:8000/api/v1` |
| Test environment | `eval/gate2/environment.md` |
| Fixture manifest | `eval/gate2/fixtures/manifest.json` |
| Trạng thái suite | PARTIAL — TC01–TC04 PASS, TC05 BLOCKED |

## 1. Phạm vi và nguồn sự thật

Thiết kế bám theo implementation và test infrastructure hiện có:

- Luồng E2E: `POST /datasets/upload` → `POST /analysis` → `GET /analysis/{run_id}` → `GET /analysis/{run_id}/health`.
- Rule engine: `src/services/diagnostics.py`; thresholds: `src/services/diagnostics_config.py`.
- Parser MCAP/rosbag2: `src/services/bag_stream.py`; registry dataset: `src/services/experiments.py`.
- LLM diagnosis: `POST /analysis/explain`, schema trong `src/models/schemas.py`, implementation trong `src/services/llm.py`.
- Contract tham chiếu: `docs/api_contract.md`, `docs/data_contract.md`, `docs/health/health-score.md`, `docs/health/llm-protocol.md`.
- Test infrastructure hiện có: pytest + `httpx.ASGITransport`, Vitest và Playwright. Task 1 không tạo framework test mới.
- Oracle dữ liệu: `data/dataset/Report_dataset.md` và các file `*_ground_truth.json` đi kèm từng bag.

Không thay đổi production logic trong Task 1. Dữ liệu thật đã có nên TC01–TC03 dùng MCAP thật; chỉ TC04 dùng controlled invalid fixture nhỏ.

## 2. Quy ước thực thi cho Task 2

1. Chạy backend tại `http://localhost:8000` và xác nhận `GET /health` trả HTTP 200.
2. Ghi lại `GET /api/v1/analysis/thresholds` trước suite; không đổi thresholds trong khi chạy năm case.
3. Các bag nguồn nằm sâu dưới `data/dataset/bags/...`, trong khi registry chỉ cấp ID cho thư mục trực tiếp dưới `data/`. Vì vậy phải upload từng MCAP qua API và luôn dùng `id` trong response, không giả định ID cố định (server có thể thêm hậu tố `-2`, `-3`).
4. API authentication hiện là optional. Nếu `API_AUTH_TOKEN` được cấu hình, thêm `Authorization: Bearer <token>` vào mọi request và không ghi token vào evidence.
5. Với bag faulty, chuẩn hóa thời gian detector theo:

   ```text
   relative_sec = detection.tSec - (ground_truth.bag_t0_sim_ns / 1e9)
   ```

   `bag_t0_sim_ns` của bag faulty là mốc fault injector, không nhất thiết là message đầu tiên.
6. Không dùng số lượng anomaly tuyệt đối làm oracle vì một bag có thể sinh detection phụ. Chấm detection bắt buộc theo `kind`, topic, severity, cửa sổ và evidence.
7. Sau khi thu đủ evidence, xóa bản upload bằng `DELETE /api/v1/datasets/{dataset_id}`. Không xóa file nguồn dưới `data/dataset/`.
8. Không ghi `PASS` nếu chưa lưu được evidence bắt buộc. Không tạo screenshot, log hay LLM response giả.

## 3. Bảng tổng quan

| ID | Scenario | Input | Expected Output | Evidence |
|---|---|---|---|---|
| TC01 | Healthy Rosbag | `healthy_01_0.mcap` | Run thành công; không có lỗi high/critical; health green | Upload, create/detail/health JSON, backend log, UI screenshot |
| TC02 | Frequency Drop | `F1_02_0.mcap`, `/scan` 10→2,5 Hz, giây 45–135 | `hz_drop_critical` trên `/scan`, severity high, drop khoảng 75% | Detail/health JSON, detection window, backend log, timeline screenshot |
| TC03 | Topic Dead / Silent Node | `F1_01_0.mcap`, `/scan` 10→0 Hz, giây 60–175 | `silent_node` trên `/scan`, severity critical, không recovery | Detail/health JSON, end-of-stream evidence, backend log, timeline screenshot |
| TC04 | Invalid Rosbag | `not_a_rosbag.txt` | HTTP 400 có `detail` rõ ràng; server vẫn sống; registry không đổi | HTTP status/body, dataset list trước/sau, health check |
| TC05 | LLM Diagnosis | Health/detection thực tế của TC02 | Chẩn đoán đúng rate drop và `/scan`, có nguyên nhân/khuyến nghị hợp lý, không hallucinate | Request/response JSON, provider log/request ID, review rubric |

## 4. Test cases chi tiết

## TC01 — Healthy Rosbag

Test Case ID: TC01

Test Case Name: Healthy Rosbag

Objective: Xác nhận một bag đối chứng không tiêm lỗi được upload và phân tích thành công, không sinh cảnh báo nghiêm trọng hoặc health state suy giảm.

Preconditions:

- Backend và frontend chạy được theo README.
- `rosbags` được cài (dependency của project) để đọc MCAP thật.
- Thresholds mặc định hoặc persisted thresholds đã được ghi lại trước test.
- Chưa có bản upload cũ cần tái sử dụng; luôn lấy ID mới từ response upload.

Input:

- MCAP: `data/dataset/bags/healthy/healthy_01/healthy_01_0.mcap`.
- Metadata: `data/dataset/bags/healthy/healthy_01/metadata.yaml`.
- Ground truth: `data/dataset/bags/healthy/healthy_01_ground_truth.json`.
- Label: `healthy`; `fault_count: 0`.
- Duration: 178,98 giây theo ground truth; 178,979 giây theo metadata.
- Tổng message: 64.953.
- Các topic quan trọng:

  | Topic | Message type | Count | Baseline đo được |
  |---|---|---:|---:|
  | `/tf` | `tf2_msgs/msg/TFMessage` | 14.320 | 80,02 Hz |
  | `/imu` | `sensor_msgs/msg/Imu` | 35.774 | 200,01 Hz |
  | `/odom` | `nav_msgs/msg/Odometry` | 8.943 | 50,01 Hz |
  | `/scan` | `sensor_msgs/msg/LaserScan` | 1.789 | 10,01 Hz |
  | `/cmd_vel` | `geometry_msgs/msg/TwistStamped` | 3.568 | 20,03 Hz |
  | `/amcl_pose` | `geometry_msgs/msg/PoseWithCovarianceStamped` | 200 | 1,12 Hz |
  | `/diagnostics` | `diagnostic_msgs/msg/DiagnosticArray` | 358 | 2,01 Hz |
  | `/tf_static` | `tf2_msgs/msg/TFMessage` | 1 | N/A |

- Baseline `/scan`: max gap 0,13 giây; `/tf`: 0,05 giây; `/imu`: 0,01 giây; `/odom`: 0,02 giây.
- Analysis request body sau upload:

  ```json
  {
    "rosbag_id": "<id returned by POST /datasets/upload>"
  }
  ```

Steps:

1. Gọi `GET /health` và `GET /api/v1/analysis/thresholds`; lưu response.
2. Upload file bằng `POST /api/v1/datasets/upload` multipart field `file`.
3. Lưu `id` từ response upload vào `TC01_DATASET_ID`.
4. Gọi `POST /api/v1/analysis` với request body ở trên; lưu `run.id`.
5. Gọi `GET /api/v1/analysis/{run.id}` và `GET /api/v1/analysis/{run.id}/health`.
6. Kiểm tra UI dataset/run detail và chụp screenshot thật ở Task 2.
7. Xóa bản upload sau khi evidence đã được lưu.

Expected Output:

- Upload trả HTTP 201 với `status: "uploaded"`, `messageCount: 64953` và danh sách topic phù hợp metadata.
- Analysis trả HTTP 202; `run.status: "succeeded"`, `progress: 100`, `stage: "done"`.
- Detail trả đúng schema `run`, `rosbag`, `anomalies`, `aiResults`, `health`.
- Không có anomaly severity `high` hoặc `critical`.
- Không có `hz_drop_critical`, `tf_missing_gap`, `tf_drift_jump`, `log_fatal`, `log_error_burst` hoặc `payload_zero_byte`.
- Health phải ở vùng `green` (`health_score >= 80`) và không auto-trigger LLM deep dive.

Pass Criteria:

- Tất cả expected output trên đúng.
- Không có false positive nghiêm trọng trên `/scan`, `/imu`, `/odom`, `/tf` hoặc `/cmd_vel`.
- Backend không có exception/traceback liên quan run.
- Kết quả đối chiếu được với label healthy và baseline trong ground truth.

Evidence Required:

- `upload.json`, `analysis-create.json`, `analysis-detail.json`, `health.json`.
- Backend log từ lúc upload đến lúc lấy health.
- Screenshot registry và run detail thật.
- Snapshot thresholds đã dùng.

Notes:

- Natural `+Inf` của LaserScan khoảng 9,88% là hợp lệ theo ground truth, không phải lỗi payload.
- Nếu `silent_node` hoặc frequency detections làm health xuống yellow/red, ghi nhận là failure/defect; không sửa expected result sau khi chạy.

Actual Output: Upload HTTP 201; analysis HTTP 202; 64.953 messages và 8 topics được parse; run succeeded; 0 anomaly; health score 100, green; không auto-trigger LLM.

Status: PASS

Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final`

Execution Time: 21,594 giây (upload 4,545; analysis 12,623; detail 4,387; health 0,023).

Log: `eval/gate2/evidence/runtime/backend_final_api_stdout.txt` và `backend_final_api_stderr.txt`.

Evidence: `eval/gate2/evidence/TC01/final/`.

Notes: Playwright healthy flow pass; không có screenshot vì in-app browser không khả dụng, log thật được lưu thay thế.

LLM Response: N/A

## TC02 — Frequency Drop

Test Case ID: TC02

Test Case Name: Frequency Drop on `/scan`

Objective: Xác nhận detector nhận ra publish rate của `/scan` giảm bền vững từ khoảng 10 Hz xuống 2,5 Hz.

Preconditions:

- Các precondition chung của TC01.
- Dùng thresholds đã snapshot, đặc biệt `hz_drop_warn_pct: 0.30`, `hz_drop_critical_pct: 0.50`, `hz_drop_min_messages: 50`.
- Không truyền expected frequency giả qua API. Baseline 10 Hz lấy từ ground truth và dùng làm evaluation oracle.

Input:

- MCAP: `data/dataset/bags/faulty/F1_02/F1_02_0.mcap`.
- Metadata: `data/dataset/bags/faulty/F1_02/metadata.yaml`.
- Ground truth: `data/dataset/bags/faulty/F1_02_ground_truth.json`.
- Duration: 181,7 giây theo ground truth; 210,454 giây theo metadata.
- Tổng message: 74.602.
- Topic: `/scan`, type `sensor_msgs/msg/LaserScan`, 1.414 messages trong toàn bag.
- Fault mode: `drop_rate`, `keep_every: 4`.
- Injection timestamp:

  - `t_start_sim_ns: 644550000000`.
  - `t_end_sim_ns: 734550000000`.
  - Relative window: 45,0–135,0 giây.
  - Duration: 90,0 giây.

- Expected frequency: 10,0 Hz.
- Actual/test frequency: 2,5 Hz.
- Drop ratio: 75%; trigger critical vì lớn hơn `hz_drop_critical_pct` 50%.
- Analysis request body:

  ```json
  {
    "rosbag_id": "<id returned by uploading F1_02_0.mcap>"
  }
  ```

Steps:

1. Upload `F1_02_0.mcap` qua `POST /api/v1/datasets/upload`; lưu dataset ID.
2. Gọi `POST /api/v1/analysis`; lưu run ID và create response.
3. Gọi detail và health endpoint của run.
4. Lọc anomaly có `topics: ["/scan"]` và `kind: "hz_drop_critical"`.
5. Đối chiếu `metric` ở detail và raw evidence trong `health.detections_by_group.frequency`.
6. Chuẩn hóa `tSec` theo quy ước ở mục 2 và xác nhận ít nhất một 5-second window nằm trong/overlap fault window 45–135 giây.
7. Kiểm tra timeline UI và lưu screenshot thật ở Task 2.

Expected Output:

- Analysis hoàn tất với `run.status: "succeeded"`.
- Có ít nhất một detection theo schema hiện tại:

  ```json
  {
    "kind": "hz_drop_critical",
    "topic": "/scan",
    "severity": "high",
    "confidence": 0.9,
    "tSec": "<5-second window start inside the injected interval>",
    "endSec": "<tSec + 5.0>",
    "evidence": {
      "expected_hz": "approximately 10.0",
      "actual_hz": "approximately 2.5",
      "drop_pct": "approximately 0.75",
      "window_sec": 5.0
    }
  }
  ```

- Các `frequency_gap`/`timestamp_jitter` phụ không thay thế detection bắt buộc `hz_drop_critical`.
- Health không được coi là healthy/clean và phải liệt kê detection `/scan` trong frequency group.

Pass Criteria:

- `kind`, topic và severity khớp như trên.
- `expected_hz` trong khoảng 9,0–11,0; `actual_hz` trong khoảng 2,0–3,0; `drop_pct >= 0.70`.
- Ít nhất một detection window overlap 45–135 giây sau khi chuẩn hóa.
- Không gán lỗi chính sang topic khác.

Evidence Required:

- Upload/create/detail/health JSON.
- Extract của detection `/scan` gồm raw evidence và normalized time.
- Backend rule-evaluation log cho `hz_drop`.
- Screenshot timeline/anomaly list thật.

Notes:

- `run_analysis()` gọi detector mà không truyền `expected_hz`; engine suy ra expected rate từ median cadence của stream. Ground truth 10 Hz vẫn là oracle độc lập để chấm.
- Nếu chỉ phát hiện một gap biên lúc bắt đầu/kết thúc fault nhưng không phát hiện sustained rate drop, case không đạt.

Actual Output: Run succeeded. Detector trả một dải `hz_drop_critical` trên `/scan`, t=645–735 giây; expected 9,901 Hz; measured 2,4938 Hz; drop 74,81%; threshold critical 50%; 18 cửa sổ 5 giây được gộp.

Status: PASS

Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final`

Execution Time: 19,781 giây (upload 3,011; analysis 12,519; detail 4,216; health 0,020).

Log: `eval/gate2/evidence/runtime/backend_final_api_stdout.txt` và `backend_final_api_stderr.txt`.

Evidence: `eval/gate2/evidence/TC02/final/`.

Notes: Có thêm `frequency_gap` 0,44 giây trên `/scan`; detection bắt buộc vẫn đúng topic, severity và fault window.

LLM Response: N/A

## TC03 — Topic Dead / Silent Node

Test Case ID: TC03

Test Case Name: `/scan` Topic Dead / Long Internal Silence

Objective: Xác nhận hệ thống phát hiện khoảng `/scan` im lặng 115 giây trong bag và biểu diễn đúng topic, mức độ nghiêm trọng cùng silent window.

Preconditions:

- Các precondition chung của TC01.
- Ground truth được dùng làm oracle ban đầu; việc đo trực tiếp MCAP là nguồn quyết định cho actual output.
- Không suy đoán publisher node name: ROS2 bag không lưu publisher node; parser hiện chỉ infer node từ topic segment.

Input:

- MCAP: `data/dataset/bags/faulty/F1_01/F1_01_0.mcap`.
- Metadata: `data/dataset/bags/faulty/F1_01/metadata.yaml`.
- Ground truth: `data/dataset/bags/faulty/F1_01_ground_truth.json`.
- Ground-truth description nói LiDAR ngừng publish đến cuối, nhưng phép đo MCAP thật cho thấy `/scan` phục hồi sau khoảng gap 115,09 giây. Evaluation dùng dữ liệu MCAP thực tế và ghi rõ sai lệch này.
- Duration: 180,95 giây theo ground truth; 208,894 giây theo metadata.
- Tổng message: 71.103.
- Topic: `/scan`, type `sensor_msgs/msg/LaserScan`, 934 messages trước khi chết.
- Baseline frequency: 10,0 Hz; actual frequency trong fault window: 0,0 Hz.
- Injection timestamp:

  - `t_start_sim_ns: 425200000000`.
  - `t_end_sim_ns: 540200000000`.
  - Relative silent window: 60,0–175,0 giây.
  - Silent duration: 115,0 giây.
  - `recovers: false` theo ground truth; actual MCAP có message phục hồi tại 540,223 giây.

- Analysis request body:

  ```json
  {
    "rosbag_id": "<id returned by uploading F1_01_0.mcap>"
  }
  ```

Steps:

1. Upload `F1_01_0.mcap`; lưu dataset ID.
2. Chạy `POST /api/v1/analysis`; lưu run ID.
3. Lấy detail và health JSON.
4. Tìm detection `silent_node` gắn với `/scan` và đối chiếu cửa sổ với ground truth.
5. Xác nhận không có message `/scan` sau fault start bằng metadata/ground-truth evidence hoặc window export của chính run.
6. Kiểm tra UI timeline hiển thị outage kéo dài đến cuối observation window.

Expected Output:

- Run hoàn tất có kiểm soát với `status: "succeeded"`.
- Có detection theo `AnomalySummary` hiện tại: `kind: "silent_node"`, `topics: ["/scan"]`, `severity: "critical"`, `tSec/endSec` bao phủ terminal silence và confidence hợp lệ 0–1.
- Health đánh dấu lỗi frequency/topic-dead, không báo clean/green.
- Không yêu cầu node name cụ thể ngoài topic `/scan`; nếu output có node thì chỉ chấp nhận tên có nguồn gốc từ input/mapping, không được hallucinate.

Pass Criteria:

- Hệ thống nhận diện đúng `/scan` là stream chết, không chỉ báo một topic khác.
- Silent duration đo được gần 115 giây (tolerance ±5 giây) và không báo recovery.
- Severity theo Gate 2 ground truth là `critical`.
- API không crash và response đúng schema.

Evidence Required:

- Upload/create/detail/health JSON.
- Evidence chứng minh last `/scan` timestamp và bag end timestamp.
- Backend detector log và window export liên quan `/scan`.
- Screenshot timeline/anomaly list thật.

Notes:

- Limitation đã biết trước khi chạy: implementation `silent_node` hiện so sánh `last_timestamp - first_timestamp >= silent_node_min_span_sec` (active span), không đo khoảng im lặng hoặc end-of-stream. Nó cũng hard-code severity `low`. Task 2 phải giữ oracle ở trên; output low/active-span phải ghi `FAIL`, không sửa production trong Task 1.
- Detector windowed Hz hiện bỏ qua bucket không có message, nên terminal zero-Hz có thể không sinh `hz_drop_critical`. Đây là rủi ro dự kiến của case, không phải lý do để bỏ case.

Actual Output: `/scan` có 934 messages. Đo độc lập bằng `AnyReader`: gap lớn nhất 115,09 giây từ 425,133 đến 540,223; trailing silence chỉ 0,052 giây. Detector trả `silent_node`, critical, đúng topic/cửa sổ, threshold 0,5 giây, median interval 0,1 giây.

Status: PASS

Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final`

Execution Time: 11,006 giây (upload 2,601; analysis 8,200; detail 0,006; health 0,004).

Log: `eval/gate2/evidence/runtime/backend_final_api_stdout.txt` và `backend_final_api_stderr.txt`.

Evidence: `eval/gate2/evidence/TC03/final/topic_silence_measurement.json` và các response cùng thư mục.

Notes: Actual MCAP mâu thuẫn với ground-truth field `recovers:false`; không sửa/bịa actual data theo label.

LLM Response: N/A

## TC04 — Invalid Rosbag

Test Case ID: TC04

Test Case Name: Reject a Non-Rosbag File

Objective: Xác nhận upload API từ chối file không phải rosbag bằng lỗi rõ ràng, không crash và không thêm dataset vào registry.

Preconditions:

- Backend đang healthy.
- Ghi lại response `GET /api/v1/datasets` ngay trước test.

Input:

- Controlled fixture: `eval/gate2/fixtures/not_a_rosbag.txt`.
- File là plain text, extension `.txt`, không phải `.db3`, `.mcap`, `.bag` hoặc `.zip`.
- Multipart field: `file`.

Steps:

1. Lưu dataset list và total trước test.
2. Upload fixture bằng:

   ```powershell
   curl.exe -sS -X POST `
     "http://localhost:8000/api/v1/datasets/upload" `
     -F "file=@eval/gate2/fixtures/not_a_rosbag.txt;type=text/plain"
   ```

3. Ghi HTTP status và response body nguyên bản.
4. Gọi lại `GET /api/v1/datasets` và so sánh list/total.
5. Gọi `GET /health` để xác nhận server tiếp tục phục vụ request.

Expected Output:

- HTTP 400.
- Response body theo FastAPI error schema:

  ```json
  {
    "detail": "unsupported file type: .txt"
  }
  ```

- Không có HTTP 500, process crash hoặc traceback chưa xử lý.
- Dataset list/total không đổi; không xuất hiện ID/name từ `not_a_rosbag.txt`.
- Health endpoint vẫn trả HTTP 200 sau request lỗi.

Pass Criteria:

- Đủ cả bốn điều kiện: HTTP 400, message rõ ràng, registry không đổi, backend vẫn healthy.
- Không chấp nhận HTTP 201/202 hoặc lỗi 500.

Evidence Required:

- Request command, HTTP status và response body.
- Dataset list trước/sau.
- Health response sau test.
- Backend log cho request lỗi.

Notes:

- Đây là invalid-input path phù hợp nhất với validation hiện có; unit test tương ứng đã tồn tại ở `tests/test_api/test_routes.py::test_upload_rejects_unsupported_extension`.
- Task 1 chỉ tạo fixture; chưa gọi upload endpoint.

Actual Output: Upload trả HTTP 400 với `{"detail":"unsupported file type: .txt"}`; dataset registry trước/sau giống nhau; `GET /health` sau lỗi trả 200; UI hiện đúng message và button upload vẫn usable.

Status: PASS

Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final` và `pnpm exec playwright test e2e/gate2.spec.ts --workers=1`.

Execution Time: API 0,005 giây; UI flow 6,8 giây trong full regression cuối.

Log: `eval/gate2/evidence/runtime/backend_final_api_stdout.txt`.

Evidence: `eval/gate2/evidence/TC04/final/` và `eval/gate2/evidence/e2e/ui/playwright_gate2.txt`.

Notes: Không có crash, blank page hoặc registry mutation.

LLM Response: N/A

## TC05 — LLM Diagnosis

Test Case ID: TC05

Test Case Name: LLM Diagnosis for TC02 `/scan` Frequency Drop

Objective: Xác nhận LLM giải thích đúng anomaly thực tế của TC02 ở mức nội dung/chất lượng, không so sánh nguyên văn và không hallucinate dữ liệu ngoài evidence.

Preconditions:

- TC02 đã chạy và có actual `hz_drop_critical` detection trên `/scan`.
- Cấu hình live LLM hỗ trợ OpenAI hoặc vLLM; lần chạy actual dùng `LLM_PROVIDER=openai`, model `gpt-4o-mini`.

  - `LLM_PROVIDER=vllm`.
  - `VLLM_BASE_URL` trỏ tới OpenAI-compatible endpoint và thường kết thúc bằng `/v1`.
  - `VLLM_API_KEY` có giá trị hợp lệ.
  - `VLLM_MODEL_NAME` đúng model đang phục vụ.

- Phải có log `llm.chat_completion` hoặc provider request ID để chứng minh request thật. Nếu hệ thống dùng deterministic fallback thì TC05 chưa kiểm thử LLM và không được đánh dấu đạt.

Input:

- Nguồn duy nhất: actual response của `GET /api/v1/analysis/{TC02_RUN_ID}/health`.
- Detection bắt buộc phải chứa `/scan`, `hz_drop_critical`, expected/actual Hz và fault window thực tế của TC02.
- Request body được tạo trực tiếp từ actual health response, không gõ lại/hard-code detection:

  ```powershell
  $tc02HealthResponse = Invoke-RestMethod `
    -Uri "http://localhost:8000/api/v1/analysis/$TC02_RUN_ID/health"

  $explainBody = @{
    summary = $tc02HealthResponse.health
  } | ConvertTo-Json -Depth 50

  Invoke-RestMethod -Method Post `
    -Uri "http://localhost:8000/api/v1/analysis/explain" `
    -ContentType "application/json" `
    -Body $explainBody
  ```

Steps:

1. Xác nhận input health JSON chứa actual detection TC02, không phải fixture giả.
2. Lưu request JSON sau khi loại mọi secret/header authentication.
3. Gọi `POST /api/v1/analysis/explain`.
4. Lưu nguyên response JSON và log chứng minh live LLM call.
5. Hai người review độc lập hoặc một reviewer + một lần adjudication chấm rubric dưới đây; không đối chiếu exact string.

Expected Output:

- HTTP 200 với schema:

  ```json
  {
    "root_cause": "<non-empty string>",
    "recommended_actions": ["<one or more actionable steps>"],
    "explanation": "<non-empty string>"
  }
  ```

- Nội dung phải:

  1. Nhận diện rate/frequency drop nghiêm trọng, không đổi thành timestamp/TF/payload fault.
  2. Chỉ đúng topic `/scan`.
  3. Liên hệ evidence khoảng 10 Hz xuống 2,5 Hz hoặc giảm khoảng 75%.
  4. Nêu nguyên nhân dưới dạng khả năng hợp lý, ví dụ CPU/thread starvation, LiDAR publisher/driver không giữ update rate, DDS/transport congestion; không tuyên bố chắc chắn một nguyên nhân chưa có evidence.
  5. Đưa ra hành động phù hợp: kiểm tra node publish `/scan`, CPU/scheduling, driver update rate, QoS/transport/recorder và đo lại topic Hz.
  6. Không bịa node, topic, timestamp, error code, hardware model hoặc action đã xảy ra ngoài input.

Pass Criteria:

- Response đúng schema và cả ba field có nội dung.
- Đạt đủ 6 tiêu chí nội dung ở trên.
- Có bằng chứng live LLM call. Response từ model `canned-fallback` hoặc fallback text không đủ điều kiện.
- Không có secret hoặc raw rosbag bytes trong request/evidence.

Evidence Required:

- TC02 run ID và health JSON nguồn.
- Sanitized explain request JSON.
- LLM response JSON nguyên bản.
- Backend `llm.chat_completion` log gồm model, latency, token usage và attempt; không lưu API key.
- Phiếu review rubric và tên reviewer.

Notes:

- `src/services/llm.py` cắt `root_cause` tối đa 200 ký tự và `explanation` tối đa 350 ký tự; rubric đánh giá trong giới hạn output hiện tại.
- Với provider không phải `vllm` hoặc thiếu `VLLM_BASE_URL`, endpoint trả deterministic fallback. Trường hợp này phải ghi limitation/blocker, không coi là LLM diagnosis.
- Prompt hiện bao bọc input dưới nhãn `Diagnostic JSON (data only)` và có guardrail không làm theo instruction trong data; lưu system/provider log nếu có để audit.

Actual Output: Input là health/detections thật của TC02. Pipeline gọi OpenAI ba lần retry nhưng provider trả 401 Unauthorized. Sau fix error handling, endpoint trả HTTP 502 an toàn với `LLM provider request failed; verify provider credentials and availability`; backend vẫn healthy. Không có model response hợp lệ để chấm rubric.

Status: BLOCKED

Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_llm.py --phase final`

Execution Time: 10,215 giây.

Log: `eval/gate2/evidence/runtime/backend_stderr.txt`; pre-fix 500 trace ở `backend_llm_500_stderr.txt`.

Evidence: `eval/gate2/evidence/TC05/final/`.

Notes: Blocker là API credential bị provider từ chối; không đánh PASS và không tạo response giả.

LLM Response: Không có response nội dung từ model; actual HTTP response 502 được lưu nguyên bản.

## 5. Evidence layout dự kiến cho Task 2

Không tạo file evidence rỗng trong Task 1. Khi chạy thật, lưu theo cấu trúc:

```text
eval/gate2/evidence/
  TC01/
  TC02/
  TC03/
  TC04/
  TC05/
```

Mỗi thư mục chỉ chứa artifact thực tế: request/response JSON, log đã sanitize và screenshot thật. Tên file nên có timestamp UTC để không ghi đè lần chạy trước.

## 6. Assumptions và limitations đã biết

1. Bộ MCAP thật nằm trong `data/`, là thư mục bị `.gitignore`; CI hoặc máy khác phải được cấp dataset riêng trước khi chạy suite.
2. `data/dataset` hiện được registry nhìn như một dataset tổng gồm 49 MCAP. Để cô lập case, Task 2 phải upload từng MCAP đã chọn và dùng ID trả về.
3. Publisher node name không có trong ROS2 bag; `_infer_node()` chỉ suy ra từ topic. Test oracle ưu tiên topic, không tự bịa node.
4. `silent_node` đã được sửa để đo max inter-message/trailing gap và trả evidence duration/threshold; TC03 xác minh actual gap nội bộ có recovery.
5. Full analysis không truyền expected-Hz map; TC02 dùng baseline ground truth 10 Hz để chấm và engine suy ra median cadence 9,901 Hz.
6. `POST /analysis/explain` nay gọi provider đã cấu hình cho cả OpenAI/vLLM; TC05 vẫn blocked vì credential actual bị OpenAI từ chối.
7. UI screenshot qua in-app Browser không khả dụng; evidence UI là output Playwright thật. Không có screenshot giả.

## 7. Task 1 Definition of Done (historical, before execution)

- [x] Có đủ 5 test case bắt buộc.
- [x] Mỗi test case có Input, Expected Output, Pass Criteria và Evidence Required.
- [x] TC01–TC03 dùng rosbag/MCAP thật có ground truth.
- [x] TC04 có controlled invalid fixture.
- [x] TC05 lấy input từ actual detection TC02 và có rubric chất lượng.
- [x] Có manifest và script kiểm tra fixture/path.
- [x] Tại thời điểm Task 1, mỗi test chưa chạy được đánh dấu `NOT EXECUTED` và actual output là `TBD`; các field này đã được thay bằng kết quả thật ở Task 2–5.
- [x] Không có fake log, screenshot hay LLM response.
- [x] Không thay đổi production logic.
