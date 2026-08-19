# Gate 2 Evaluation Evidence

## 1. Gate 2 Objective

Gate 2 aims to demonstrate that the primary rosbag analysis and diagnosis user flow works with reproducible test evidence. Kết luận của lần chạy này là **PARTIAL**: bốn test pipeline/API pass, ba UI flow pass ở mức ứng dụng, nhưng live LLM diagnosis bị chặn vì credential OpenAI hiện tại trả HTTP 401.

## 2. Test Environment

| Thành phần | Actual |
|---|---|
| Branch | `test/gate2-e2e-evaluation` |
| Base commit | `aa7726ceb474073adb6e9f785d521f1a77dc7283` plus uncommitted Gate 2 changes |
| Test date | 2026-08-12, Asia/Saigon |
| OS | Microsoft Windows 11 Home Single Language, 10.0.26200, 64-bit |
| Python | 3.13.9 |
| ROS2 | CLI không có trong môi trường (`ros2` command not found) |
| Backend | FastAPI 0.140.1, Uvicorn 0.51.0, `http://localhost:8000` |
| Frontend | Next.js 16.2.6, Node 24.18.1, pnpm 11.21.0, `http://localhost:3000` |
| UI runner | Playwright 1.62.1, Chromium Headless Shell 151.0.7922.34 |
| LLM | OpenAI, model configured as `gpt-4o-mini`; provider rejected configured credential |

Chi tiết máy được lưu tại `eval/gate2/environment.md`. Backend evaluation dùng database riêng `eval/gate2/evidence/runtime/runs.db` để không trộn với app DB thông thường.

## 3. Test Case Summary

| ID | Scenario | Expected | Actual | Status | Evidence |
|---|---|---|---|---|---|
| TC01 | Healthy rosbag | Parse thành công, không critical anomaly, health green | 64.953 messages, 8 topics, 0 anomaly, health 100/green | PASS | `eval/gate2/evidence/TC01/final/` |
| TC02 | `/scan` frequency drop | 10 Hz xuống khoảng 2,5 Hz; high/critical detector band | expected 9,901 Hz, measured 2,4938 Hz, drop 74,81%, `hz_drop_critical` t=645–735 | PASS | `eval/gate2/evidence/TC02/final/` |
| TC03 | `/scan` silent | Khoảng im lặng khoảng 115 giây, critical | actual max gap 115,09 giây, t=425,133–540,223, threshold 0,5 | PASS | `eval/gate2/evidence/TC03/final/` |
| TC04 | Invalid input | HTTP 400 rõ ràng, registry/server ổn định | HTTP 400, `unsupported file type: .txt`, registry unchanged, health 200 | PASS | `eval/gate2/evidence/TC04/final/` |
| TC05 | Live LLM diagnosis | HTTP 200 và diagnosis thật từ actual TC02 output | OpenAI 401; app trả safe HTTP 502 sau fix; không có model response | BLOCKED | `eval/gate2/evidence/TC05/final/` |

## 4. Detailed Results

### TC01 — Healthy Rosbag

- Input: `data/dataset/bags/healthy/healthy_01/healthy_01_0.mcap` (29.326.829 bytes).
- Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final`.
- Expected Output: run succeeded, 64.953 messages/8 topics, không high hoặc critical anomaly, health green.
- Actual Output: upload 201, analysis 202, run succeeded, 64.953 messages, 8 topics, anomaly count 0, health score 100, `trigger_llm_deep_dive=false`.
- Execution Time: 21,594 giây; upload 4,545; analysis 12,623; detail 4,387; health 0,023.
- Status: **PASS**.
- Evidence: `TC01/final/input.json`, `upload_response.json`, `analysis_create_response.json`, `analysis_detail_response.json`, `health_response.json`, `result.json`.
- Notes: baseline trước fix là FAIL vì 85 anomaly giả; final run là phân tích mới sau fix.

### TC02 — Frequency Drop

- Input: `data/dataset/bags/faulty/F1_02/F1_02_0.mcap` (32.124.946 bytes).
- Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final`.
- Expected Output: `/scan` khoảng 10 Hz xuống 2,5 Hz trong fault window, severity high.
- Actual Output: `hz_drop_critical`, topic `/scan`, severity high, expected 9,901 Hz, measured 2,4938 Hz, drop 0,7481; detector gộp 18 cửa sổ 5 giây thành dải 645–735 giây. Có thêm `frequency_gap` 0,44 giây với threshold 0,1515.
- Execution Time: 19,781 giây.
- Status: **PASS**.
- Evidence: `eval/gate2/evidence/TC02/final/` và summary `api_execution_final.json`.
- Notes: detector dùng median cadence của actual stream; ground truth 10 Hz là oracle độc lập.

### TC03 — Topic Dead / Silent Node

