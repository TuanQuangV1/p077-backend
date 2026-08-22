---
title: "Kế hoạch sửa tầng suy luận nhân quả (LLM root-cause)"
description: "Đưa root-cause accuracy từ 45% lên mức dùng được, bằng cách sửa clustering trước — không phải prompt, không phải model."
status: in-progress
priority: P1
effort: ~5-7 ngày
branch: feature/fix-detector-llm
tags: [llm, causal-ranking, clustering, root-cause, benchmark]
created: 2026-08-22
---

# Kế hoạch sửa tầng suy luận nhân quả (LLM root-cause)

**Cơ sở:** `report_optimizer.md` (rev-3) + 2 lần chạy benchmark thật ngày 2026-08-22 trên 38 faulty bag + 10 healthy bag, LLM thật (`gpt-4o-mini` baseline và `gpt-4.1`), tổng ~300 call, 0 fallback.

---

## 0. TRẠNG THÁI THỰC HIỆN — đã triển khai và đo lại (2026-08-22)

Phase 0–4 đã code xong, 294 test pass, và **đã chạy đánh giá LLM thật n=3** (198 call `gpt-4.1`, 0 fallback):

Hai vòng sửa, đo lại sau mỗi vòng (n=3, `gpt-4.1`, 0 fallback):

| Chỉ số | Baseline | Vòng 1 | **Vòng 2 (cuối)** | Tổng thay đổi |
|---|---:|---:|---:|---|
| **Root cause đúng (cấp cluster)** | 44,9% | 74,2% | **87,5%** | **+42,6 điểm** |
| Root cause cấp run (cái operator đọc) | — | 84,2% | **84,2%** | mới |
| Tỉ lệ gán `primary` | 82,7% | 50,1% | **47,7%** | −35,0 điểm |
| Số call LLM | 134 | 66 | **56** | **−58% chi phí** |
| Cluster chứa topic GT (trần lý thuyết) | 50,7% | 81,8% | **96,4%** | +45,7 |
| Cluster singleton | 24,6% | 18,2% | 21,4% | −3,2 |
| Detector recall | 98,2% | 98,2% | **98,2%** | không đổi ✅ |
| Healthy false positive | 0,2/bag | 0,2/bag | **0,2/bag** | không đổi ✅ |

Ước lượng ~73% ở §3.3 → vòng 1 thực đo 74,2%. Giả định nêu ở đó đã được kiểm chứng.

**Độ ổn định:** `root_cause_pct` **87,50% cả 3 lượt**; `primary_rate` dao động 47,34–49,11%. Ổn định hơn hẳn baseline (rev-3 ghi nhận chênh 3–5 điểm giữa 2 lượt) — payload có cấu trúc `layer` ràng buộc lựa chọn nên model không còn chọn theo khối lượng.

### Vòng 2 đã sửa gì, và cái gì thực sự có tác dụng

Bốn vấn đề đầu vào tìm được khi soi payload thật:

| # | Vấn đề | Trạng thái |
|---|---|---|
| 1 | **Cluster "đảo actuator"**: 10/12 cluster sai cấu trúc chỉ chứa `/cmd_vel`, không có topic thượng nguồn → sai chắc chắn | Sửa: luật **cấp run** — chỉ coi là mảnh cascade khi bản ghi có lỗi thượng nguồn ở chỗ khác (F4_03 có GT `/cmd_vel` thật vẫn giữ nguyên) |
| 2 | **Thời gian tuyệt đối**: gửi `tSec: 1815.0` cho bag dài 182s | Sửa: `start_sec`/`end_sec`/`duration_sec` tương đối + `recording.duration_sec` |
| 3 | **Sai đơn vị**: prompt bảo "trừ theo mili-giây", field `tSec` chứa **giây** → model xuất `"1815.0 ms"` | Sửa cả prompt lẫn tên field |
| 4 | **Trùng tên field**: `occurrence_count` ở row và trong `evidence` khác nghĩa (bug do bước nén cascade của vòng 1) | Đổi thành `merged_detections` |

