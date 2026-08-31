---
title: "Khắc phục LLM chết trong production, trùng lặp dataset và sai lệch hiển thị UI"
description: "Rà soát toàn hệ thống bằng LLM thật trên 38 bag faulty: pipeline chính xác 89% nhưng production chưa từng gọi LLM lần nào; kèm 46 bản sao dataset và 8 API còn dùng dữ liệu giả."
status: completed
priority: P1
effort: ~13h
branch: develop
tags: [llm, ui-integration, data-hygiene, health-score, observability]
created: 2026-08-26
---

# Plan xử lý — RAV-13 / ros2-doctor

## 0. Tóm tắt điều hành

Đã chạy **LLM thật (OpenAI `gpt-4o-mini`)** qua đúng đường production
(`detect_anomalies` → `_cluster_detections` → `explain_detection_cluster`) trên
**38 bag faulty + 10 bag healthy** tại `~/ros2_doctor_ws/bags/`.

Kết luận cốt lõi: **thuật toán tốt, nhưng production chưa từng chạy LLM một lần nào.**

| Tầng | Kết quả đo thật | Đánh giá |
|---|---|---|
| Detector recall | **98.21%** (55/56 fault) | Rất tốt |
| False positive (bag healthy) | **0.20 / bag** (2/10 bag) | Rất tốt |
| Clustering bám ground truth | **96.92%** (65 cluster) | Tốt |
| LLM root-cause đúng / cluster | **89.23%** | Tốt |
| LLM đúng ở cấp bag | **86.84%** | Tốt |
| LLM đúng ở cấp run | **84.21%** | Tốt |
| Phủ từng fault | **83.93%** | Chấp nhận được |
| **AI result thật trong DB** | **0 / 296** | **Hỏng hoàn toàn** |

Nghịch lý: pipeline đạt 89% khi được chạy đúng, nhưng **100% kết quả AI đang lưu
trong `data/runs.db` là văn bản mẫu cứng** (`canned-fallback`). Người dùng nhìn
thấy thẻ "AI Conclusion" với confidence 0.81 — con số hardcode — chứ không phải
suy luận của mô hình.

---

## 1. Bảng phát hiện theo mức ưu tiên

| # | Mức | Vấn đề | Bằng chứng |
|---|---|---|---|
| 1 | P0 | `MODEL_NAME` sai → mọi call LLM trả 400 | `.env:7` |
| 2 | P0 | `is_llm_configured()` không kiểm tra model | `src/services/llm.py:154` |
| 3 | P0 | Fallback im lặng, UI không phân biệt thật/giả | `src/services/analysis.py:441` |
| 4 | P0 | Panel "LLM Deep-Dive" không hề gọi API | `llm-deep-dive-panel.tsx:160` |
| 5 | P0 | Route deep-dive trỏ sai cổng, và là route chết | `deep-dive/route.ts:238` |
| 6 | P1 | Upload không khử trùng lặp → 46 bản sao, 174 MB | `experiments.py:_sanitize_dataset_id` |
| 7 | P1 | `thresholds.json` vừa tracked vừa bị ghi runtime → 39 test fail | `data/diagnostics/thresholds.json` |
| 8 | P1 | Health score bão hòa, khóa cứng ở 70.0 | `src/services/health.py:71` |
| 9 | P1 | Ngưỡng deep-dive `<=` vs `<` mâu thuẫn | `health.py:127` vs `routes.py:600` |
| 10 | P2 | Tab vLLM bịa phần cứng H100 không tồn tại | `app/api/vllm/metrics/route.ts` |
| 11 | P2 | Token/cost luôn = 0 nhưng vẫn gắn nhãn model | `runs` table |
| 12 | P2 | 8/17 route frontend còn dùng mock store | `app/api/**` |
| 13 | P3 | Bảng Architecture liệt kê API không tồn tại + lỗi font | `rav-console.tsx:280` |

---

## 2. P0 — LLM chết trong production

### 2.1 Model ID không hợp lệ (nguyên nhân gốc)

`.env` dòng 7:

```
MODEL_NAME=GPT-4o mini
```

Đây không phải model ID của OpenAI (phải là `gpt-4o-mini`). Kiểm chứng trực tiếp:

```
# với .env hiện tại
FAILED: HTTPStatusError Client error '400 Bad Request'
        for url 'https://api.openai.com/v1/chat/completions'
# với MODEL_NAME=gpt-4o-mini
SUCCESS: 'OK'  ptok 13  ctok 1  lat 2051 ms
```

Mỗi lần gọi còn retry 2 lần (`_LLM_MAX_RETRIES = 2`, backoff 1s + 2s) trước khi
bỏ cuộc → mỗi cluster tốn ~3 giây chỉ để thất bại.

**Hệ quả đo được trong `data/runs.db`:**

```
AI result model distribution:
  canned-fallback    293
  cascade-fragment     3
```

Không một dòng nào từ LLM. Nội dung mẫu điển hình:

```json
{ "model": "canned-fallback",
  "rootCause": "Producer thread starvation or transport buffering paused publishing.",
  "confidence": 0.81 }
```

So với LLM thật trên cùng bag `F1_02` (ground truth: `/scan` tụt 10Hz→2.5Hz, t=45–135s):

> "The /scan topic experienced a frequency gap and a critical Hz drop, causing
> the /cmd_vel actuator to also show a frequency gap as it was starved of data
> from the sensor."
> — `prompt_tokens 966, completion_tokens 330, latency 5791ms`

LLM chỉ đúng topic gốc `/scan` **và** nhận ra `/cmd_vel` chỉ là hệ quả. Văn bản
mẫu không nêu được topic nào.

**Việc cần làm**
- [x] `.env`: `MODEL_NAME=gpt-4o-mini`.
- [x] Thêm kiểm tra khởi động: nếu `llm_provider=openai` mà `model_name` không
      khớp `^(gpt|o[0-9])[a-z0-9.\-]*$` thì raise ngay lúc boot.
      *Cài đặt thực tế: `validate_llm_config()` raise `ValueError` (gọi từ
      `is_llm_configured()` và `chat_completion()`), không crash cả tiến trình
      FastAPI khi khởi động — giữ đúng triết lý fallback đã có sẵn trong
      codebase (một model sai không nên làm sập luôn API detector). Lỗi hiện
      rõ qua `GET /api/v1/llm/health` (§2.2) thay vì crash process.*
