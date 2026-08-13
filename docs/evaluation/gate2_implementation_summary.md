# Gate 2 Implementation Summary

## 1. Tôi đã làm gì?

1. Kiểm tra branch `test/gate2-e2e-evaluation`, `git status`, `git diff`, và đọc artifacts Task 1.
2. Xác minh môi trường, backend/frontend đang chạy, ROS2 CLI và cấu hình LLM.
3. Tạo runner có thể lặp lại cho API TC01–TC04 và lưu raw response/evidence.
4. Chạy baseline thật để không đoán defect: TC01/TC03 fail, TC02/TC04 pass.
5. Sửa detector healthy false-positive và silent-gap semantics; chạy unit test rồi re-test MCAP thật.
6. Tạo runner TC05 dùng trực tiếp health JSON của TC02, gọi provider thật và lưu response/error thật.
7. Sửa OpenAI provider routing và xử lý upstream failure 500 → safe 502. TC05 vẫn được đánh BLOCKED vì provider trả 401.
8. Kiểm thử UI. In-app Browser không có instance; cài đúng Playwright Chromium của repo và chạy automation thật.
9. Sửa upload error, stale analysis navigation, live deep-dive wiring, stale anomaly closure, và threshold panel.
10. Re-test sau từng fix; cuối cùng backend 232/232, frontend unit 26/26, Playwright 21/21.
11. Xóa 13+2 dataset upload tạm bằng API, giữ nguyên các MCAP nguồn và evidence.
12. Cập nhật test case Task 1, manifest, tài liệu evidence và tài liệu giải thích này.

## 2. Tôi đã làm như thế nào?

Architecture thật của repository:

```text
MCAP / DB3 / ZIP
↓
POST /api/v1/datasets/upload
↓
src.services.experiments.save_uploaded_rosbag
↓
dataset registry + rosbag metadata
↓
POST /api/v1/analysis
↓
src.services.analysis.run_analysis
↓
src.services.bag_stream.iter_bag_messages (rosbags AnyReader cho MCAP)
↓
src.services.diagnostics.detect_anomalies
↓
structured detections + health summary
↓
src.services.run_store (SQLite)
↓
GET detail / health / window export
↓
Next.js UI: health, detection list, timeline, diagnosis panel
↓
POST /api/v1/analysis/explain
↓
src.services.llm.chat_completion → configured OpenAI/vLLM provider
↓
live response hoặc fallback được gắn nhãn rõ ràng
```

Input của TC01–TC03 là MCAP thật trong `data/dataset/bags`. Runner upload file, lấy đúng dataset ID từ response, tạo analysis, lấy detail/health, so expected với actual, lưu JSON, rồi DELETE bản upload tạm. TC03 còn tự đọc timestamps `/scan` bằng `AnyReader` để detector không tự chấm chính nó. TC05 đọc file health actual của TC02, không hard-code detection.

Frontend gọi cùng backend endpoints qua `frontend/lib/api.ts`; Next.js rewrite `/api/v1/*` tới FastAPI. `POST /analysis` trong architecture hiện tại chạy work trong thread và chỉ trả 202 sau khi run đã hoàn tất, vì vậy không có endpoint status polling riêng.

## 3. Giải thích từng file đã thêm

