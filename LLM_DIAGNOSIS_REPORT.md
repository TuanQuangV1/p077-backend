# LLM Root-Cause Diagnosis — Xác thực & Khắc phục

> **Trạng thái:** đã xác thực bằng dữ liệu, đã sửa, đã đo lại bằng `eval_root_cause.py --runs 3`.
> Bản trước của tài liệu này quy nguyên nhân cho **truncation token** và **gpt-4o-mini thiếu ổn định**.
> Cả hai đều **sai**. Nguyên nhân thật đã được chứng minh bên dưới.

---

## 1. Kết quả sau khi sửa

| Metric | Lần chạy hỏng | **Sau khi sửa** (median [min–max], n=3) | Δ |
|---|:-:|:-:|:-:|
| `root_cause_pct` | 75,76% | **87,88%** [86,36–89,39] | **+12,1** |
| `fault_diagnosed_pct` | 73,21% | **83,93%** [82,14–87,50] | **+10,7** |
| `run_level_pct` | 73,68% | **86,84%** [84,21–89,47] | **+13,2** |
| `bag_any_correct_pct` | 78,95% | **86,84%** [86,84–89,47] | **+7,9** |
| Dao động `root_cause_pct` | ~17 điểm | **3,03 điểm** | −14 |

Detector không đổi: `recall_pct` 98,21%, `healthy_per_bag` 0,20, `cluster_with_gt_pct` 95,45%.

**So với baseline `gpt-4.1`** (87,7 [87,7–89,2] ghi ở `docs/benchmark.md` §11): `gpt-4o-mini`
giờ đạt 87,88 [86,36–89,39] — **ngang baseline, rẻ hơn 24×**. Khuyến nghị "phải quay lại
`gpt-4.1`" trong §11 không còn đúng.

### Đối chiếu tiêu chí nghiệm thu

| Tiêu chí | Ngưỡng | Đo được | |
|---|:-:|:-:|:-:|
| `root_cause_pct` median | ≥ 88% | 87,88% | ⚠️ hụt 0,12 |
| `root_cause_pct` min | ≥ 85% | 86,36% | ✅ |
| `fault_diagnosed_pct` median | ≥ 85% | 83,93% | ⚠️ hụt 1,07 |
| Dao động (max−min) | ≤ 5 điểm | 3,03 | ✅ |

Hai tiêu chí hụt sát ngưỡng. Phần còn lại **phần lớn là trần dữ liệu, không phải lỗi LLM**:
`cluster_with_gt_pct` = 95,45% → 3/66 cụm không hề chứa topic ground truth. Trừ 3 cụm bất khả
thi đó, độ chính xác trên phần khả thi là **58/63 = 92,1%**.

---

## 2. Nguyên nhân thật: leak guard chặn nhầm 1/4 số kết luận đúng

### Bằng chứng trực tiếp

Lượt chạy hỏng (2026-09-01) có **18/68 cụm mất sạch `findings`**. Nội dung của cả 18 cụm
đó **không phải JSON bị cắt** mà là:

```
"root_cause": "[blocked] The model reply failed the prompt-injection leak check and was withheld."
```