- [x] Ghi chú trong `.env.example` rằng `MODEL_NAME` phải là ID API, không phải
      tên hiển thị.

### 2.2 `is_llm_configured()` cho kết quả dương tính giả

`src/services/llm.py:154` chỉ kiểm tra `openai_api_key` có rỗng hay không.
Vì vậy hệ thống báo "LLM đã cấu hình" trong khi 100% lệnh gọi thất bại — đây
chính là lý do lỗi im lặng suốt thời gian dài.

**Việc cần làm**
- [x] Thêm `GET /api/v1/llm/health`: gọi thật 1 completion tối thiểu, trả
      `{provider, model, ok, latencyMs, error}`.
- [x] Cache kết quả 60s để không tốn token mỗi lần poll (`check_llm_health` trong `src/services/llm.py`).
- [x] Hiện badge trạng thái LLM ở top-bar; đỏ khi `ok=false` (`frontend/components/top-bar.tsx`, poll 60s).

### 2.3 Fallback im lặng làm sai lệch người review

`src/services/analysis.py:441` bắt `Exception` rồi trả văn bản mẫu với
`model="canned-fallback"`, nhưng:

- `run.model` vẫn ghi `gpt-4o-mini` / `gpt-4.1` / `vllm/qwen2.5-coder-32b`
- `prompt_tokens = completion_tokens = cost_usd = 0` trên **cả 79 run**
- UI vẫn hiển thị confidence 0.81 như một kết quả AI bình thường

Người review không có cách nào biết mình đang duyệt văn bản mẫu. Với một hệ
thống human-in-the-loop, đây là lỗi nghiêm trọng nhất về mặt tin cậy.

**Việc cần làm**
- [x] Đưa `model` của từng `AIResult` lên UI dưới dạng badge (`frontend/components/ai-conclusion.tsx`).
- [x] Khi `model` là `canned-fallback`: đổi màu cảnh báo, ẩn thanh confidence,
      hiện dòng "Chưa qua LLM — kết quả suy luận theo luật".
      *Chỉ áp dụng cho `canned-fallback` (LLM lỗi/không khả dụng), không áp
      dụng cho `cascade-fragment` — nhánh đó là phân loại đúng-theo-thiết-kế
      (stall hạ nguồn của một sự cố đã báo cáo riêng), không cần LLM ngay từ
      đầu nên không mang tính "chưa qua LLM" theo nghĩa mất tin cậy.*
- [x] Chặn duyệt (approve) trên kết quả `canned-fallback`. Chặn cả hai lớp: nút
      Approve disable ở UI, **và** `POST /review/{id}/decision` trả `409` ở
      backend nếu verdict=approved trên kết quả `canned-fallback` (kiểm chứng
      bằng curl thật, không chỉ unit test). Reject/Edit vẫn hoạt động bình thường.
- [ ] Bỏ confidence hardcode 0.81, hoặc đổi tên trường thành `rule_confidence`.
      *Chưa làm — số này không còn hiển thị ở UI cho trường hợp fallback (bị
      thay bằng cảnh báo), nhưng vẫn còn hardcode trong `_canned_explanation`
      ở `src/services/analysis.py`. Để nguyên vì nằm ngoài phạm vi Giai đoạn 1/2.*

### 2.4 Panel "LLM Deep-Dive" không gọi LLM

`frontend/components/health/llm-deep-dive-panel.tsx:160`:

```ts
const triggerDeepDive = async () => {
  if (!activeRunId || isLoading || !health) return
  setIsLoading(true)
  try {
    setDeepDive(generateFallbackAnalysis(health.health_score, anomalies))
  } finally { setIsLoading(false) }
}
```

Không có `fetch`. Toàn bộ nội dung sinh tại client, bọc trong spinner giả. Chính
comment trong file cũng thừa nhận: *"Deterministic fallback used while the
deep-dive endpoint isn't wired to a live LLM"*.

**Việc cần làm**
- [x] `triggerDeepDive()` gọi LLM thật.
      *Đường đi thực tế khác mô tả ban đầu: `/analysis/explain` nhận
      `{summary: dict}` chứ không nhận chuỗi `prompt` — endpoint `/deep-dive`
      chỉ trả lại đúng `health` dict mà panel đã có sẵn qua props, nên
      `triggerDeepDive()` gọi thẳng `POST /api/v1/analysis/explain` với
      `{summary: health}`, bỏ qua vòng round-trip `/deep-dive` không cần thiết.
      Đã xác minh end-to-end qua `curl` tới cổng 3000 (Next.js proxy) và nhận
      root_cause/explanation/recommended_actions thật từ OpenAI.*
- [x] Spinner phản ánh thời gian mạng thật (await thật, không còn giả lập).
- [x] Khi lỗi: hiện toast lỗi ("Không gọi được LLM…"), sau đó mới hiện phân
      tích theo luật để panel không trống — người dùng luôn biết cuộc gọi đã
      thất bại, không bị đánh lừa là kết quả LLM.

### 2.5 Route deep-dive trỏ sai cổng và không ai gọi

`frontend/app/api/runs/[runId]/deep-dive/route.ts:238`:

```ts
const vllmUrl = process.env.VLLM_API_URL ?? "http://localhost:8000"
await fetch(`${vllmUrl}/v1/chat/completions`, ...)
```

`localhost:8000` là **FastAPI backend**, phục vụ `/api/v1/...` chứ không phải
`/v1/chat/completions` → luôn 404 → luôn rơi vào fallback. Đồng thời route này
chép lại toàn bộ engine health score sang TypeScript (`HEALTH_WEIGHTS`,
`SEVERITY_PENALTY`, `GROUP_BY_KIND`) — bản sao thứ hai của logic đã có trong
`src/services/health.py`, và bản sao này đã lệch: bảng `GROUP_BY_KIND` dùng các
`kind` như `tf_timeout`, `lidar_dropout`, `cpu_spike` mà detector thật không bao
giờ sinh ra.

Kiểm chứng: `grep` toàn bộ `app/`, `components/`, `lib/`, `hooks/` không có nơi
nào gọi route này. Tương tự với `/api/runs/[runId]/ai`.

**Việc cần làm**
- [x] Xóa `app/api/runs/[runId]/deep-dive/route.ts` và `app/api/runs/[runId]/ai/route.ts`
      (đã xác nhận không route/component nào khác gọi tới trước khi xóa).