| File / nhóm file | Loại | Mục đích | Nội dung chính |
|---|---|---|---|
| `docs/evaluation/gate2_test_cases.md` | New (Task 1, updated) | Test specification + actual results | TC01–TC05 input, expected, actual, command, timing, status, evidence |
| `docs/evaluation/gate2_evaluation_evidence.md` | New | Gate 2 report chính | Environment, test/API/UI/LLM evidence, bugs, limitations, conclusion |
| `docs/evaluation/gate2_implementation_summary.md` | New | Giải thích cho người chưa đọc code | Flow, files, commands, bugs, cách chạy lại |
| `eval/gate2/environment.md` | New/untracked artifact updated | Snapshot môi trường | OS/runtime/backend/frontend/LLM/ROS2 facts |
| `eval/gate2/fixtures/manifest.json` | New | Machine-readable suite manifest | Paths, ground truth, actual case statuses |
| `eval/gate2/fixtures/not_a_rosbag.txt` | New | TC04 controlled invalid input | Plain text có unsupported extension |
| `eval/gate2/validate_fixtures.py` | New | Validate inputs/docs | Kiểm tra path, ground truth, case IDs, manifest/doc status |
| `scripts/test_gate2_api.py` | New | Reproducible TC01–TC04 executor | Upload/create/detail/health, independent silence measurement, verdict, cleanup |
| `scripts/test_gate2_llm.py` | New | Reproducible TC05 executor | Đọc actual TC02 health, POST explain, lưu exact HTTP response/error |
| `frontend/e2e/gate2.spec.ts` | New | UI Gate 2 flows | Healthy, anomaly/fallback, invalid input; processing button state |
| `eval/gate2/evidence/api_execution_pre_fix.json` | New evidence | Baseline | TC01/TC03 failure và actual pre-fix output |
| `eval/gate2/evidence/api_execution_post_detector_fix.json` | New evidence | Intermediate re-test | Kết quả sau sửa detector vòng một |
| `eval/gate2/evidence/api_execution_final.json` | New evidence | Final API summary | TC01–TC04 final PASS output/timing |
| `eval/gate2/evidence/TC01/{pre_fix,post_detector_fix,final}/input.json` | New evidence | Input identity | Path, size, SHA-256 |
| `eval/gate2/evidence/TC01/{pre_fix,post_detector_fix,final}/{upload_response,analysis_create_response,analysis_detail_response,health_response,result,cleanup_response}.json` | New evidence | TC01 lifecycle | Raw HTTP captures, verdict, cleanup |
| `eval/gate2/evidence/TC02/{pre_fix,post_detector_fix,final}/input.json` | New evidence | Input identity | F1_02 path, size, SHA-256 |
| `eval/gate2/evidence/TC02/{pre_fix,post_detector_fix,final}/{upload_response,analysis_create_response,analysis_detail_response,health_response,result,cleanup_response}.json` | New evidence | TC02 lifecycle | Raw responses and extracted frequency evidence |
| `eval/gate2/evidence/TC03/{pre_fix,post_detector_fix,final}/input.json` | New evidence | Input identity | F1_01 path, size, SHA-256 |
| `eval/gate2/evidence/TC03/{pre_fix,post_detector_fix,final}/{upload_response,analysis_create_response,analysis_detail_response,health_response,result,cleanup_response}.json` | New evidence | TC03 lifecycle | Raw responses and detector verdict |
| `eval/gate2/evidence/TC03/pre_fix/topic_tail_measurement.json` | New evidence | Baseline measurement | Chỉ đo trailing gap, giúp phát hiện assumption sai |
| `eval/gate2/evidence/TC03/{post_detector_fix,final}/topic_silence_measurement.json` | New evidence | Independent oracle | Max internal gap, start/end, last timestamp, tail gap |
| `eval/gate2/evidence/TC04/{pre_fix,post_detector_fix,final}/{datasets_before,datasets_after,upload_response,backend_health_after,result}.json` | New evidence | Invalid-input proof | 400 response, no registry mutation, health remains 200 |
| `eval/gate2/evidence/TC05/{pre_fix,post_detector_fix,final}/tc02_health_input.json` | New evidence | Actual LLM input source | Unedited TC02 health response per phase |
| `eval/gate2/evidence/TC05/final/llm_request.json` | New evidence | Sanitized request | Exact summary sent to explain endpoint, no secret |
| `eval/gate2/evidence/TC05/final/llm_response.json` | New evidence | Exact actual response | Safe 502 body after provider 401 |
| `eval/gate2/evidence/TC05/final/execution.json` | New evidence | TC05 verdict facts | Timing, HTTP status, response-captured flags |
| `eval/gate2/evidence/runtime/backend_*stdout.txt` | New evidence | Backend request logs | Successful API phases and live UI requests |
| `eval/gate2/evidence/runtime/backend_*stderr.txt` | New evidence | Detector/LLM logs | Pre/post-fix diagnostics, 500 trace, final safe failure; no secret |
| `eval/gate2/evidence/runtime/runs.db` | New evidence | Isolated persisted runs | SQLite run/detection/review state used by evaluation backend |
| `eval/gate2/evidence/e2e/ui/playwright_gate2.txt` | New evidence | Final UI Gate 2 run | 3/3 passed |
| `eval/gate2/evidence/e2e/ui/playwright_gate2_browser_missing.txt` | New evidence | Environment blocker audit | First run failed because Chromium binary absent |
| `eval/gate2/evidence/e2e/ui/playwright_gate2_{assertion_refined,timeout_refined,stale_anomalies}.txt` | New evidence | Honest pre-fix history | Harness refinements and BUG-G2-04 reproduction |
| `eval/gate2/evidence/e2e/ui/playwright_blocker_retest.txt` | New evidence | Focused blocker re-test | 8/8 previously failing/stale UI tests pass |
| `eval/gate2/evidence/regression_backend_pytest.txt` | New evidence | Backend regression | 232 passed |
| `eval/gate2/evidence/regression_frontend_vitest.txt` | New evidence | Frontend unit regression | 26 passed |
| `eval/gate2/evidence/regression_frontend_playwright.txt` | New evidence | Full UI regression | 21 passed |
| `eval/gate2/evidence/regression_*_pre_fix.txt` và `regression_frontend_vitest_timeout.txt` | New evidence | Honest intermediate output | Fail/timeout trước khi fixes hoặc timeout adjustment |