- Input: `data/dataset/bags/faulty/F1_01/F1_01_0.mcap` (30.260.438 bytes).
- Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final`.
- Expected Output: `/scan` silent khoảng 115 giây và severity critical.
- Actual Output: phép đo độc lập bằng `rosbags.highlevel.AnyReader` thấy 934 `/scan` messages, max gap 115,09 giây từ 425,133 đến 540,223; tail gap chỉ 0,052 giây. Detector trả đúng `silent_node`, critical, `silent_duration_sec=115.09`, threshold 0,5, median interval 0,1.
- Execution Time: 11,006 giây.
- Status: **PASS**.
- Evidence: `eval/gate2/evidence/TC03/final/topic_silence_measurement.json` và response JSON cùng thư mục.
- Notes: ground truth ghi `recovers:false`, nhưng MCAP thật có recovery tại 540,223; actual MCAP được ưu tiên và sai lệch được ghi công khai.

### TC04 — Invalid Rosbag

- Input: `eval/gate2/fixtures/not_a_rosbag.txt`.
- Execution Command: runner API ở trên và `pnpm exec playwright test e2e/gate2.spec.ts --workers=1`.
- Expected Output: 400 rõ ràng, không mutation/crash, UI usable.
- Actual Output: HTTP 400, body `{"detail":"unsupported file type: .txt"}`; dataset list trước/sau bằng nhau; backend health sau request là 200; UI hiển thị error detail và upload button enabled.
- Execution Time: API 0,005 giây; UI invalid flow 1,9 giây ở run Gate 2 cuối.
- Status: **PASS**.
- Evidence: `eval/gate2/evidence/TC04/final/`, `eval/gate2/evidence/e2e/ui/playwright_gate2.txt`.

### TC05 — LLM Diagnosis

- Input: nguyên actual health/detections TC02 trong `TC05/final/tc02_health_input.json`.
- Execution Command: `.\.venv\Scripts\python.exe scripts\test_gate2_llm.py --phase final`.
- Expected Output: HTTP 200 với root cause, explanation và actions do live model tạo.
- Actual Output: request đã đi tới OpenAI và retry 3 lần; provider trả 401 Unauthorized. Pre-fix app rò thành 500; post-fix endpoint trả HTTP 502 với message an toàn. Backend health vẫn 200.
- Execution Time: 10,215 giây.
- Status: **BLOCKED**.
- Evidence: `llm_request.json`, `llm_response.json`, `execution.json`, `runtime/backend_stderr.txt`, và pre-fix trace `backend_llm_500_stderr.txt`.
- Notes: không có response nội dung từ model nên không chấm rubric và không tạo response thay thế để đánh PASS.

## 5. End-to-End Evaluation

| Flow | Actual result | Status |
|---|---|---|
| Healthy | UI upload MCAP thật, button disabled trong processing, reload run mới, health 100, 0 detections, “System Healthy” | PASS |
| Anomaly | UI upload/analyze F1_02, render `/scan` severe rate drop và health 69,2; live LLM bị 401 nhưng UI hiển thị fallback có nhãn và đúng detection context | BLOCKED (live LLM step) |
| Invalid file | UI hiện backend validation detail; page và upload action tiếp tục usable | PASS |

Playwright Gate 2: **3 passed in 39,2s**. Full Playwright regression: **21 passed in 1,6m**. Không có in-app browser instance nên không tạo screenshot; không có screenshot giả.

## 6. API Evaluation

| API | Method | Input | Actual Response | Status |
|---|---|---|---|---|
| `/health` | GET | none | 200, `{"status":"ok","env":"test"}` | PASS |
| `/api/v1/datasets` | GET | none | 200 dataset list | PASS |
| `/api/v1/datasets/upload` | POST | healthy/F1 MCAP multipart | 201 with parsed metadata/topics | PASS |
| `/api/v1/datasets/upload` | POST | invalid `.txt` | 400 with clear detail | PASS |
| `/api/v1/analysis` | POST | actual uploaded dataset ID | 202 with succeeded run (implementation executes synchronously) | PASS |
| `/api/v1/analysis/{run_id}` | GET | TC01–TC03 run ID | 200 structured run/rosbag/anomalies/AI result | PASS |
| `/api/v1/analysis/{run_id}/health` | GET | TC01–TC03 run ID | 200 structured health and raw detections | PASS |
| `/api/v1/analysis/{run_id}/export/windows` | GET | UI active run, 5s windows | 200 NDJSON consumed into 8 lanes | PASS |
| `/api/v1/analysis/thresholds` | GET/POST | 0,08 → 0,05 → 0,08 | 200; UI persisted and reset value | PASS |
| `/api/v1/analysis/explain` | POST | actual TC02 health JSON | 502 because upstream OpenAI rejected credential | BLOCKED |
| `/api/v1/datasets/{id}` | DELETE | only temporary uploads created by tests | 200; source bags preserved | PASS |

Architecture không có endpoint polling status riêng: `POST /analysis` chạy analysis trong worker thread rồi trả run hoàn tất với HTTP 202. Evaluation không tự bịa một polling endpoint.

## 7. UI Evaluation

| UI Feature | Test | Result | Status |
|---|---|---|---|
| Rosbag upload | Upload healthy và F1_02 MCAP thật | Toast success, row parsed/visible | PASS |
| File validation | Upload `.txt` | Backend detail hiện trên toast | PASS |
| Processing state | Click Analyze | Button disabled tới khi response/navigation | PASS |
| Healthy result | Health panel | HS 100, 0 detections, System Healthy | PASS |
| Anomaly display | F1_02 analysis | `/scan` severe publish rate drop visible | PASS |
| Diagnosis display | Auto deep-dive | Live call attempted; labelled rule-based fallback shown with actual anomalies | BLOCKED for live model, PASS for graceful UI |
| Error state | Invalid upload và LLM 502 | No blank page/crash; actions remain usable | PASS |
| Threshold controls | Edit/save/reset frequency gap threshold | GET/POST 200; UI value persisted | PASS |
| Navigation/console stability | 7 pages in Playwright | No page errors; full suite 21/21 | PASS |

## 8. LLM Diagnosis Evidence

- Detection Input: TC02 health score 69,2 with actual `/scan` `frequency_gap` and `hz_drop_critical` evidence, plus other actual detections; preserved verbatim in `tc02_health_input.json`.
- LLM Prompt/Input: sanitized JSON body in `llm_request.json`; no key/header stored.
- Actual LLM Response: **none**. Provider returned 401 before model content; application response is HTTP 502 in `llm_response.json`.
- Evaluation:
  - Correct anomaly identification: not assessable.
  - Correct topic/node: not assessable.
  - Reasonable root cause: not assessable.
  - Useful troubleshooting: not assessable.
  - Hallucination: not assessable.
- Result: **BLOCKED**, not PASS.

## 9. Bugs Found and Fixed

| Bug | Root Cause | Fix | Verification |
|---|---|---|---|
| BUG-G2-01 Healthy false positives | Hz baseline used fastest partial/burst window; cadence rules applied to event/status topics; adjacent windows became many anomalies | Correct `(count-1)/span`, infer median cadence, skip bursty/event-driven topics without explicit baseline, merge adjacent drop windows | TC01 baseline FAIL with 85 anomalies → final PASS with 0; TC02 still PASS |
| BUG-G2-02 Silent node was active span | Rule measured first-to-last active time and hard-coded low severity | Measure largest inter-message/trailing gap; store last/resume/duration/threshold; critical severity | TC03 final exact 115,09s PASS; relevant unit/API tests pass |
| BUG-G2-03 OpenAI explain never used + upstream leaked 500 | `explain_diagnostics` only allowed vLLM branch; API did not catch `httpx.HTTPError` | Use any valid configured provider; map upstream failures to safe 502 | Unit/API 43 pass; actual 401 now becomes 502 and backend remains healthy |
| BUG-G2-04 UI deep-dive was client-only and used stale empty anomalies | Panel never called backend; auto effect fired before anomaly props loaded | Call `/analysis/explain`, wait for detection data, reset per run, label fallback explicitly | Anomaly Playwright failed before fix, then Gate 2 3/3 and full 21/21 pass |
| BUG-G2-05 Analyze navigated to stale run | client state kept old one-shot overview after analysis | Reload `/analysis` after synchronous analysis completion | Healthy/anomaly UI tests display newly created run |
| BUG-G2-06 Invalid upload hid useful detail | frontend replaced backend body with status-only message | Parse FastAPI `detail` and propagate it | Invalid UI flow PASS with exact `.txt` message |
| BUG-G2-07 Threshold controls not rendered | state and API calls existed but JSX control was absent | Add frequency/silent inputs and save action | Threshold blocker re-test 8/8; full Playwright 21/21 |

## 10. Known Limitations

1. Live LLM content remains blocked until a valid provider credential/service is supplied.
2. ROS2 CLI is not installed. Actual MCAP parsing still ran through the project's Python `rosbags` production path.
3. In-app Browser skill had no available browser instance. Playwright Chromium produced real UI automation logs, but no manual screenshot was fabricated.
4. Ground-truth JSON for F1_01 says no recovery, while actual MCAP contains recovery after 115,09 seconds.
5. `/analysis` returns 202 only after synchronous work completes; there is no separate status polling API.
6. Full-repo Ruff is not clean because of 55 pre-existing HILT/debug lint findings outside Gate 2 files. Ruff on all Gate 2-modified Python files passes.

## 11. Gate 2 Conclusion

**Gate 2 Result: PARTIAL.** Rosbag ingest, parsing, metric extraction, healthy/anomaly detection, structured API results, invalid-input handling, frontend result rendering, UI fallback behavior, and regression suites have reproducible PASS evidence. Gate 2 cannot be called fully PASS because TC05 did not receive a real model response; the actual provider rejected the configured credential.