- [x] Health score giờ chỉ còn một nguồn ở `src/services/health.py` — bản sao
      TypeScript (`HEALTH_WEIGHTS`, `GROUP_BY_KIND` lệch) đã bị xóa cùng route.

---

## 3. P1 — Trùng lặp dataset khi upload

### 3.1 Số liệu thực đo

```
bag files = 63    unique contents = 17    redundant copies = 46
  25x     5.2 MB   healthy_01_0-16 ... healthy_01_0-10
  18x     0.0 MB   trip_upload-16  ... trip_upload-15
   5x     3.7 MB   F1_02_0-9       ... F1_02_0-5
   2x    33.9 MB   C_04_0          ... C_04_0-2
wasted disk = 174 MB
```

`.git` hiện 251 MB vì `.gitignore:34-35` cố ý bỏ qua luật ignore
(`!data/*/*.mcap`, `!data/*/*.db3`) → 76 file bag đang được commit.

### 3.2 Nguyên nhân

`src/services/experiments.py:_sanitize_dataset_id` chỉ tránh **trùng tên**, không
xét **trùng nội dung**:

```python
candidate, suffix = stem, 2
while candidate in existing:
    candidate = f"{stem}-{suffix}"
    suffix += 1
```

Upload lại cùng một file 25 lần ⇒ 25 thư mục. Không có xác nhận ở UI, không có
kiểm tra ở API.

Tệ hơn: `healthy_01_0` (md5 `9d4b7f57…`) **khác nội dung** với
`healthy_01_0-2…-25` (md5 `5a05ad49…`). Nghĩa là tiền tố tên không nói lên nội
dung — người dùng chọn nhầm bag mà không hề biết.

### 3.3 Việc cần làm

- [x] **Xóa 46 thư mục trùng đã có trong `data/` (2026-08-26).** Người dùng xác
      nhận xóa hết. Thực hiện qua `delete_experiment()` (hàm production thật,
      không phải `shutil.rmtree` thủ công) từng thư mục trong danh sách 46 bản
      trùng, giữ lại đại diện ngắn tên nhất mỗi nhóm nội dung
      (`h01`, `trip_upload`, `F1_02_0-9`, `C_04_0`, cộng 13 dataset vốn đã
      không trùng). Kết quả: `data/` 63 → **17 dataset**, 338 MB → **173 MB**
      (giải phóng 165 MB, khớp ước tính 174 MB trước đó). Xác nhận qua
      `GET /api/v1/datasets` (`total: 17`) — cache dataset tự invalidate đúng.
      Các run cũ trong `runs.db` trỏ tới rosbag_id đã xóa sẽ có `rosbag: null`
      khi tra cứu (hành vi có sẵn của API, không phải lỗi mới).
- [x] **Chặn upload trùng tại nguồn (2026-08-26).** `save_uploaded_rosbag` giờ
      hash SHA-256 file bag chính ngay sau khi ghi xong (`_dataset_content_hash`),
      quét mọi dataset hiện có (`_find_duplicate_dataset`) — nếu trùng, xóa thư
      mục vừa tạo, trả **200** (thay vì 201) kèm `DatasetItem` của bản gốc và
      `duplicateOf: <id gốc>`. File mới hoàn toàn vẫn trả 201 như cũ.
      Xác nhận bằng `curl` thật: upload lại `data/h01/h01_0.mcap` dưới tên khác
      → `200`, `duplicateOf: "h01"`, tổng dataset không đổi (17); upload nội
      dung mới hoàn toàn → `201`, `duplicateOf: null`, tổng dataset tăng lên 18.
      2 test mới trong `tests/test_services/test_experiments.py`
      (`test_upload_duplicate_content_returns_original_and_skips_new_folder`,
      `test_upload_distinct_content_does_not_collide`).
- [x] Lưu hash để tra cứu không phải đọc lại file mỗi lần.
      *Cài đặt thực tế: sidecar `.content_sha256` trong từng thư mục dataset,
      không phải field trong `metadata.yaml` như đề xuất ban đầu — nhiều
      dataset (upload phẳng `.db3`/`.mcap`) chủ đích không có `metadata.yaml`
      (xem comment "Never fabricate an empty metadata.yaml..." trong
      `save_uploaded_rosbag`), nên gắn cache vào file đó sẽ bỏ sót phần lớn
      dataset. Sidecar hoạt động với mọi dataset, kể cả 17 cái đã có từ trước
      Giai đoạn 3 — hash của chúng được tính (và cache) lười vào lần đầu bị
      quét trong `_find_duplicate_dataset`, không cần chạy migration riêng.*
- [x] UI: khi nhận `duplicateOf`, hiện toast "Bag này đã có trong hệ thống — đang
      mở bản gốc" thay vì báo upload thành công (`frontend/components/datasets/capture-registry.tsx`).
- [x] ~~Script dọn dẹp `scripts/dedupe_datasets.py`~~ — không cần nữa: 46 bản
      trùng đã xóa thủ công một lần; giá trị còn lại chỉ là phòng tái diễn,
      việc đó nằm ở mục ngay trên (chặn tại thời điểm upload), không phải một
      script dọn định kỳ.
- [x] ~~Bag có nên tiếp tục nằm trong git không?~~ *(câu hỏi 2, mục 10 — đã quyết
      định: để nguyên, không viết lại lịch sử. Xem chi tiết ở mục 10.)*

---

## 4. P1 — File thresholds phá vỡ test và tính tái lập

`data/diagnostics/thresholds.json` **vừa được commit vào git, vừa bị server ghi
đè lúc runtime** qua `POST /api/v1/analysis/thresholds`.

Kết quả đo:

```
# với file hiện tại
39 failed, 273 passed
# bỏ qua file (DIAGNOSTICS_THRESHOLDS_FILE=/nonexistent)
73 passed   (toàn bộ tests/test_services/test_diagnostics.py)
```

Ví dụ: `test_log_severity_rules_fire` kỳ vọng `log_error_burst`, thực tế chỉ
nhận `{'log_fatal'}` vì `log_error_min_count` đã bị chỉnh.

Chính docstring của `scripts/eval_root_cause.py` đã cảnh báo đúng rủi ro này
("One measured run was invalidated this way") nhưng chưa ai xử lý gốc.