Không có screenshot file: Browser skill không tìm thấy browser instance và không có ảnh giả được tạo.

## 4. Giải thích từng file đã sửa

| File | Thay đổi | Tại sao phải sửa | Ảnh hưởng |
|---|---|---|---|
| `src/services/diagnostics.py` | Tính Hz `(count-1)/span`; median cadence; bỏ cadence rule cho event topics; gộp adjacent Hz windows; silent rule đo gap thật; thêm structured evidence | TC01 có 85 false positives, TC03 chỉ đo active span/low severity | TC01 0 anomaly; TC02 một band đúng; TC03 exact 115,09s critical |
| `src/services/diagnostics_config.py` | Thêm `silent_node_gap_multiplier=5.0` | Cần threshold tương đối theo cadence topic | Silent detection có absolute + relative threshold |
| `src/services/llm.py` | Cho provider hợp lệ bất kỳ, gồm OpenAI, đi vào live chat | OpenAI config trước đây luôn nhận canned fallback | TC05 thực sự gọi provider; external credential vẫn blocked |
| `src/api/routes.py` | Catch `httpx.HTTPError` ở explain và trả safe 502 | OpenAI 401 làm FastAPI rò 500 traceback | App/API ổn định, message actionable |
| `frontend/lib/api.ts` | Map explain endpoint; giữ FastAPI upload `detail` | UI chưa gọi live explain và invalid error chỉ có status | Live attempt xảy ra; TC04 hiện đúng nguyên nhân |
| `frontend/lib/api.test.ts` | Test route mapping explain | Giữ contract frontend/backend | 16 API mapping tests pass |
| `frontend/components/health/llm-deep-dive-panel.tsx` | Gọi backend explain; labelled fallback; chờ anomalies; reset theo run | Panel client-only và fallback dùng stale empty list | Anomaly UI không còn kết luận sai healthy |
| `frontend/components/rav-console.tsx` | Reload analysis run mới; error handling; render threshold controls | Navigation giữ old overview/run; threshold state không có UI | E2E upload→result đúng; threshold GET/POST usable |
| `frontend/e2e/analysis.spec.ts` | Assert contract thật thay static mock sentence | Exact mock string không còn tồn tại ở real backend | Test agent conclusion vẫn kiểm tra root cause/evidence |
| `frontend/e2e/dashboard.spec.ts` | Assert latest run từ actual overview response | Test hard-code mock run | Chạy được với real runtime data |
| `frontend/e2e/datasets.spec.ts` | Assert/filter actual dataset response | Test hard-code mock filenames/site | Chạy được với current repository datasets |
| `tests/test_services/test_diagnostics.py` | Test silent gap, median-cadence Hz, OpenAI explain path | Bảo vệ semantics mới và regression | Detector/LLM unit tests pass |
| `tests/test_api/test_routes.py` | Test critical silent output, thresholds, safe 502 và dashboard counts | API assertions cũ phản ánh active-span low severity | Full backend 232/232 pass |

Các file đã modified trước khi Task 2 bắt đầu và được giữ nguyên, không được tính là implementation của tôi: `frontend/.npmrc`, `frontend/package.json`, `frontend/pnpm-lock.yaml`, `frontend/pnpm-workspace.yaml`, `frontend/tsconfig.tsbuildinfo`, `package.json`; untracked `.npmrc` cũng có sẵn từ đầu.

## 5. File đã xóa

No files deleted.

Qua API cleanup, tôi đã xóa 15 temporary dataset copies do UI test tạo (`healthy_01_0*`, `F1_02_0*`, `trip_upload*`). Chúng là bản upload có thể tạo lại; nguồn dưới `data/dataset/bags` và toàn bộ evidence vẫn nguyên vẹn.

## 6. Các command đã chạy

Các command quan trọng đã thực sự chạy:

```powershell
git branch --show-current
git status
git diff
git diff --stat

.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase pre_fix
.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase post_detector_fix
.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase final
.\.venv\Scripts\python.exe scripts\test_gate2_llm.py --phase final

.\.venv\Scripts\ruff.exe check <Gate-2 modified Python files>
.\.venv\Scripts\pytest.exe -q tests\test_services\test_diagnostics.py ... -o addopts=''
.\.venv\Scripts\pytest.exe -q -o addopts=''

pnpm exec playwright install chromium
pnpm lint
pnpm test
pnpm exec playwright test e2e/gate2.spec.ts --workers=1
pnpm exec playwright test --workers=1

.\.venv\Scripts\python.exe eval\gate2\validate_fixtures.py
```

Backend test server được chạy với:

```powershell
$env:RUN_DB_PATH='eval/gate2/evidence/runtime/runs.db'
$env:APP_ENV='test'
.\.venv\Scripts\python.exe -m uvicorn src.main:app --host 127.0.0.1 --port 8000
```

Temporary uploads được liệt kê chính xác bằng `GET /api/v1/datasets`, xóa từng ID qua `DELETE /api/v1/datasets/{id}`, rồi xác nhận chỉ còn ID `dataset`.

## 7. Kết quả của từng command

| Command | Result thực tế |
|---|---|
| `test_gate2_api.py --phase pre_fix` | Exit 1; TC01 FAIL, TC02 PASS, TC03 FAIL, TC04 PASS |
| `test_gate2_api.py --phase post_detector_fix` | Exit 1; TC01 còn false positives, TC02–TC04 PASS |
| `test_gate2_api.py --phase final` | Exit 0; TC01–TC04 PASS in 54,9s |
| `test_gate2_llm.py --phase final` trước error fix | HTTP 500 do upstream OpenAI 401 |
| `test_gate2_llm.py --phase final` sau error fix | HTTP 502 safe response; TC05 BLOCKED, backend health 200 |
| Relevant detector/API pytest | 42 pass, sau thêm LLM error test 43 pass |
| Full backend pytest | 232 passed in 77,48s |
| Gate-modified Python Ruff | All checks passed |
| Full-repo Ruff | 55 pre-existing findings ngoài Gate 2; không sửa unrelated code |
| `pnpm lint` | `tsc --noEmit`, exit 0 |
| `pnpm test` | 3 files, 26 tests passed |
| Gate 2 Playwright final | 3 passed in 39,2s |
| Focused blocker Playwright | 8 passed in 31,0s |
| Full Playwright final | 21 passed in 1,6m |
| Fixture validator | OK; 5 cases, 4 file-backed inputs |

## 8. Giải thích cách chạy lại

### Step 1: Chuẩn bị dữ liệu và dependency

Đảm bảo ba MCAP tồn tại đúng path trong manifest. Từ repo root:

```powershell
uv sync --extra dev
pnpm --dir frontend install
pnpm --dir frontend exec playwright install chromium
```

### Step 2: Start backend

```powershell
$env:APP_ENV='test'
$env:RUN_DB_PATH='eval/gate2/evidence/runtime/runs-rerun.db'
.\.venv\Scripts\python.exe -m uvicorn src.main:app --host 127.0.0.1 --port 8000
```

### Step 3: Start frontend ở terminal khác

```powershell
pnpm --dir frontend dev
```

### Step 4: Validate input và chạy API cases

```powershell
.\.venv\Scripts\python.exe eval\gate2\validate_fixtures.py
.\.venv\Scripts\python.exe scripts\test_gate2_api.py --phase rerun
```

### Step 5: Chạy live LLM case

Cấu hình credential provider hợp lệ trong environment/.env, không ghi key vào evidence:

```powershell
.\.venv\Scripts\python.exe scripts\test_gate2_llm.py --phase rerun
```

Nếu provider trả lỗi, case phải giữ BLOCKED/FAIL theo actual; không dùng fallback để đánh PASS.

### Step 6: Chạy UI và regression

```powershell
pnpm --dir frontend exec playwright test e2e/gate2.spec.ts --workers=1
.\.venv\Scripts\pytest.exe -q -o addopts=''
pnpm --dir frontend test
pnpm --dir frontend lint
pnpm --dir frontend exec playwright test --workers=1
```

### Step 7: Kiểm tra output

Đọc `eval/gate2/evidence/<TC>/<phase>/`, sau đó đối chiếu `docs/evaluation/gate2_evaluation_evidence.md`. Xóa temporary upload qua API sau khi đã lưu evidence; không xóa MCAP nguồn.

## 9. Giải thích từng test case

### TC01