**Phân rã trung thực về đóng góp** — số cluster trả lời đúng **không đổi: 49 cả hai vòng**; số cluster trả lời được cũng không đổi: 54. Độ chính xác có điều kiện đứng yên ở **90,7%**.

Nghĩa là **toàn bộ +13,3 điểm của vòng 2 đến từ việc loại 10 cluster vô vọng (#1)**. Ba sửa đổi về chất lượng đầu vào (#2, #3, #4) **không cải thiện độ chính xác đo được**. Chúng vẫn đáng giữ — model từng ghi `"1815.0 ms"` vào văn bản hiển thị cho người dùng, đó là sai sự thật — nhưng không được tính công vào con số 87,5%.

**5 cluster còn sai** (có topic GT trong payload nhưng model chọn nhầm) là dư địa duy nhất còn lại cho prompt/ranking. 2 cluster không thể trả lời là F4_05 (`/plan` không tồn tại trong bag — giới hạn dataset).

Việc còn lại: Phase 2 nối `runRootCause` vào API/UI, Phase 5 (CI gate), và các mục P0 hạ tầng ngoài phạm vi file này.

---

## 1. Kết luận điều hành — plan này đảo ngược thứ tự ưu tiên của rev-3

`report_optimizer.md` §4.2 xếp thứ tự đòn bẩy: **(1) pre-rank detection → (2) dependency graph gate → (3) sửa clustering**. Đo lại trực tiếp cho thấy **thứ tự này sai**, và làm theo nó sẽ đốt 2 sprint để thu về ~6 điểm.

Lý do, đo trên chính output production hiện tại (134 cluster / 38 bag):

| Nhóm cluster | Số lượng | Sửa được bằng gì |
|---|---:|---|
| LLM chọn **đúng** root cause | 61 (45,5%) | — |
| Chọn sai, **nhưng topic gốc CÓ trong cluster** | 7 (5,2%) | pre-ranking / dependency gate |
| Chọn sai, **topic gốc KHÔNG hề có trong cluster** | 66 (49,3%) | **chỉ clustering sửa được** |

**66/73 ca sai (90%) là do topic gốc không nằm trong payload gửi cho LLM.** Không prompt nào, không model nào, không guard nào bắt được LLM gọi tên một topic mà nó chưa từng nhìn thấy. Trần của toàn bộ hướng "pre-ranking + gate + prompt" là **50,7%** — tăng 5,8 điểm so với 44,9% hiện tại.

Bằng chứng phụ trợ, độc lập: đổi model `gpt-4o-mini` → `gpt-4.1` (mạnh hơn nhiều, đắt hơn ~13×) cho kết quả **44,9% vs 45,0%** — không đổi. Vấn đề nằm ở dữ liệu đầu vào, không nằm ở năng lực suy luận.

**Thứ tự đúng: clustering → run-level aggregation → payload shaping → contract/plumbing.**

---

## 2. Cơ sở đo lường

### 2.1 Hai lần chạy 2026-08-22

| Hạng mục | Lần 1 (nhiễm) | **Lần 2 (sạch, dùng làm baseline)** |
|---|---|---|
| Model | `gpt-4.1` | `gpt-4.1` |
| Ngưỡng detector | **bị ghi đè giữa chừng** qua `POST /api/v1/analysis/thresholds` (`frequency_gap_min_threshold_sec` 0,08→0,06) | mặc định `diagnostics_config.py:19` |
| Healthy false positive | 42 detection (4,2/bag) — **artefact** | **2 detection (0,2/bag)** |
| Root cause đúng | 36,7% | **44,9%** |

Lần 1 bị loại. Nguyên nhân: backend đang chạy ghi `data/diagnostics/thresholds.json` trong lúc benchmark đọc cùng file. **Bài học vận hành:** mọi lần đo phải chạy với backend tắt hoặc `DIAGNOSTICS_THRESHOLDS_FILE` trỏ tới file riêng — đưa vào Phase 0.

### 2.2 Baseline chốt (lần 2, sạch)

| Chỉ số | Giá trị | Đối chiếu rev-3 (`gpt-4o-mini`) |
|---|---:|---|
| Detector — đúng topic + cửa sổ | 55/56 (98,2%) | 55/57 (96,5%) — không đổi bản chất |
| Healthy false positive | 2 / 10 bag (0,2/bag) | 0,2/bag — **trùng khít** |
| Số cluster | 134 | 140 |
| Cluster singleton | 33 (24,6%) | 25% — **trùng khít** |
| Detection gán `primary` | 446/539 (82,7%) | 91,9% |
| **Root cause đúng (cấp cluster)** | **61/136 (44,9%)** | **45,0%** — **trùng khít** |
| Bag có **ít nhất một** cluster đúng | **36/38 (94,7%)** | 94,9% |

Hai kết luận rút ra ngay từ bảng này:

1. **Detector độc lập hoàn toàn với LLM** — mọi chỉ số detector không đổi khi đổi model. Đúng như thiết kế (detector là rule-based, `diagnostics.py:1`). Không cần đụng tới.
2. **Tín hiệu đúng đã tồn tại ở 94,7% số bag** nhưng bị phân tán ra nhiều cluster, và hệ thống không có bước nào hợp nhất chúng lại. Đây là mỏ vàng chưa khai thác — xem Phase 2.

### 2.3 Failure mode: một kiểu sai duy nhất chiếm 84%

Phân bố topic được LLM nêu làm nguyên nhân đầu tiên:

| Topic | Số lần được chọn | Số lần **sai** | Là GT thật của |
|---|---:|---:|---:|
| `/cmd_vel` | 64 | **61** | 3 bag |
| `/tf` | 16 | 6 | 12 bag |
| `/scan` | 22 | 5 | 13 bag |
| `/imu` | 23 | 0 | 12 bag |
| `/odom` | 9 | 1 | 7 bag |

**61/73 ca sai (83,6%) là cùng một lỗi: gọi tên `/cmd_vel` — nạn nhân cuối chuỗi — làm thủ phạm.** `/cmd_vel` là actuator cuối cùng của chuỗi `sensor → localization → planner → controller`; nó chết theo mọi lỗi thượng nguồn, và vì chết theo nên nó sinh ra nhiều detection nhất, áp đảo model theo khối lượng.

Nhưng **không được** đặt luật cứng "`/cmd_vel` không bao giờ là primary": nó là GT thật của 3 bag. Gate phải có điều kiện — xem Phase 3.

### 2.4 Thực nghiệm clustering (offline, không tốn call LLM)

Chạy lại thuật toán gom cụm với các tham số khác nhau trên **cùng một bộ detection**, đo xem topic gốc có nằm cùng cluster với cascade của nó không:

| Thuật toán | Số cluster | Singleton | **Cluster chứa topic GT** | Cluster cascade thuần |
|---|---:|---:|---:|---:|
| **onset-gap 5s (đang chạy)** | 134 | 24,6% | **50,7%** | 49,3% |
| onset-gap 10s | 106 | 26,4% | 58,5% | 41,5% |
| onset-gap 20s | 78 | 28,2% | 74,4% | 25,6% |
| onset-gap 45s | 52 | 30,8% | 88,5% | 11,5% |
| interval-overlap slack 0s | 91 | 26,4% | 69,2% | 30,8% |
| **interval-overlap slack 5s** | **66** | **18,2%** | **81,8%** | **18,2%** |
| interval-overlap slack 10s | 53 | 15,1% | 84,9% | 15,1% |

**Đọc bảng này kỹ — nó quyết định thiết kế:**

- Nới rộng onset-gap **không phải** lời giải: nó tăng `with_GT` nhưng **singleton tăng theo** (24,6% → 30,8%), vì mọi sự kiện lẻ ở xa vẫn tự tạo cụm riêng. Đổi một vấn đề lấy một vấn đề khác.
- **Interval-overlap giảm cả hai cùng lúc**: singleton 24,6% → 18,2%, cluster cascade thuần 49,3% → 18,2%. Lý do bản chất: nó gom theo **khoảng thời gian sự kiện thật sự kéo dài** (`tSec` → `endSec`), không theo khoảng cách điểm khởi phát. Một TF gap 40s và một `/cmd_vel` stall 38s **chồng lấn nhau về thời gian** dù onset cách nhau 3s hay 30s — chúng là một sự cố.
- So ở cùng mật độ (~52 vs 53 cluster): onset-gap 45s cho 30,8% singleton, interval-overlap 10s cho 15,1%. Interval-overlap **thắng tuyệt đối**, không phải thắng nhờ chọn tham số đẹp.
- Phụ phẩm: số call LLM giảm **134 → 66 (−51%)**, tức chi phí vận hành giảm một nửa trong khi chất lượng tăng.

---

## 3. Phân tích nguyên nhân gốc

### 3.1 Cơ chế hỏng

`analysis.py:320` `_cluster_detections` cắt cụm khi khoảng cách **onset** giữa 2 detection liên tiếp vượt `_CLUSTER_WINDOW_SEC = 5.0` (`analysis.py:78`).

Với một sự cố thật kéo dài 40 giây:

```
t=55.0   tf_missing_gap /tf      (fault gốc, kéo dài tới t=95.0)
t=58.3   silent_node /cmd_vel    (hệ quả — cùng cluster, OK)
t=71.5   frequency_gap /cmd_vel  (hệ quả — onset cách 13,2s > 5s → CỤM MỚI)
t=88.1   message_drop /cmd_vel   (hệ quả — CỤM MỚI nữa)
```

Cụm 2 và cụm 3 **chỉ chứa `/cmd_vel`**. LLM đọc chúng, thấy duy nhất `/cmd_vel` hỏng, và kết luận đúng theo dữ liệu nó được cấp: *"`/cmd_vel` failed"*. Model không sai — **payload sai**.

Đây chính là 66 cluster "cascade thuần" ở §1, và là 61 ca `/cmd_vel` ở §2.3. Ba con số này là **cùng một hiện tượng nhìn từ ba góc**.

### 3.2 Vì sao rev-3 quy sai nguyên nhân

rev-3 đã ablate đúng `_enforce_simultaneity` (2,1 điểm — đúng, giữ nguyên kết luận đó) và đúng khi nói "model tự gán 90,5% primary ở raw output". Nhưng nó suy ra rằng vấn đề là **thứ tự trình bày trong payload**, nên xếp pre-ranking lên #1.

Điều rev-3 chưa đo: **có bao nhiêu cluster chứa sẵn topic gốc để mà xếp lại thứ tự**. Câu trả lời là 50,7%. Pre-ranking chỉ thao tác được trên nửa số cluster, và trong nửa đó model vốn đã chọn đúng 61/68 = **89,7%**. Dư địa còn lại: 7 cluster.

Không mâu thuẫn với rev-3 — bổ sung phép đo rev-3 thiếu, và phép đo đó đảo thứ tự ưu tiên.

### 3.3 Trần lý thuyết sau khi sửa

Với interval-overlap slack 5s: **81,8%** cluster chứa topic GT. Giữ nguyên tỉ lệ chọn đúng-khi-có-mặt hiện tại (89,7%):

```
0,818 × 0,897 ≈ 73%
```

**Đây là ước lượng, không phải cam kết.** Ghi rõ giả định để có thể bác bỏ: giả định tỉ lệ 89,7% giữ nguyên khi cluster to hơn (nhiều detection hơn → có thể khó hơn, hoặc dễ hơn vì có đủ ngữ cảnh nhân quả). Phải đo thật, n≥3, không dùng con số này làm gate.

rev-3 từng phải rút lại ước lượng "85%" vì suy từ giả định chưa kiểm chứng (§5.6). Plan này tránh lặp lại lỗi đó bằng cách: mỗi phase đo lại độc lập, và **chỉ chốt ngưỡng sau khi có số thật**.

---

## 4. Lộ trình

Nguyên tắc xuyên suốt: **mỗi bước đo riêng, không gộp**. Baseline để so là **44,9% / 82,7% primary / 134 cluster**.

### Phase 0 — Harness đo lường (0,5 ngày, chặn mọi phase sau)

Không sửa được thứ không đo được, và lần chạy 1 đã chứng minh phép đo hiện tại rất dễ nhiễm.

| Việc | Chi tiết |
|---|---|
| Script eval vào repo | `scripts/eval_root_cause.py` — detector + clustering + LLM, xuất JSON + bảng metric. Hiện script đang nằm ngoài repo (rev-3 §9 cũng ghi nhận điều này), không ai tái lập được |
| Cách ly threshold | Ép `DIAGNOSTICS_THRESHOLDS_FILE` trỏ file riêng của eval; fail-fast nếu phát hiện file override khác |
| Cache tách tầng | Cache detection ra đĩa (`detections_cache.json`) → sweep clustering/prompt **không tốn call LLM**. Đã chứng minh giá trị: toàn bộ §2.4 chạy 0 đồng |
| Metric chuẩn | `root_cause_hit` (topic đầu tiên ∈ GT), `primary_rate`, `cluster_count`, `singleton_pct`, `cluster_with_gt_pct`, `bag_level_hit`, `cost_usd` |
| n≥3 | Mỗi cấu hình chạy 3 lượt, báo cáo min/median/max. rev-3 đo được chênh lệch 3–5 điểm giữa 2 lượt cùng cấu hình ở temp 0,2 |

**Done khi:** `python scripts/eval_root_cause.py --config baseline --runs 3` tái lập 44,9% ± biến thiên đã biết.

**Rollback:** không có rủi ro — chỉ thêm script, không đụng production path.

---

### Phase 1 — Thay thuật toán clustering (1 ngày, ĐÒN BẨY CAO NHẤT)

**Sửa:** `analysis.py:320` `_cluster_detections`.

Thay tiêu chí "khoảng cách onset" bằng "chồng lấn khoảng thời gian":

```python
# Cũ: cắt khi onset[i] - onset[i-1] > 5.0
# Mới: gom khi [tSec, endSec] chồng lấn (có slack), theo dõi max endSec của cụm
if cur_end is None or start > cur_end + slack:
    clusters.append([])          # sự cố mới
    cur_end = end
else:
    cur_end = max(cur_end, end)  # nới cụm theo sự kiện dài nhất
```

Chi tiết thực thi:

- `_CLUSTER_WINDOW_SEC` → `_CLUSTER_SLACK_SEC = 5.0`, đưa vào `diagnostics_config.py` để tune được mà không sửa code.
- Detection tức thời (`endSec == tSec`) vẫn hoạt động đúng: slack đóng vai trò cửa sổ như cũ → **không có regression cho sự cố ngắn**.
- Giữ thứ tự trình bày theo onset trong cụm (rev-3 mục 4.2 ghi nhận: đảo thứ tự từng gây lật ngược nhân quả ở F3_01 — không lặp lại lỗi đó).

**Kỳ vọng đo được (đã xác nhận offline §2.4):** cluster 134→66, singleton 24,6%→18,2%, cluster-chứa-GT 50,7%→81,8%, chi phí LLM −51%.

**Rủi ro:** cụm quá to trên bag hỏng hệ thống → payload vượt context, hoặc nhiều sự cố độc lập bị nhập một. Giảm thiểu: cap số detection/cluster (Phase 3 nén cascade sẽ giải quyết triệt để); log phân bố kích thước cụm; nếu cụm > N detection thì tách theo topic-group.

**Rollback:** một hằng số + một hàm thuần, có test riêng. Revert 1 commit.

**Done khi:** metric §2.4 tái lập trên production path, và root-cause đo lại n≥3.

---

### Phase 2 — Kết luận cấp run, không phải cấp cluster (1 ngày)

Đây là phần rev-3 nêu thành câu hỏi mở (§9.5) nhưng chưa ai trả lời, và số liệu giờ đã trả lời rõ.

**Vấn đề:** hiện mỗi cluster sinh một `root_cause` độc lập (`analysis.py:353`). Một bag ra 3–4 kết luận mâu thuẫn nhau, UI không biết hiển thị cái nào, operator đọc trúng cái sai với xác suất >50%.

**Số liệu ủng hộ:** **94,7% bag đã có ít nhất một cluster đúng.** Tín hiệu có sẵn, chỉ thiếu bước chọn.

Theo rev-3 §5.5, chiến lược chọn cluster đại diện:

| Cách chọn | Đúng GT topic |
|---|---:|
| Cluster severity cao nhất | 89,7% |
| Cluster khởi phát sớm nhất | 79,5% |

**Thiết kế:** thêm bước hợp nhất sau `_build_ai_results`:

1. Mỗi cluster vẫn sinh kết luận riêng (giữ nguyên, phục vụ deep-dive từng sự cố).
2. Thêm **`runRootCause` cấp run**: chọn theo `(severity cao nhất, onset sớm nhất)` làm tie-break — kết hợp hai tín hiệu tốt nhất thay vì chọn một.
3. **Cluster singleton không được sinh kết luận nhân quả** — gắn `role="isolated"`, không claim primary. (rev-3 P1-11 yêu cầu đúng điều này.)
4. API trả cả hai; UI surface `runRootCause` làm kết luận chính, cluster-level làm drill-down.

**Kỳ vọng:** bag-level accuracy tiệm cận 89,7%+ — đây là con số operator thực sự cảm nhận, cao hơn hẳn cluster-level.

**Rủi ro:** bag có **nhiều fault độc lập thật** (C_04, C_06, C_09 có 3 fault) — ép về một root cause là sai. Giảm thiểu: `runRootCause` là **danh sách xếp hạng**, không phải một chuỗi; chỉ hợp nhất khi các cluster chồng lấn nhân quả, giữ riêng khi tách biệt về thời gian và topic-group.

**Done khi:** mỗi run có kết luận chính xác định, đo bag-level n≥3, và không gộp nhầm 2 fault độc lập trên C_04/C_06/C_09.

---

### Phase 3 — Định hình payload gửi LLM (1,5 ngày)

Đến đây mới tới lượt các việc rev-3 xếp #1. Sau Phase 1–2, dư địa còn lại nằm đúng ở đây.

**3a. Nén cascade theo topic** (làm trước — vừa tăng chất lượng vừa chống rủi ro cụm to của Phase 1)

13 detection `/cmd_vel` trong một cụm → **1 dòng** `{topic, kind_set, occurrence_count: 13, tSec, endSec}`. Model đang chọn theo khối lượng dòng; xoá khối lượng là xoá thiên lệch. Đồng thời giảm token, chống tràn context.

**3b. Pre-rank trước khi gửi**

Xếp theo vị trí trong chuỗi nhân quả ROS, không theo thời gian đơn thuần:
`sensor (/scan, /imu) → transform (/tf) → state (/odom, /amcl_pose) → planner (/plan) → actuator (/cmd_vel)`.
Gắn nhãn `layer` vào mỗi detection để model thấy cấu trúc, không phải đoán.

**3c. Dependency gate có điều kiện** (KHÔNG phải luật cứng)

```
Nếu cluster có anomaly ở tầng sensor/transform CHỒNG LẤN thời gian với anomaly /cmd_vel
   → /cmd_vel không được là primary (đánh dấu likely_cascade)
Nếu cluster CHỈ có /cmd_vel
   → /cmd_vel được phép primary  (đúng cho 3 bag GT thật)
```

Luật cứng sẽ sai ở 3 bag mà `/cmd_vel` là fault gốc thật — gate phải điều kiện.

**3d. `_enforce_simultaneity`: GIỮ NGUYÊN**

`llm.py:347`. Ablation rev-3: chỉ 2,1 điểm. Đã có snapshot đúng (`llm.py` — `primaries` snapshot trước vòng lặp, không lan truyền dây chuyền). Sửa nó là no-op. **Đây là anti-task, ghi rõ để không ai làm.**

**Rủi ro:** nén cascade làm mất chi tiết cho reviewer. Giảm thiểu: nén **chỉ ở payload gửi LLM**, evidence đầy đủ vẫn giữ nguyên trong store và UI.

**Done khi:** đo riêng từng bước 3a → 3b → 3c, mỗi bước n≥3, biết chính xác bước nào đóng góp bao nhiêu.

---

### Phase 4 — Vá đường ống end-to-end (1 ngày)

Root cause đúng mà không tới được người dùng thì vô nghĩa. Bốn lỗi chặn E2E, đã xác minh lại hôm nay:

| Lỗi | Vị trí | Bằng chứng xác minh 2026-08-22 |
|---|---|---|
| **Anomaly không có `id`** → HILT route luôn 404 | `routes.py:827`, `:868` so khớp `a.get("id")` | Dump key thật của **toàn bộ detection trên 38 bag**: `['confidence','endSec','evidence','kind','severity','tSec','topic']` — **không có `id`**. Xác nhận 100% |
| **HILT trả canned 100%** | `iterative_debug.py:211` dùng `.type_` (Pydantic v1), catch nuốt tại `:53` | Còn nguyên trong code hôm nay. Fix: `.annotation`, và thu hẹp `except` |
| **Ghi sai model/provider** | `analysis.py:74` `_DEFAULT_MODEL = "vllm/qwen2.5-coder-32b"` | Provider thật là OpenAI. Đã sửa một phần hôm nay (`_finalize_run_llm_usage` phân giải đúng 3 provider); còn `_DEFAULT_MODEL` |
| **Health panel bỏ sót kind** | `frontend/components/health/*` map 2/17 kind | 3 kind chiếm phần lớn khối lượng (`frequency_gap`, `silent_node`, `message_drop_burst`) không có nhánh render |

Thứ tự: sinh anomaly ID **tại detector layer** (`diagnostics.py`, ổn định theo `kind+topic+tSec`) → persist → HILT dùng xuyên suốt. Sửa `.type_`. Ghi model thật từ response.

**Rủi ro:** thêm `id` vào detection dict có thể phá test/contract đang so khớp dict. Giảm thiểu: chạy full 282 test; `id` là field thêm, không đổi field cũ.

---

### Phase 5 — Gate và chống regression (0,5 ngày)

- Golden set detector: khoá 98,2% recall + 0,2 FP/bag healthy — **chống regression khi tune clustering**.
- LLM regression: chạy `scripts/eval_root_cause.py` trong CI (nightly, không phải mỗi PR — tốn tiền thật).
- Mọi ngưỡng release đo **n≥3**, báo khoảng biến thiên.
- Ghi `prompt_version` + `clustering_version` vào mỗi run → so sánh giữa các lần được.

---

## 5. Việc KHÔNG làm (anti-tasks)

Ghi rõ để không ai đốt thời gian:

| Việc | Vì sao không |
|---|---|
| Sửa `_enforce_simultaneity` | Ablation rev-3: 2,1 điểm. Code đã snapshot đúng. No-op |
| Đổi sang model mạnh hơn | Đo thật hôm nay: `gpt-4.1` = 44,9% vs `gpt-4o-mini` 45,0%. Đắt hơn 13×, kết quả như nhau |
| Siết ngưỡng detector | Healthy chỉ 0,2 FP/bag. Siết sẽ giết cascade thật và kéo recall xuống. Cascade `/cmd_vel` là tín hiệu thật (rev-3 §5.4: healthy_01 có 3.568 message `/cmd_vel` → 0 detection) |
| Viết lại detector core | 98,2% đúng topic. Không phải nút thắt |
| Chỉ sửa prompt | Trần 50,7% — prompt không tạo ra dữ liệu không tồn tại trong payload |

---

## 6. Gate phát hành

**Detector (chống regression):**
- Recall đúng topic ≥ 98,2%; healthy ≤ 0,5 detection/bag, 0 ca high/critical.

**LLM root cause:**
- Cluster chứa topic GT ≥ 80% (baseline 50,7%) — *đo offline, không tốn tiền*.
- Cluster singleton ≤ 20% (baseline 24,6%).
- Tỉ lệ gán `primary` giảm rõ rệt so với 82,7%.
- Root cause cấp cluster: baseline **44,9%**, ước lượng sau Phase 1–3 ~73% (**chưa cam kết**).
- Root cause cấp run (bag-level): baseline 94,7% có-ít-nhất-một-đúng → mục tiêu là biến nó thành **kết luận được chọn** đúng.
- **Ngưỡng pass do đội robotics chốt theo use case** — chưa ai chốt, và đây là điều kiện chặn (rev-3 §9.3).
- Mọi phép đo n≥3.

**E2E:**
- HILT GET/POST hoạt động với anomaly thật; `suggest()` trả model thật, không `canned-fallback`.
- Run ghi đúng provider/model thật.
- UI hiển thị được cả 17 kind hoặc trạng thái unknown rõ ràng.

---

## 7. Rủi ro tổng thể

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Cụm to hơn → tràn context / nhập nhầm 2 fault độc lập | Cao | Phase 3a nén cascade (làm cùng đợt); cap kích thước; kiểm chứng riêng trên C_04/C_06/C_09 (3 fault/bag) |
| Ước lượng 73% không đạt | Trung bình | Đo từng bước, không gộp; sẵn sàng dừng ở mức đạt được và báo trung thực thay vì tune mù |
| Đo bị nhiễm như lần chạy 1 | Cao (đã xảy ra) | Phase 0 cách ly threshold + fail-fast |
| Chi phí LLM khi đo n≥3 | Thấp | Phase 1 giảm 51% call; cache detection cho sweep offline |

---

## 8. Tóm tắt thứ tự thực thi

```
Phase 0  Harness đo lường          0,5d   ← chặn tất cả
Phase 1  Clustering interval-overlap 1d   ← đòn bẩy cao nhất (50,7% → 81,8% ceiling)
Phase 2  Kết luận cấp run           1d    ← khai thác 94,7% tín hiệu đang có
Phase 3  Payload shaping           1,5d   ← nén cascade → pre-rank → gate có điều kiện
Phase 4  Vá E2E (ID, HILT, model)   1d    ← để kết quả đúng tới được người dùng
Phase 5  Gate + regression         0,5d
                            tổng ≈ 5,5 ngày
```

---

## 9. Câu hỏi chưa có lời giải

1. **Ngưỡng root-cause accuracy nào là chấp nhận được?** Baseline 44,9% cấp cluster / 94,7% bag-level-có-tín-hiệu. Chặn gate §6 và chặn việc biết Phase 1–3 đã xong hay chưa. **Đội robotics phải chốt.**
2. **Production trả một root cause cấp run hay nhiều cấp cluster?** Plan này đề xuất *cả hai* (run làm kết luận chính, cluster làm drill-down) — cần xác nhận trước khi làm Phase 2 vì nó đổi API contract.
3. **Bag nhiều fault độc lập** (C_04/C_06/C_09 có 3 fault): hợp nhất tới mức nào là đúng? Ảnh hưởng thiết kế Phase 2.
4. **Cascade `/cmd_vel` nên ẩn khỏi UI hay hiển thị kèm nhãn `consequence`?** Ảnh hưởng contract Phase 4.
5. **`/plan` không tồn tại trong bag `F4_05`** — lỗi injector hay recording config? Ảnh hưởng việc case này có tính vào recall không.
6. **Slack 5s hay 10s?** Slack 10s cho cluster-chứa-GT cao hơn (84,9%) và singleton thấp hơn (15,1%), nhưng gộp mạnh hơn → rủi ro nhập nhầm fault độc lập cao hơn. Quyết định sau khi chạy Phase 1 trên C_04/C_06/C_09.

---

*Số liệu: 2 lần chạy benchmark 2026-08-22 (38 faulty + 10 healthy bag, LLM thật, ~300 call, 0 fallback) + sweep clustering offline trên cùng bộ detection. Baseline dùng lần chạy sạch (backend tắt, ngưỡng mặc định). Ground truth: `~/ros2_doctor_ws/bags/`.*