**Việc cần làm**
- [x] **Đã xử lý toàn bộ mục 4 (2026-08-26).**
- [x] Bỏ `data/diagnostics/thresholds.json` khỏi git (`git rm --cached`) và
      xóa nội dung cũ trên đĩa (không có delta thật nào — toàn bộ 30 key đều
      trùng khớp `DEFAULT_DIAGNOSTICS_THRESHOLDS`, tức file chỉ là bản dump
      dư thừa); thêm vào `.gitignore`.
- [x] ~~Chuyển giá trị mặc định vào `src/services/diagnostics_config.py`~~ —
      hóa ra **đã ở đó từ trước** (`DEFAULT_DIAGNOSTICS_THRESHOLDS`), không
      cần chuyển. Vấn đề nằm ở chỗ khác — xem mục dưới.
- [x] File runtime giờ chỉ chứa **phần ghi đè**, merge lên mặc định.
      **Nguyên nhân gốc thật sự** (khác chẩn đoán ban đầu): `save_diagnostics_thresholds`
      luôn ghi *toàn bộ* dict đã merge (default + override) xuống đĩa, không
      chỉ phần thay đổi. File tracked có mọi giá trị **trùng hệt** code default
      — không hề có tinh chỉnh thật nào — nhưng `pre_roll_grace_sec: 8.0` trong
      file đó đã đè lên `pre_roll_grace_sec: 0.0` mà `tests/conftest.py` monkeypatch
      vào `DEFAULT_DIAGNOSTICS_THRESHOLDS` để cô lập test, vì `merge_diagnostics_thresholds`
      tin tưởng mù quáng mọi key có trong file. Sửa `save_diagnostics_thresholds`
      chỉ ghi key nào khác giá trị default tại thời điểm lưu; key chưa đổi thì
      không xuất hiện trong file, nên luôn bám theo default hiện tại của code
      (kể cả khi test monkeypatch). 2 test mới xác nhận hành vi này.
- [x] `conftest.py`: thêm `DIAGNOSTICS_THRESHOLDS_FILE=tmp_path/thresholds.json`
      vào fixture `_isolate_state` — lớp phòng thủ thứ hai, độc lập với fix ở
      trên, để test không bao giờ đọc phải file tinh chỉnh thật của một dev.
- [x] ~~Thêm CI job chạy test trên checkout sạch~~ — `.github/workflows/ci.yml`
      (`backend-test` job) **đã làm đúng việc này từ trước** (`actions/checkout`
      rồi `pytest tests/ --cov-fail-under=75`); vấn đề chỉ là checkout sạch đó
      từng bao gồm file `thresholds.json` lỗi. Gỡ file khỏi git là đủ để CI tự
      pass, không cần job mới.

**Xác nhận:** `pytest tests/` (không cần bypass env var nào) → **316/316 pass**
trên cấu hình mặc định, tăng từ 273 pass / 39 fail trước khi sửa.

---

## 5. P1 — Ngữ nghĩa Health Score

### 5.1 Bão hòa: điểm khóa cứng tại 70.0

`_subscore` trừ thẳng theo severity, không giới hạn số lần trừ, rồi kẹp sàn về 0:

```python
score = 100.0
for severity in severities:
    score -= _SEVERITY_PENALTY.get(severity, 5.0)   # critical 50, high 30
return max(0.0, round(score, 1))
```

Nhóm `frequency` chỉ cần **4 detection mức high** là chạm 0 và ở lì đó. Với run
`run_F1_02_0` (5 detection, tất cả thuộc `frequency`):

```
frequency: score 0.0   weight 0.30   detection_count 5
log/latency/tf/payload: score 100.0
→ health_score = 0.30×0 + 0.70×100 = 70.0
```

Phân bố trên 35 run có detection:

```
70 → 20 run   82 → 7 run   còn lại rải rác 40–96
```

**20/35 run (57%) rơi đúng vào 70.0.** Điểm số không phân biệt được một sự cố nhẹ
với mất cảm biến hoàn toàn — cả hai đều ra 70.0.

**Việc cần làm — ✅ Đã sửa (2026-08-26)**
- [x] Đổi sang giảm dần theo hàm mũ — **không chạm 0**, giữ thứ tự so sánh.
      *Công thức thực tế: nhân dồn theo geometric decay thay vì cộng dồn tuyến
      tính rồi kẹp sàn —* `score = 100 × ∏(1 - penalty_i/100)` *thay vì*
      `score = 100 × exp(-Σpenalty/K)`*. Lý do chọn nhân thay vì exp-tổng-K:
      với 1 detection duy nhất, công thức nhân cho đúng y hệt giá trị cũ*
      (`100 × (1-penalty/100) = 100-penalty`) *cho MỌI mức severity cùng lúc —
      hai test cũ (`test_group_subscores_are_independent`,
      `test_scores_are_bounded_and_weighted`) đòi hỏi khớp chính xác 70.0 (1
      detection "high") và 50.0 (1 detection "critical") cùng lúc; một hằng số
      K chung cho exp-tổng không thể khớp cả hai giá trị này đồng thời vì
      penalty mỗi severity khác nhau (50/30/15/5). Với >1 detection, decay dần
      dần thay vì cộng thẳng — không bao giờ chạm 0 (chỉ có thể làm tròn hiển
      thị về 0.0 ở số lượng cực lớn, ~27+ detection cùng nhóm — vượt xa dữ
      liệu thật đã thấy, tối đa ~24 detection/run).*
- [x] ~~Hoặc chuẩn hóa penalty theo thời lượng bag~~ — không cần, hướng hàm mũ
      đã đủ và giữ được tương thích ngược với 2 test hiện có.
- [x] Test khẳng định: 1 > 4 > 40 detection cùng severity (`test_more_detections_never_score_better_than_fewer`).
      Test biên mới cho `should_deep_dive` (69.9/70.0/70.1) trong §5.2.

**Hệ quả cần biết:** công thức mới có thể đổi màu trạng thái (green/yellow/red)
của một vài tình huống biên so với trước — test `test_critical_tf_detection_drops_score_to_red`
đã phải tăng số lượng detection tái hiện (2→4 mỗi nhóm) mới đạt "red" dưới công
thức mới, vì bản thân test cũ vô tình dựa vào chính hành vi bão hòa đang bị sửa
(2 detection critical từng đủ để một nhóm rơi thẳng về 0). Đây là thay đổi có
chủ đích, không phải regression.