- Input: healthy MCAP, 64.953 messages.
- Hệ thống làm gì: upload, parse 8 topics, tính timing metrics, chạy detector/health, render UI.
- Tại sao cần: chứng minh detector không báo lỗi nghiêm trọng trên đối chứng.
- Expected: succeeded, green, no critical/high.
- Actual: 0 anomaly, health 100, green.
- Result: **PASS**.

### TC02

- Input: F1_02, `/scan` bị giảm từ 10 xuống 2,5 Hz trong 90 giây.
- Hệ thống làm gì: suy ra nominal cadence, tính rate theo window, gộp các window drop liên tiếp.
- Tại sao cần: đây là anomaly chính của Gate 2.
- Expected: `/scan`, high, khoảng 75% drop.
- Actual: 9,901 → 2,4938 Hz, 74,81%, t=645–735.
- Result: **PASS**.

### TC03

- Input: F1_01 với long gap `/scan`.
- Hệ thống làm gì: đo từng timestamp và tìm inter-message/trailing gap lớn nhất.
- Tại sao cần: active span không chứng minh node im lặng; cần detection đúng outage.
- Expected: khoảng 115 giây, `/scan`, critical.
- Actual: 115,09 giây, đúng start/end và threshold.
- Result: **PASS**.

### TC04

- Input: plain-text `.txt`.
- Hệ thống làm gì: validation extension trước khi registry mutation/parser.
- Tại sao cần: demo không được crash vì input xấu.
- Expected: 400 rõ ràng, app còn usable.
- Actual: exact `.txt` error, registry unchanged, health 200, UI stable.
- Result: **PASS**.

### TC05

- Input: actual TC02 health/detections.
- Hệ thống làm gì: serialize untrusted diagnostic data, gọi configured OpenAI-compatible chat endpoint.
- Tại sao cần: chứng minh diagnosis là response model thật, không phải canned text.
- Expected: model trả correct anomaly/topic/root cause/actions.
- Actual: provider 401; application trả safe 502; không có model content.
- Result: **BLOCKED**.

## 10. Giải thích lỗi đã sửa

### BUG-G2-01 — Healthy false positives

Trước khi sửa: healthy bag sinh 85 anomaly và health 66,2. Nguyên nhân: fastest partial window bị coi là nominal Hz, event/status topic bị ép cadence, và mỗi window thành một anomaly.

Đã sửa: dùng median cadence, rate `(count-1)/span`, skip event-driven stream không có expected Hz, gộp adjacent windows. Sau khi sửa: TC01 0 anomaly/health 100; TC02 vẫn phát hiện đúng 74,81% drop. Cách kiểm chứng: final API runner.

### BUG-G2-02 — Silent node sai semantics

Trước khi sửa: rule báo active span của node, severity low, không có silent duration. Nguyên nhân: lấy `last-first` thay vì khoảng không message.

Đã sửa: đo gap lớn nhất và trailing gap, threshold theo absolute floor + median cadence, evidence có last/resume/duration. Sau khi sửa: TC03 critical, 115,09 giây. Cách kiểm chứng: detector output so với independent AnyReader measurement.

### BUG-G2-03 — LLM routing và error handling

Trước khi sửa: OpenAI config hợp lệ vẫn nhận canned fallback; khi cho gọi thật, provider 401 làm endpoint 500. Nguyên nhân: branch chỉ cho vLLM và route không catch HTTP error.

Đã sửa: mọi provider qua `validate_llm_config` đều được gọi; upstream failure map sang 502 an toàn. Sau khi sửa: actual provider vẫn 401 nên TC05 BLOCKED, nhưng app không crash. Cách kiểm chứng: unit/API tests + TC05 runner + backend health.

### BUG-G2-04 — UI diagnosis dùng anomalies rỗng

Trước khi sửa: UI có 6 detections nhưng fallback nói “No anomalies detected”. Nguyên nhân: effect auto-trigger trước khi anomaly props tải xong.

Đã sửa: chờ detection data, reset theo run, gọi live API, label fallback. Sau khi sửa: Playwright anomaly flow hiện đúng critical/high count và fallback label. Cách kiểm chứng: `playwright_gate2_stale_anomalies.txt` trước fix và `playwright_gate2.txt` sau fix.

### BUG-G2-05/06/07 — Navigation, invalid detail, threshold controls

Trước khi sửa: analysis page có thể giữ run cũ; invalid toast mất backend detail; threshold state/API không có control.

Đã sửa: reload đúng analysis run sau completion, parse `detail`, thêm threshold inputs/save. Sau khi sửa: Gate 2 3/3, focused 8/8 và full UI 21/21.