Đó là `_sanitized_content()` → `leak_guard.response_is_safe()` trả `False`. Một trong các cụm
bị chặn (`C_04` #2) chỉ có **1 detection** — output của nó không thể nào chạm cap 1024 token,
nên giả thuyết truncation bị loại dứt điểm.

### Cơ chế lỗi

`find_prompt_leaks()` chấm điểm bằng `max(partial_ratio, token_set_ratio)` ngưỡng 85.
`token_set_ratio` **bỏ qua thứ tự từ**: nó chỉ hỏi "các từ của mảnh prompt này có xuất hiện đâu
đó trong câu trả lời không". Mà câu trả lời chẩn đoán **bắt buộc** dùng đúng từ vựng của prompt
(`sensor`, `transform`, `anomaly`, `overlaps`, `primary`, `consequence`).

Đo trên 1 câu trả lời đúng thật (`C_02` #3):

| Mảnh prompt | `partial_ratio` | `token_set_ratio` |
|---|:-:|:-:|
| "a sensor or transform anomaly that overlaps it" | **63,0** | **85,0** ← chặn |

`partial_ratio` cao nhất chỉ 63 — tức là **không hề có đoạn nào giống prompt theo thứ tự**.
Toàn bộ false positive đến từ `token_set_ratio`.

### Cửa sổ regression

| Ngày | Sự kiện | Cụm bị chặn |
|---|---|:-:|
| 2026-08-27 | `8253bfe` thêm fuzzy matching — **chỉ áp cho `/chat`** | 0 |
| 2026-08-27 | 3 lượt đo chốt — `root_cause` ~87,7% | 0/67 |
| **2026-08-31** | **`32478c8` nối `_sanitized_content` vào `explain_diagnostics` / `explain_detection_cluster`** | — |
| 2026-09-01 | lượt đo sau khi nối guard — `root_cause` 75,76% | **18/68** |

Guard vốn dành cho `/chat` (nơi model không được nhắc lại prompt) bị áp lên đường phân tích
(nơi model **được lệnh** viết đúng những câu đó). Phát lại 269 câu trả lời đúng đã lưu qua guard
cũ: **bị chặn 16,4%**.

---

## 3. Đã sửa những gì

### 3.1. `src/services/leak_guard.py` — bỏ chấm điểm theo túi từ *(CRITICAL)*

- Bỏ `token_set_ratio`; chỉ giữ `partial_ratio` (nhạy thứ tự) — tách thành `_fuzzy_score()`.
- Tầng fuzzy phải trúng **≥ `MIN_FUZZY_FRAGMENTS` (=2)** mảnh khác nhau mới tính là rò rỉ.
  Lý do: prompt **ra lệnh** cho model viết câu "they are simultaneous symptoms of one shared
  event"; lặp lại đúng 1 câu đó là dấu hiệu của câu trả lời **đúng**, không phải lộ prompt.
  Rò rỉ thật tái hiện prompt theo chuỗi và trúng nhiều mảnh cùng lúc.
- Tầng khớp verbatim và khớp chuẩn hoá **giữ nguyên**, vẫn chặn chỉ với 1 lần trúng.

**Đo lại:** false positive **16,4% → 0/269** trên toàn bộ câu trả lời đúng của 4 lượt đo
đã lưu. Mọi mẫu tấn công vẫn bị bắt: dump verbatim cả 3 prompt, dump sai chính tả, dump
bị phá khoảng trắng.

`frontend/lib/server/leak-guard.ts` mang **đúng lỗi này** ở dạng word-overlap Jaccard — đã sửa
song song để hai bản không lệch nhau.

### 3.2. `src/services/llm.py` — làm cho thất bại im lặng trở nên nhìn thấy được *(HIGH)*

Cả hai cách hỏng (bị guard chặn, bị cắt token) đều cho ra `findings = {}` — cụm mất trắng mà
log không hề báo gì. Thêm:

- `llm.cluster_findings_empty` (warning): cụm có row nhưng không parse được finding nào, kèm
  cờ `withheld_by_leak_guard`.
- `llm.output_truncated` (warning): `finish_reason == "length"` (OpenAI) hoặc
  `stop_reason == "max_tokens"` (Anthropic); `truncated` cũng được thêm vào log info.

Đây là lý do vụ này âm thầm mất 12 điểm suốt nhiều ngày mà không ai thấy.

### 3.3. `src/config.py` + `.env.example` — nới cap output *(MEDIUM)*

`llm_max_tokens` và `anthropic_max_tokens`: **1024 → 2048**. Đo thật: cụm lớn nhất
(`C_10` #1, 17 row) tốn ~900 token output — biên an toàn quá mỏng, và khi vượt cap thì hỏng
**im lặng y hệt** ca bị chặn. Đây là biện pháp phòng ngừa, **không phải** nguyên nhân đã xảy ra.

---

## 4. Những đề xuất cũ **không** triển khai, và vì sao

| Đề xuất cũ | Quyết định | Lý do |
|---|---|---|
| #1 Structured Outputs (`response_format.json_schema`) | **Bỏ** | Mô tả sai code hiện có: `chat_completion()` không hề có tham số `json_object`. JSON hỏng cũng không phải cách hỏng thật — reply bị guard thay nguyên văn, không phải bị cắt. |
| #2 Gộp row theo `(topic,)` | **Hoãn, cần A/B** | Mâu thuẫn với một phép đo đã ghi trong `llm.py:650-656`: gộp rule lại từng làm per-fault **tụt 49/56 → 47/56**. Phần "explosion" là **đúng** (249 row cho 141 detection; gộp theo topic còn 139) nhưng phải đo mới đổi. |
| #3 `computed_hints` tính sẵn bằng Python | **Hoãn** | Chưa đo. Phần lớn tác dụng kỳ vọng đã có sẵn qua `_enforce_causal_order` / `_gate_actuator_primary`. |
| #4 Few-shot trong prompt | **Hoãn** | Chưa đo. Thêm example làm prompt dài thêm → tăng bề mặt cho chính leak guard. |
| #5 `temperature` 0,2 → 0,0 | **Không đổi** | Dao động 17 điểm là do guard (thay đổi code tất định), không do nhiệt độ. Sửa mù lúc này sẽ làm nhiễu phép đo. Dao động đo lại chỉ còn 3,03 điểm. |
| #6 Đổi `_CLUSTER_SLACK_SEC` | **Không đổi** | `docs/benchmark.md` đã đo `slack=0` **thắng** `slack=5`, hai dải không chồng lấn. |

### Claim trong bản cũ: đúng / sai

| Claim | Phán quyết |
|---|---|
| 66 cụm, `cluster_with_gt_pct` 95,45% | ✅ Đúng từng chữ số |
| `C_10` #1 → 17 row; `F4_04` #0 → 14; `F4_05` #0 → 13; `C_08` #0 → 12 | ✅ Đúng từng chữ số |
| Rule explosion gây phình payload | ✅ Đúng (249 row / 141 detection) |
| `F4_05` ground truth `/plan` không tồn tại trong bag | ✅ Đúng — bag không có detection nào trên `/plan`, bất khả thi |
| Truncation ở 1024 token là nguyên nhân chính | ❌ **Sai** — cụm bị chặn có cả cụm 1 detection; nội dung là `[blocked]`, không phải JSON cụt |
| `gpt-4o-mini` không ổn định, phải dùng `gpt-4.1` | ❌ **Sai** — sau khi sửa guard, dao động 3,03 điểm và ngang baseline `gpt-4.1` |
| `primary_rate_pct` 40,16% là "quá cao" | ❌ Diễn giải sai — con số đó bị **giảm giả tạo**: cụm bị chặn đóng góp 0 primary nhưng vẫn cộng vào mẫu số. Sau khi sửa là 58,61%. |

---

## 5. Kiểm chứng

```bash
python -m pytest tests/test_services/test_llm_security.py -q   # 50 passed
python -m pytest tests/ -q                                     # 470 passed
cd frontend && npx vitest run lib/server/leak-guard.test.ts     # 4 passed
python scripts/eval_root_cause.py --runs 3
```

Lớp test mới `TestLeakGuardPrecision` khoá chiều **precision** của guard: câu trả lời đúng
(lấy nguyên văn từ một lượt đo thật, cụm `F1_04` #1) không được bị giữ lại, trong khi
dump prompt verbatim / sai chính tả / phá khoảng trắng vẫn phải bị bắt.

## 6. Còn tồn

- `fault_diagnosed_pct` 83,93% vs mục tiêu 85% — khoảng cách là mức **gộp cụm quá tay**, xử lý
  bằng clustering chứ không phải bằng prompt.
- `primary_rate_pct` tăng 40,16% → 58,61%. Cần theo dõi: đây là con số thật lần đầu đo được sau
  khi hết cụm bị chặn, chưa có baseline sạch để so.
- Đề xuất #2 (gộp row theo topic) vẫn đáng đo A/B — có thể lấy nốt vài điểm còn thiếu.

> **Ghi chú dữ liệu:** các file `data/diagnostics/per_fault_*.json` dùng làm chứng cứ cho
> báo cáo này đã được xoá khi dọn dữ liệu cũ (2026-09-01). Chúng vẫn truy được trong lịch
> sử git. Số liệu hiện hành: `docs/benchmark.md` §10.