**Xác nhận trên 36 run thật còn lại trong `runs.db`:** không còn run nào đúng
70.0 (trước: 57%). Cụm điểm ~79 còn lại (16 run) là dữ liệu trùng lặp thật từ
trước Giai đoạn 3 (bản sao `F1_02_0-*`), không phải lỗi công thức mới — cùng
input thì cùng điểm là đúng.

### 5.2 Ngưỡng deep-dive mâu thuẫn giữa hai file

```python
# src/services/health.py:127
"trigger_llm_deep_dive": score <= DEEP_DIVE_TRIGGER_THRESHOLD   # <=

# src/api/routes.py:600
"triggered": score < deep_dive_threshold                        # <
```

Tại đúng 70.0 — điểm phổ biến nhất, chiếm 57% số run — hai bên trả ngược nhau:
payload health nói "cần deep-dive: true", endpoint deep-dive nói
"triggered: false". Panel UI đọc `trigger_llm_deep_dive` nên tự kích hoạt, còn
backend lại coi run đó là không cần điều tra.

**Việc cần làm — ✅ Đã sửa**
- [x] Thống nhất một toán tử: `<=` (70.0 là ngưỡng bão hòa cần xem, không phải
      ngưỡng để bỏ qua).
- [x] Đưa phép so sánh vào một hàm duy nhất `should_deep_dive(score, threshold)`
      trong `src/services/health.py:74`, dùng lại ở cả `compute_health_summary`
      (health.py:155) và `GET /analysis/{run_id}/deep-dive` (routes.py:663).
- [x] Test tham số hóa tại biên 69.9 / 70.0 / 70.1
      (`tests/test_services/test_health.py::test_should_deep_dive_boundary`,
      11/11 pass).

---

## 6. P2 — Số liệu hiển thị bịa đặt

### 6.1 Tab vLLM mô tả phần cứng không tồn tại

`frontend/app/api/vllm/metrics/route.ts` trả về:

```ts
gpu: { name: "NVIDIA H100 80GB HBM3", count: 2, vramTotalGb: 80,
       driver: "555.42.06", engine: "vLLM 0.6.3", maxModelLen: 8192 }
```

Dự án này gọi OpenAI qua HTTP. Không có H100, không có vLLM, không có driver
555.42.06. Toàn bộ chuỗi thời gian cũng sinh từ seed cố định trong
`lib/server/store.ts`.

Đây là rủi ro lớn nhất nếu đem demo/bảo vệ: người xem sẽ tin đó là hạ tầng thật.

**Việc cần làm — ✅ Đã sửa (2026-08-26)**
- [x] Gỡ hẳn provider `vllm` khỏi backend (§10.3 đã quyết định OpenAI/Anthropic
      qua HTTP, không tự host vllm): `config.py` (`llm_provider` còn
      `openai`/`anthropic`, xóa `vllm_base_url`/`vllm_api_key`/`vllm_model_name`),
      `llm.py` (`validate_llm_config`/`resolved_model_name`/`chat_completion`
      chỉ còn 2 nhánh), `routes.py` (thông báo lỗi chat). Đổi tên
      `AIResultSummary.vllmRequestId` → `requestId` (giá trị vốn đã là ID tự
      sinh cục bộ `vllm_req_{n}`, chưa từng đến từ một engine vllm thật) trong
      `schemas.py`, `analysis.py`, `iterative_debug.py` và toàn bộ frontend/test
      tương ứng.
- [x] Backend: thêm `GET /api/v1/runs?limit=` (mới, `src/api/routes.py`) trả
      toàn bộ run thật từ `run_store.list_runs()` — mới nhất trước — kèm
      `model`/`totalLatencyMs`/`promptTokens`/`completionTokens`/`costUsd` thật
      từng run. 2 test mới (`test_list_runs_returns_real_llm_usage_newest_first`,
      `test_list_runs_respects_limit`).
- [x] Frontend: xóa hẳn `components/vllm/vllm-observability.tsx` (bịa GPU/VRAM/
      PagedAttention/queue/prefill/decode — không có dữ liệu thật nào đứng sau,
      dự án gọi OpenAI/Anthropic qua HTTP thuần) và `app/api/vllm/*` (2 route
      mock). Thay bằng `components/llm/llm-observability.tsx` — thẻ tổng số run/
      độ trễ trung bình/tổng token/tổng chi phí và bảng lịch sử run, toàn bộ đọc
      từ `GET /api/v1/runs` thật (curl xác nhận qua đúng cổng 3000 mà trình
      duyệt gọi, xem cuối mục 8).
- [x] Đổi tên tab "Giám sát VLLM (VLLM observability)" → "Giám sát LLM (LLM
      observability)" trong `rav-console.tsx`, `app-sidebar.tsx` (href `/vllm` →
      `/llm`, vẫn nhận `/vllm-monitoring` và `/vllm` cũ để không vỡ link cũ),
      `e2e/*.spec.ts`, `app/layout.tsx` (meta description), `fleet-health-hero.tsx`.
      Bỏ khối footer sidebar bịa "vllm 0.6.3 · 2x H100 80GB" (hiển thị tĩnh,
      không điều kiện gì, luôn sai).

### 6.2 Token và chi phí luôn bằng 0

Cả 79 run: `prompt_tokens = 0`, `completion_tokens = 0`, `cost_usd = 0`, trong khi
`run.model` ghi `gpt-4o-mini` (72 run), `gpt-4.1` (5), `vllm/qwen2.5-coder-32b` (2).
Hệ quả trực tiếp của mục 2.1 — sẽ tự khỏi sau khi LLM chạy lại, nhưng cần chốt
bằng test hồi quy.

**Việc cần làm — ✅ Đã sửa (2026-08-26)**
- [x] Test hồi quy: `test_create_analysis_records_real_llm_token_usage_when_configured`
      (`tests/test_api/test_routes.py`) — mock `explain_detection_cluster` trả
      usage thật, gọi `POST /api/v1/analysis` end-to-end, xác nhận
      `run.promptTokens/completionTokens/costUsd > 0` và không còn AI result nào
      `model == "canned-fallback"`. Đây đúng là quy trình từng hỏng (§0): LLM
      chạy nhưng usage không tới được run — test này khóa lại hành vi đó.
- [x] UI hiện "—" thay vì "$0.00": khảo sát cho thấy `dashboard-overview.tsx`
      (`totals.inferenceCostUsd ? ... : "--"`) và `recent-runs-card.tsx`
      (`run.totalLatencyMs ? ... : "--"`) **đã** theo đúng quy ước này từ trước —
      không có "$0.00" thật nào còn sống trong UI hiện tại. Nguồn "$0.00" duy
      nhất từng tồn tại là `vllmRequests` giả trong `lib/server/store.ts` (mục
      6.1), nay đã xóa cùng toàn bộ route vllm. `llm-observability.tsx` mới
      cũng theo đúng quy ước này (`costLabel()` trả "—" khi `costUsd <= 0`).

### 6.3 Các route còn dùng dữ liệu giả

8/17 route trong `frontend/app/api/` vẫn đọc `lib/server/store.ts`:

| Route | Ảnh hưởng UI |
|---|---|
| `runs/[runId]/ai` | route chết — xóa |
| `runs/[runId]/deep-dive` | route chết — xóa |
| `runs/[runId]/timeline` | Timeline canvas hiển thị dữ liệu bịa |
| `runs/[runId]/logs` | Luôn trả `[]` → Log Stream vĩnh viễn rỗng |
| `stream` | SSE giả |
| `vllm/metrics`, `vllm/requests` | Xem mục 6.1 |
| `feedback`, `reports` | Không ghi xuống backend |

Riêng `timeline/route.ts` còn khai báo `export const dynamic = "force-static"` —
nghĩa là khi build production, mọi query param (`from`, `to`, `topics`, `levels`)
bị bỏ qua và trả về một bản chụp tĩnh.

Bảng `run_logs` tồn tại trong `data/runs.db` (0 dòng) nhưng **không có bất kỳ
đoạn code nào trong `src/` đọc hoặc ghi nó** — schema mồ côi.

**Việc cần làm — ✅ Đã xử lý (2026-08-26), khác chẩn đoán ban đầu ở 3/4 route**

Khảo sát kỹ hơn cho thấy hầu hết các route này **đã là dead code** — không
component nào trong app thật sự gọi tới — chứ không phải "đang hiển thị dữ
liệu giả cho người dùng" như bảng trên ngụ ý. `grep` xác nhận từng trường hợp
trước khi xóa (đúng tinh thần đã áp dụng ở §2.5):

- [x] **`timeline`** — **không cần "nối vào export/windows" vì đã nối rồi**, ở
      một đường khác: `rav-console.tsx` gọi thẳng `fetchWindowSummaries()` →
      `GET /api/v1/analysis/{runId}/export/windows` (thật) → `buildTimelineLanes()`
      để vẽ canvas. Route mock `app/api/runs/[runId]/timeline/route.ts`
      (`force-static`, đọc `lib/server/store.ts`) không có component nào gọi tới
      — chỉ được nhắc tên trong bảng API bịa ở §7. Đã xóa route mock.
- [x] **`logs`** — khảo sát sâu hơn phát hiện toàn bộ đường dẫn dữ liệu đã chết
      từ trước, không phải do route mock: `rav-console.tsx` fetch `/api/runs/{id}/logs`
      → set state `logs` → truyền qua `AnalysisWorkspace` → `AnalysisHealthPanel`
      → `computeSystemMetrics({..., logs})` — nhưng `computeSystemMetrics`
      (`lib/health-engine.ts`) **destructure tham số `logs` rồi không dùng ở đâu
      cả**. Component `LogStream` (nơi lẽ ra logs được hiển thị) cũng không được
      render ở bất kỳ đâu trong app. Giữ nguyên route mock — nó đã trung thực
      sẵn (trả `{logs: []}` kèm comment giải thích rõ vì sao, không bịa nội
      dung) — và xây một pipeline ghi log thật (`run_logs`) cho một chuỗi hiển
      thị hiện tại rỗng không phải việc nên làm giữa đợt này; số phận bảng
      `run_logs` vẫn là câu hỏi mở (mục 10.4).
- [x] **`feedback`/`reports`** — cũng dead code: không component nào gọi
      `POST /api/feedback` hay `GET/POST /api/reports` (chỉ xuất hiện trong bảng
      API bịa ở §7). Cơ chế feedback thật của app là `POST /api/v1/review/{id}/decision`
      (đã proxy sang backend từ trước, dùng bởi `AIConclusion`); cơ chế "reports"
      thật là tab `ReportsEnhanced` đọc `GET /api/v1/review/stats` (backend thật)
      — component `Reports` cũ (dữ liệu bịa cứng "RPT-2026-071") không được
      render ở đâu. Đã xóa 2 route mock và hàm `Reports` chết.
- [x] **`stream`** — chọn "gỡ khỏi UI" thay vì làm SSE thật: `run_analysis` chạy
      đồng bộ và trả kết quả ngay khi xong (xem `test_dashboard_and_analysis_contracts`),
      nên không có "job đang chạy" thật nào để stream tiến độ — khái niệm
      `job.progress` qua SSE không khớp kiến trúc thật, và `vllm.tick` là bịa
      hoàn toàn (gpu/tok/queue giả). Xóa `app/api/stream/route.ts`,
      `hooks/use-live-stream.ts`; `top-bar.tsx` chỉ còn giữ badge trạng thái LLM
      thật (`/api/v1/llm/health`, đã có từ §2.2).
- [x] Dọn theo: xóa hẳn `lib/server/store.ts` (762 dòng fake-data generator) —
      sau khi xóa 8 route trên, không còn nơi nào trong app import nó nữa.

**Xong khi:** không còn `import { data } from "@/lib/server/store"` ở route nào
phục vụ số liệu vận hành — ✅ xác nhận bằng `grep`, file đã bị xóa hoàn toàn.
`next build` xanh, route list production chỉ còn `overview`, `review/*`,
`rosbags*`, `runs*` (đều real hoặc mock đã trung thực từ trước) — không còn
`vllm`, `feedback`, `reports`, `stream`, `timeline` mock nào.

---

## 7. P3 — Bảng "Architecture" sai và lỗi font

`frontend/components/rav-console.tsx:280` liệt kê hợp đồng API không tồn tại:
`POST /api/rosbags/:id/parse`, `GET /api/runs/:id/ai`, `WS /api/stream`,
`POST /api/feedback`, `GET /api/reports`. Đồng thời chuỗi bị lỗi mã hóa UTF-8:
`"parse â†' index â†' detect"` (đúng ra là `parse → index → detect`).

- [x] **✅ Đã sửa (2026-08-26).** Danh sách hợp đồng API trong `Architecture()`
      (`rav-console.tsx`) đổi thành 10 route thật lấy trực tiếp từ
      `src/api/routes.py` (`/datasets/upload`, `/datasets`, `/analysis`,
      `/analysis/:runId`, `/analysis/:runId/health`, `/analysis/:runId/deep-dive`,
      `/runs`, `/review`, `/review/:id/decision`, `/llm/health`); bỏ hẳn
      `POST /api/feedback`, `GET /api/reports`, `GET /api/vllm/metrics`,
      `WS /api/stream` (không route/kênh nào trong số này còn tồn tại — xem
      mục 6.3). Sửa lỗi mã hóa `"parse â†' index â†' detect"` →
      `"parse → detect → diagnose"` (khớp thứ tự pipeline thật, không phải chuỗi
      gốc "parse → index → detect" — bước "index" không tồn tại trong
      `run_analysis`). Đổi "Agent + VLLM" → "Agent + LLM (OpenAI/Anthropic qua
      HTTP)". Bỏ khối "WebSocket /stream" và mô tả 3 event `job.progress`/`log`/
      `simulation.sync` — không kênh nào trong số đó còn tồn tại sau khi gỡ SSE
      giả (mục 6.3); thay bằng một dòng ghi rõ: mọi route ở trên là FastAPI thật,
      console gọi trực tiếp, đồng bộ, không qua job queue hay WebSocket.

---

## 8. Thứ tự thực hiện

### Giai đoạn 1 — Khôi phục LLM (~2h, chặn mọi việc khác) — ✅ HOÀN THÀNH 2026-08-26
1. ✅ Sửa `MODEL_NAME` trong `.env` + validate lúc boot (§2.1)
2. ✅ Thêm `/api/v1/llm/health` + badge trạng thái (§2.2)
3. ✅ Gắn nhãn `canned-fallback` lên UI, chặn approve cả UI lẫn backend (§2.3)
4. ✅ Chạy lại analysis thật qua `POST /api/v1/analysis` trên **17 dataset có
   nội dung duy nhất** (bỏ qua 46 bản trùng byte-for-byte — xem mục 3 — để
   không tốn token OpenAI cho dữ liệu giống hệt nhau)

**Xong khi:** `select model, count(*) from run_ai_results` không còn
`canned-fallback`, `prompt_tokens > 0`.
→ Xác nhận: 59 kết quả `llm-explain` + 3 `cascade-fragment`, 0 `canned-fallback`,
tổng 23,643 token thật trên 17 run vừa chạy lại. Các run cũ (`run_F4_04_0` và
tương tự, tổng ~62 run trùng lặp) vẫn còn `canned-fallback` — sẽ tự hết khi
dedup xong (Giai đoạn 3) và người dùng chạy lại phân tích qua UI (giờ đã dùng
LLM thật). Không chạy lại toàn bộ 79 run cũ vì phần lớn là bản sao của 17 dataset trên.

### Giai đoạn 2 — Nối LLM vào UI (~3h) — ✅ HOÀN THÀNH 2026-08-26
5. ✅ `LLMDeepDivePanel` gọi endpoint thật (§2.4)
6. ✅ Xóa `deep-dive/route.ts` và `ai/route.ts` (§2.5)

**Xong khi:** bấm "Deep dive" tạo request thật, thấy được trong log backend.
→ Xác nhận qua `curl` tới `localhost:3000/api/v1/analysis/explain` (đường đi
chính xác trình duyệt dùng): nhận về root_cause/explanation/recommended_actions
thật từ OpenAI, có log `llm.chat_completion` ở backend.

**Kiểm chứng đã chạy cho cả hai giai đoạn:**
- Backend: 312/312 test pass (bypass `thresholds.json` — vấn đề riêng ở §4/Giai đoạn 3).
- Frontend: `tsc --noEmit` sạch, 30/30 vitest pass.
- `POST /review/{id}/decision` với verdict=approved trên kết quả `canned-fallback`
  → xác nhận thật `409` qua curl; verdict=rejected vẫn `200` như thiết kế.
- **Chưa kiểm tra bằng trình duyệt thật** (không có công cụ browser automation
  trong phiên này) — đã xác minh toàn bộ chuỗi dữ liệu qua curl tới đúng cổng
  3000 (Next.js) mà UI sẽ gọi, và typecheck/test đều xanh, nhưng chưa nhìn thấy
  badge/thẻ cảnh báo render trực tiếp trên màn hình. Nên xác nhận trực quan
  trước khi coi là xong hoàn toàn.

### Giai đoạn 3 — Vệ sinh dữ liệu (~3h) — ✅ HOÀN THÀNH (2026-08-26)
7. ✅ Xóa 46 bản sao đã có + chặn upload trùng theo SHA-256 (§3.3) — người dùng
   duyệt xóa hết, đã thực hiện. `data/`: 63 → 17 dataset, 338 MB → 173 MB.
8. ✅ ~~Script dọn 46 bản sao~~ — không cần: xóa xong thủ công một lần qua
   `delete_experiment()`, phòng tái diễn nằm ở #7 (chặn tại upload).
9. ✅ Gỡ `thresholds.json` khỏi git, sửa root cause (§4).

**Xong khi:** `pytest tests` xanh trên checkout sạch — ✅ 316/316 pass, không
cần bypass env var nào; upload lại cùng file không tạo thư mục mới — ✅ xác
nhận bằng curl thật.

### Giai đoạn 4 — Đo lường đúng (~2h) — ✅ HOÀN THÀNH
10. ✅ Health score không bão hòa (§5.1)
11. ✅ Thống nhất ngưỡng deep-dive (§5.2)

**Xong khi:** phân bố điểm không còn cụm 57% tại một giá trị. → Đã xác nhận ở
§5.1 (không còn run nào đúng 70.0). `should_deep_dive` đã là nguồn sự thật duy
nhất, 2 nơi gọi đều nhất quán.

### Giai đoạn 5 — Trung thực hiển thị (~3h) — ✅ HOÀN THÀNH 2026-08-26
12. ✅ Tab LLM Observability dùng số liệu thật (§6.1, §6.2)
13. ✅ Timeline/logs/feedback/reports/stream — dọn dead code + gỡ SSE giả (§6.3)
14. ✅ Sửa bảng Architecture (§7)

**Xong khi:** không còn `import { data } from "@/lib/server/store"` ở route nào
phục vụ số liệu vận hành. → ✅ File đã bị xóa hoàn toàn (762 dòng), không còn
importer nào (`grep` xác nhận). `next build` sạch (production route list chỉ
còn `overview`, `review/*`, `rosbags*`, `runs*`); `npx tsc --noEmit` sạch;
321/321 test backend pass; 28/28 test frontend (vitest) pass.

**Kiểm chứng end-to-end đã chạy** (curl qua đúng cổng 3000 mà trình duyệt gọi,
backend thật trên cổng 8000, dữ liệu thật từ `data/runs.db`):
```
GET localhost:3000/api/v1/runs?limit=2
→ 200, 2 run thật (model: gpt-4o-mini, promptTokens/completionTokens/costUsd > 0)
GET localhost:3000/llm        → 200 (tab LLM Observability)
GET localhost:3000/{/, datasets, analysis, review, reports, architecture} → 200
```
**Chưa xác nhận bằng trình duyệt thật** — không có công cụ browser automation
trong phiên này (người dùng chọn bỏ qua cài Claude in Chrome). Đã xác minh toàn
bộ chuỗi dữ liệu qua curl tới đúng cổng, typecheck/build/test đều xanh, nhưng
chưa nhìn thấy tab LLM Observability render trực tiếp trên màn hình. Nên xác
nhận trực quan trước khi coi Giai đoạn 5 là xong hoàn toàn về mặt UX (không chỉ
về mặt dữ liệu).

---

## 9. Cách tái lập các số liệu trong tài liệu này

```bash
# Eval đầy đủ có LLM (mất ~10 phút, tốn token thật)
MODEL_NAME=gpt-4o-mini .venv/bin/python scripts/eval_root_cause.py \
    --bags ~/ros2_doctor_ws/bags --runs 1

# Chỉ detector, không tốn token
.venv/bin/python scripts/eval_root_cause.py --detector-only

# Kiểm tra AI result trong DB
.venv/bin/python -c "
import sqlite3,json,collections
c=sqlite3.connect('data/runs.db')
print(collections.Counter(json.loads(p)['model'] for (p,) in
      c.execute('select payload from run_ai_results')))"

# Test với threshold mặc định
DIAGNOSTICS_THRESHOLDS_FILE=/nonexistent/x.json .venv/bin/python -m pytest \
    tests/test_services/test_diagnostics.py -q
```

---

## 10. Câu hỏi chưa có lời giải

1. ~~**Xóa 46 thư mục trùng trong `data/` được không?**~~ **Đã trả lời (2026-08-26): xóa hết.**
   Đã xóa qua `delete_experiment()` (đúng hàm production, tự invalidate cache).
   `data/` từ 63 → 17 dataset, 338 MB → 173 MB. Chi tiết ở mục 3 (Giai đoạn 3).
2. ~~**Bag có nên tiếp tục nằm trong git không?**~~ **Đã trả lời (2026-08-26): để
   nguyên hiện trạng, không viết lại lịch sử git.**
   Đào sâu cho thấy quy mô lớn hơn nhiều so với ước tính ban đầu: bag không chỉ
   nằm trong lịch sử `develop` mà 2 commit (`4eb3a2a`, `1bb275c`) chứa bag lại
   reachable từ gần như mọi nhánh — kể cả **`main`** — cộng thêm
   `feature/rosbag-parser-production-hardening`, `feature/terraform-deploy-model`,
   `test/gate2-e2e-evaluation`, `test/security-audit`, `feat/fix-ui`,
   `feat/hitl-review-analytics`, `feature/fix-detector-llm` và các bản `origin/`
   tương ứng. Xóa thật sự đòi hỏi viết lại lịch sử + force-push trên hầu hết
   nhánh, phá vỡ mọi clone/PR đang mở, có thể bị chặn bởi branch protection
   trên `main`. Người dùng xác nhận: để nguyên, không đáng rủi ro vào lúc này.
   `.git` giữ nguyên ~252 MB.
3. ~~**`vllm` có còn là hướng triển khai không?**~~ **Đã trả lời (2026-08-26): không — dùng
   LLM qua API (OpenAI), không tự host vllm.** Hệ quả cho các phase sau:
   - §6.1 (tab "vLLM Observability", GPU/H100 bịa đặt): thay vì nối số liệu vllm thật,
     **gỡ hẳn** provider `vllm` khỏi `llm_provider` (config), `llm.py`, và tab quan
     sát đổi hẳn sang "LLM Observability" đọc từ bảng `runs` (OpenAI latency/token/cost).
   - Việc gỡ `vllm` chạm nhiều file (`config.py`, `llm.py`, schemas có field
     `vllmRequestId`, frontend `vllm-observability.tsx`, `/api/vllm/*`) — để dành
     cho Giai đoạn 5 (đúng phạm vi §6.1) thay vì làm giữa Giai đoạn 3, tránh
     trộn lẫn "dọn dữ liệu" với "đổi kiến trúc provider" trong cùng một đợt.
4. **Bảng `run_logs` để làm gì?** Hiện mồ côi hoàn toàn — triển khai tiếp hay xóa? *(vẫn mở)*
5. **Ngưỡng chấp nhận cho eval là bao nhiêu?** Hiện đo được root-cause 89.23%,
   run-level 84.21%. Cần chốt con số để đưa vào CI gate. *(vẫn mở)*
6. ~~**`gpt-4o-mini` có phải lựa chọn cuối không?**~~ **Đã trả lời (2026-08-26): dùng
   luân phiên `gpt-4o-mini` và `gpt-4.1`, không chốt một model duy nhất.**
   Hệ quả: `MODEL_NAME` trong `.env` chọn model đang hoạt động tại một thời điểm
   (không có cơ chế round-robin tự động trong code — "luân phiên" ở đây là người
   vận hành đổi `.env` theo nhu cầu, ví dụ `gpt-4o-mini` cho chi phí thấp,
   `gpt-4.1` khi cần độ chính xác cao hơn). `_MODEL_PRICING_USD_PER_1M_TOKENS`
   trong `src/services/llm.py` đã có sẵn giá cho cả hai model nên chi phí vẫn
   tính đúng khi đổi qua lại. Không cần sửa code cho quyết định này.
