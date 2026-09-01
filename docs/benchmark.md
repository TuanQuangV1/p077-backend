# Benchmark chẩn đoán rosbag — hướng dẫn dùng chung

**Mục đích:** để bất kỳ ai trong nhóm có ý tưởng cải tiến đều đo được **ý tưởng đó tốt hơn hay tệ hơn**, bằng cùng một thước đo, trên cùng một bộ dữ liệu.

**Cập nhật:** 2026-09-01 · **Script:** `scripts/eval_root_cause.py`
Lần đo hiện hành và cách nó ra đời: §10.

---

## 1. Đọc nhanh: hệ thống đang ở đâu

48 bag có nhãn (`~/ros2_doctor_ws/bags/`: 38 faulty + 10 healthy), `gpt-4o-mini`, n=3,
**median [min–max]**. Đo 2026-09-01 sau khi sửa leak guard (§10). Cột `gpt-4.1` giữ lại
làm mốc đối chiếu vì đó là model mạnh hơn ~13× giá.

| Chỉ số | gpt-4.1 (mốc đối chiếu) | **gpt-4o-mini (hiện hành)** | Ý nghĩa một câu |
|---|---:|---:|---|
| Phát hiện lỗi (detector) | 98,2% | **98,21%** (55/56) | Bắt đúng topic + đúng lúc so ground truth — *độc lập model* |
| Báo nhầm (bag sạch) | 0,2 /bag | **0,20 /bag** (2/10) | *Độc lập model* |
| Trần lý thuyết (cụm có manh mối) | 96,9% | **95,45%** (66 cụm) | 3/66 cụm không chứa topic ground truth |
| **Chỉ đúng nguyên nhân** | 87,7% [87,7–89,2] | **87,88%** [86,36–89,39] | Ngang mốc đối chiếu |
| Kết luận chính của bản ghi | 81,6% [81,6–84,2] | **86,84%** [84,21–89,47] | +5,2 điểm |
| Bag có ≥1 kết luận đúng | 86,8% | **86,84%** [86,84–89,47] | Ngang |
| **Mỗi lỗi có chẩn đoán riêng** | 82,1% [82,1–83,9] | **83,93%** [82,14–87,50] | +1,8 điểm — chỉ số khắt khe nhất |
| Dao động `root_cause_pct` giữa 3 lượt | 1,5 điểm | **3,03 điểm** | Đủ ổn định để chốt release |
| Chi phí một lượt (66 cụm) | ~0,48 USD | **~0,03 USD** | rẻ hơn ~16× |

**Kết luận:** `gpt-4o-mini` đạt **ngang mốc `gpt-4.1`** trên cả `root_cause_pct` lẫn
`fault_diagnosed_pct`, với chi phí thấp hơn ~16 lần — **không cần đổi sang model mạnh hơn.**
Phần luật cứng (detector + clustering) giữ nguyên chất lượng qua toàn bộ thay đổi.

Trên phần *khả thi* (trừ 3 cụm không chứa ground truth): **58/63 = 92,1%**.

Điểm xuất phát trước khi tối ưu: **44,9%**. Xem §6 để biết cái gì đã tạo ra mức tăng.

---

## 2. Chạy như thế nào

```bash
# Đo cấu hình hiện tại, 3 lượt (dùng cho quyết định release)
python scripts/eval_root_cause.py --runs 3

# Chỉ đo detector + cấu trúc cụm — KHÔNG tốn đồng nào, chạy trong ~2 phút
python scripts/eval_root_cause.py --detector-only

# Thử một tham số gom cụm khác
python scripts/eval_root_cause.py --runs 1 --slack 2.0

# Đọc lại bag từ đầu (sau khi sửa detector)
python scripts/eval_root_cause.py --detector-only --refresh-cache
```

**Điều kiện tiên quyết:** tắt backend trước khi đo (`uvicorn`), và đảm bảo `.env` có `LLM_PROVIDER` + API key hợp lệ.

---

## 3. Dữ liệu dùng để chấm

48 bản ghi ROS 2 thật tại `~/ros2_doctor_ws/bags/`:

- **38 bag "faulty"** — đã cố ý tiêm **56 lỗi** (ngắt cảm biến, lệch đồng hồ, mất transform, dữ liệu NaN, node crash…). Mỗi bag có file `*_ground_truth.json` ghi rõ lỗi loại gì, ở topic nào, từ giây nào tới giây nào.
- **10 bag "healthy"** — không có lỗi nào, dùng để đo báo động giả.

Đây không phải dữ liệu giả lập trong test — là bản ghi Gazebo thật, đọc qua đúng hàm mà production dùng.

> **Lưu ý:** bag `F5_02` (giá trị `Inf` trên LiDAR) đã được loại khỏi bộ đánh giá. Theo chuẩn `sensor_msgs/LaserScan`, `Inf` là giá trị **hợp lệ** khi vật cản quá xa/gần để đo — không phải lỗi.

---

## 4. Sáu chỉ số, và nên nhìn cái nào

Chạy xong bạn sẽ thấy ba khối. Đây là ý nghĩa từng con số:

### Khối `detector` — tầng phát hiện (rule-based, không dùng AI)

| Chỉ số | Nghĩa |
|---|---|
| `recall_pct` | % lỗi tiêm được phát hiện. Tính là "bắt được" khi có cảnh báo **đúng topic** và **trùng cửa sổ thời gian ±10s** |
| `healthy_per_bag` | Số cảnh báo trung bình trên bag khỏe mạnh. **Càng thấp càng tốt** |

### Khối `clustering` — chất lượng dữ liệu đưa cho AI (miễn phí, không gọi LLM)

| Chỉ số | Nghĩa |
|---|---|
| `cluster_with_gt_pct` | **Quan trọng nhất để chẩn đoán vấn đề.** % cụm thực sự *chứa* topic bị lỗi. Cụm không chứa thì AI dù giỏi mấy cũng không đoán ra — đây là **trần** của `root_cause_pct` |
| `singleton_pct` | % cụm chỉ có 1 cảnh báo. Cụm một phần tử không có gì để so sánh nên buộc phải tự nhận là nguyên nhân |
| `clusters` | Số cụm = **số lần gọi LLM** = chi phí |

### Khối `LLM root cause` — chất lượng suy luận

| Chỉ số | Nghĩa | Dùng khi nào |
|---|---|---|
| `root_cause_pct` | Trong mọi kết luận sinh ra, % chỉ đúng thủ phạm | Chỉ số chính, so sánh giữa các phiên bản |
| **`fault_diagnosed_pct`** | **Mỗi lỗi tiêm có được một kết luận riêng nêu đúng topic của nó không** | Khắt khe nhất, gần thực tế nhất — xem cảnh báo bên dưới |
| `run_level_pct` | % bản ghi mà **kết luận chính** (cái hiện đầu tiên trên UI) đúng | Con số operator thực sự cảm nhận |
| `primary_rate_pct` | % cảnh báo bị gán nhãn "là nguyên nhân chính" | **Càng thấp càng tốt** trong khoảng hợp lý — nếu 90% cảnh báo đều là "nguyên nhân" thì hệ thống không phân biệt được gốc và ngọn |
| `bag_any_correct_pct` | % bag có **ít nhất một** kết luận đúng | Chỉ số dễ dãi, đừng dùng để khoe |

> ### ⚠️ Vì sao phải có `fault_diagnosed_pct`
>
> `root_cause_pct` tính một cụm là đúng khi nó nêu **bất kỳ** topic lỗi nào của bag đó. Nếu một bag có 3 lỗi mà hệ thống gộp cả 3 vào một cụm rồi chỉ nêu 1 lỗi, `root_cause_pct` vẫn cho **100%** — trong khi thực tế 2 lỗi bị bỏ quên hoàn toàn.
>
> `fault_diagnosed_pct` đếm theo **từng lỗi**: mỗi lỗi tiêm phải có một kết luận nêu đúng topic của nó, trong đúng khoảng thời gian của nó. Đây là lý do con số này (82,1%) thấp hơn `root_cause_pct` (87,7%) — và khoảng chênh đó chính là mức độ gộp quá tay.
>
> **Khi so sánh ý tưởng mới, báo cáo cả hai.** Một thay đổi làm tăng `root_cause_pct` nhưng giảm `fault_diagnosed_pct` là đang gộp bừa để ăn điểm.

---

## 5. Tôi có ý tưởng mới — làm sao so sánh?

### Bước 1 — Xác định ý tưởng thuộc tầng nào

| Ý tưởng của bạn về… | Sửa ở đâu | Đo bằng |
|---|---|---|
| Luật phát hiện mới, ngưỡng mới | `src/services/diagnostics.py`, `diagnostics_config.py` | `--detector-only --refresh-cache` (miễn phí) |
| Cách gom cảnh báo thành sự cố | `_cluster_detections` trong `analysis.py` | `--detector-only` (miễn phí) → rồi mới chạy LLM |
| Dữ liệu/thứ tự gửi cho AI, prompt | `_shape_cluster_payload`, `_CLUSTER_SYSTEM_PROMPT` trong `llm.py` | Phải chạy LLM thật |
| Hậu xử lý vai trò nguyên nhân/hệ quả | `_gate_actuator_primary`, `_enforce_simultaneity` | Phải chạy LLM thật |

### Bước 2 — Đo miễn phí trước

Nếu ý tưởng ảnh hưởng tới **cụm**, chạy `--detector-only` trước. Chỉ số `cluster_with_gt_pct` cho biết ngay ý tưởng có nâng được **trần** không — không tốn một xu nào.

Ví dụ thật: toàn bộ bảng so sánh 7 cách gom cụm khác nhau chạy hết **0 đồng**, và nó thu hẹp được danh sách ứng viên trước khi tiêu một xu nào cho LLM.

### Bước 3 — Chạy LLM thật, tối thiểu 3 lượt

```bash
python scripts/eval_root_cause.py --runs 3
```

Script in ra `median / min / max`. **So dải giá trị, đừng so median** — xem §6.1 để biết vì sao so median dẫn tới kết luận sai. Bằng chứng mạnh nhất là hai dải **không chồng lấn** nhau.

### Bước 4 — Báo cáo theo mẫu này

```
Ý tưởng:           <mô tả một câu>
Sửa file:          <đường dẫn>
root_cause_pct:    87,7% [87,7-89,2] → XX,X% [XX,X-XX,X]   (n=3)
fault_diagnosed:   82,1% [82,1-83,9] → XX,X% [XX,X-XX,X]
cluster_with_gt:   96,9% → XX,X%
số cụm (chi phí):  65 → XX
detector recall:   98,2% → XX,X%   ← phải KHÔNG giảm
healthy FP:        0,2 → X,X /bag  ← phải KHÔNG tăng
```

---

## 6. Baseline hiện tại đến từ đâu

Ba mốc, mỗi mốc đo lại đầy đủ:

Bốn mốc, mỗi mốc đo lại đầy đủ. Ba mốc đầu đo bằng `gpt-4.1`; mốc 4 là `gpt-4o-mini`
sau khi sửa leak guard (§10).

| | Ban đầu | Vòng 1 | Vòng 2 | Vòng 3 | **Vòng 4 (hiện hành)** |
|---|---:|---:|---:|---:|---:|
| `root_cause_pct` | 44,9% | 74,2% | 87,5% | 87,7% | **87,88%** |
| `fault_diagnosed_pct` | — | — | 80,4% | 82,1% | **83,93%** |
| `cluster_with_gt_pct` | 50,7% | 81,8% | 96,4% | 96,9% | **95,45%** |
| `primary_rate_pct` | 82,7% | 50,1% | 47,7% | 50,8% | **58,61%** |
| Số cụm (chi phí) | 134 | 66 | 56 | 65 | **66** |
| Detector recall | 98,2% | 98,2% | 98,2% | 98,2% | **98,21%** |

> `primary_rate_pct` vòng 4 cao hơn hẳn vì ba vòng trước bị **giảm giả tạo**: cụm bị leak
> guard chặn đóng góp 0 primary nhưng vẫn cộng vào mẫu số. 58,61% là con số thật đầu tiên
> đo được, chưa có mốc sạch để so.

**Vòng 1 — sửa cách gom cụm.** Trước đây gom theo *khoảng cách điểm bắt đầu* (cách nhau quá 5s là tách cụm). Một sự cố mất transform kéo dài 40 giây bị cắt vụn, nên cảnh báo gốc và hậu quả của nó rơi vào hai cụm khác nhau. Đổi sang gom theo *chồng lấn khoảng thời gian*: hai cảnh báo cùng đang diễn ra thì thuộc cùng một sự cố. Cộng thêm nén cảnh báo lặp và sắp xếp theo tầng dữ liệu ROS.

**Vòng 2 — loại "cụm cụt".** Phát hiện 10/12 cụm sai có cùng một hình dạng: chỉ chứa `/cmd_vel` (lệnh điều khiển), không có topic thượng nguồn nào. Hỏi nguyên nhân những cụm này thì **sai chắc chắn**, vì đáp án duy nhất có thể là chính `/cmd_vel`.

Nhưng không được bỏ vô điều kiện — bag `F4_03` có lỗi thật đúng là `/cmd_vel`. Nên luật xét ở **cấp bản ghi**: chỉ coi là mảnh vụn khi bản ghi đó có lỗi thượng nguồn ở chỗ khác.

### Điều đáng nói: cái gì KHÔNG có tác dụng

Vòng 2 còn sửa 3 vấn đề chất lượng đầu vào — thời gian tuyệt đối (gửi `tSec: 1815.0` cho bag dài 182 giây), sai đơn vị (prompt nói mili-giây, dữ liệu là giây), và hai field trùng tên khác nghĩa.

**Cả ba không cải thiện độ chính xác một điểm nào.** Số cụm trả lời đúng giữ nguyên 49 ở cả hai vòng; toàn bộ mức tăng +13,3 điểm đến từ việc loại 10 cụm vô vọng.

Vẫn giữ các sửa đổi đó vì model từng ghi `"1815.0 ms"` vào văn bản hiển thị cho người dùng — sai sự thật cần sửa — nhưng **không tính công vào con số 87,5%**.

Bài học cho người đến sau: **sửa cấu trúc dữ liệu (cụm nào chứa gì) có tác dụng; đánh bóng cách trình bày thì không.**

**Vòng 3 — bỏ khoảng đệm gom cụm** (`slack` 5s → 0s). Xem §6.1 — đáng đọc vì nó là ví dụ mẫu về cách đọc số liệu cho đúng.

**Vòng 4 — sửa leak guard chặn nhầm kết luận đúng** (§10). Không đụng gì tới detector, clustering hay prompt: chỉ gỡ một bộ lọc bảo mật đang âm thầm vứt bỏ ~1/4 số kết luận. Đây là mốc duy nhất mà mức tăng đến từ việc **thôi làm hỏng**, chứ không phải làm thêm.

### Đã thử và bác bỏ

| Ý tưởng | Kết quả đo | Kết luận |
|---|---|---|
| Đổi sang model mạnh hơn (`gpt-4o-mini` → `gpt-4.1`, đắt gấp ~13 lần) | 45,0% → 44,9% | **Không tác dụng.** Vấn đề ở dữ liệu vào, không ở model |
| Nới rộng cửa sổ gom cụm (5s → 45s) | Cụm chứa manh mối tăng, nhưng cụm một phần tử tăng 24,6% → 30,8% | Đổi vấn đề này lấy vấn đề khác |
| Gom cụm "đệm một chiều" (chỉ áp đệm khi topic mới ở tầng thấp hơn) | Gộp nhầm 5 (so với 4 của `slack=0`), lỗi tách riêng 44/56 (so với 47/56) | Nghe hợp lý nhưng thua `slack=0` thuần |
| Sửa hậu xử lý `_enforce_simultaneity` | Chỉ chiếm 2,1 điểm | Không đáng làm |
| Siết ngưỡng detector cho bớt nhiễu | Bag sạch chỉ có 0,2 cảnh báo/bag | Không có nhiễu để siết; siết sẽ giết tín hiệu thật |

### 6.1 Ví dụ mẫu: cách đọc số cho đúng (đọc kỹ phần này)

Thí nghiệm bỏ khoảng đệm gom cụm (`slack` 5s → 0s) là ví dụ tốt nhất về việc **đọc sai số liệu dẫn tới kết luận sai hai lần liên tiếp**.

**Giả thuyết:** khoảng đệm 5 giây là di sản từ thuật toán gom cụm cũ (gom theo *khoảng cách điểm bắt đầu*), nơi nó cần để bắt độ trễ lan truyền. Thuật toán mới gom theo *chồng lấn thời gian* thì độ trễ đó đã được bao phủ sẵn — hậu quả xuất hiện lúc nguyên nhân còn đang diễn ra thì đã chồng lấn rồi. Đệm thêm chỉ còn tác dụng gộp nhầm hai lỗi cách nhau vài giây.

**Lần đọc 1 — n=1, kết luận SAI:** thấy `root_cause` 89,2% (so với 87,5%) và `fault_diagnosed` 83,9% (so với 80,4%) → tưởng thắng lớn +3,6 điểm.

**Lần đọc 2 — n=3 nhưng so median, vẫn SAI:** thấy median `run_level` 81,6% so với 84,2% → tưởng thay đổi làm tệ đi 2,6 điểm, định bỏ.

**Lần đọc 3 — n=3, so dải giá trị, ĐÚNG:**

| Chỉ số | `slack=5` [min–max] | `slack=0` [min–max] | Kết luận |
|---|---:|---:|---|
| `root_cause_pct` | 85,71–87,50 | **87,69–89,23** | `slack=0` thắng — **dải không chồng lấn** |
| `fault_diagnosed_pct` | 78,57–80,36 | **82,14–83,93** | `slack=0` thắng — **dải không chồng lấn** |
| `run_level_pct` | 81,58–84,21 | 81,58–84,21 | **Hoà — dải giống hệt nhau** |
| Số cụm (chi phí) | 56 | 65 (+16%) | Giá phải trả |

**Quyết định: đổi sang `slack = 0`** (mặc định hiện tại).

Ba bài học, xếp theo mức độ dễ mắc:

1. **So dải giá trị, đừng so median.** Chênh lệch median 84,2 vs 81,6 nhìn như thua 2,6 điểm, nhưng hai dải **trùng khít nhau** (81,58–84,21 cả hai) — khác biệt chỉ do giá trị nào lặp 2/3 lần. Ngược lại, chênh lệch median 87,5 vs 87,7 nhìn như hoà, nhưng hai dải **không hề chồng lấn**: giá trị *tệ nhất* của `slack=0` vẫn tốt hơn giá trị *tốt nhất* của `slack=5`. Đó mới là bằng chứng thật.
2. **Một lượt chạy đủ để tự lừa mình.** Con số 89,2% ở n=1 là lần may nhất trong dải.
3. **Giả thuyết hợp lý về lý thuyết vẫn phải đo.** Biến thể "đệm một chiều" nghe còn thuyết phục hơn nhưng đo ra thua.

---

## 7. Hai cái bẫy làm hỏng phép đo

### Bẫy 1 — Ngưỡng bị ghi đè giữa chừng

**Đã xảy ra thật.** Backend đang chạy ghi đè `data/diagnostics/thresholds.json` trong lúc benchmark đọc cùng file đó. Kết quả: báo động giả trên bag sạch vọt từ 0,2 lên **4,2/bag**, và `root_cause_pct` tụt 8 điểm — toàn bộ lần đo phải huỷ.

Script giờ tự ghim `DIAGNOSTICS_THRESHOLDS_FILE` vào file riêng và **từ chối chạy** nếu phát hiện override khác. Nhưng vẫn nên **tắt backend trước khi đo**.

### Bẫy 2 — Chạy một lượt rồi kết luận

LLM không cho kết quả giống hệt nhau giữa các lượt. Cấu hình hiện tại dao động **3,03 điểm** trên `root_cause_pct` (86,36–89,39 qua 3 lượt), nên **vẫn phải chạy `--runs 3`** trước khi kết luận một thay đổi là cải thiện — chênh lệch dưới 3 điểm giữa hai cấu hình là nhiễu, không phải tín hiệu.

Cảnh báo kèm theo: dao động lớn **chưa chắc do model**. Khoảng dao động 17 điểm từng bị quy cho `gpt-4o-mini` hoá ra là một lỗi code tất định (§10). Nghi model trước khi loại trừ code là cách bỏ sót bug.

---

## 8. Giới hạn — cần biết khi trích số liệu

- **Chấm bằng so khớp tên topic**, không phải người chấm theo rubric. Đủ để phát hiện regression, **không** đo được chất lượng lập luận hay gợi ý sửa có dùng được không.
- **Ground truth được coi là chân lý tuyệt đối.** Cascade hợp lệ (ví dụ `/cmd_vel` chết vì mất transform) bị tính là "không khớp", nên một số con số là cận dưới.
- **Dữ liệu mô phỏng Gazebo**, chưa có bag từ robot thật.
- **Một model, một bộ dataset.** Chưa so sánh nhiều model một cách hệ thống.
- **3/66 cụm không thể trả lời đúng** vì không chứa topic ground truth; riêng bag `F4_05` có ground truth là `/plan` nhưng bag **không hề có detection nào** trên `/plan` — giới hạn dataset, không phải lỗi hệ thống. Đây là lý do trần lý thuyết là 95,45%.

---

## 9. Còn lại gì để làm

| Việc | Mức | Ghi chú |
|---|---|---|
| **Gộp quá tay**: 6/12 bag nhiều lỗi có số cụm ít hơn số lỗi | Cao | 3 ca gộp đúng (cửa sổ lỗi chồng lấn thật), 3 ca sai (`C_08`, `C_09`, `C_10`). Đây là lý do `fault_diagnosed_pct` chỉ 80,4% |
| 5 cụm có manh mối nhưng model chọn nhầm | Trung bình | Dư địa duy nhất còn lại cho prompt/ranking |
| Giao diện chỉ hiển thị 2/17 loại cảnh báo | ~~Cao~~ | Đã sửa — panel health đọc trực tiếp từ backend, không còn mock (xem `plan_final.md`) |
| ~~`runRootCause` chưa nối vào UI~~ | Xong | Đã render card "Run Root Cause" trong analysis workspace (Phase 1.4) |
| 3 lỗi detector (`_window_hz`, `_EVENT_DRIVEN_MESSAGE_TYPES`, pre-roll grace) | ~~Cao~~ | Đã sửa 2026-09-01, có test hồi quy trong `test_diagnostics.py`; §10 đã đo lại xác nhận detector không đổi |
| Chưa có rubric người chấm | Trung bình | Cần cho đánh giá chất lượng lập luận, không chỉ đúng/sai topic |

---

## 10. Lần đo hiện hành — `gpt-4o-mini`, n=3 (2026-09-01)

`eval_root_cause.py --runs 3` trên `~/ros2_doctor_ws/bags/` (38 faulty + 10 healthy),
`gpt-4o-mini`. So với lượt đo ngay trước đó, khác biệt duy nhất: `find_prompt_leaks()`
không còn chấm điểm theo túi từ.

### 10.1. Vì sao phải đo lại

`_sanitized_content()` được nối vào `explain_diagnostics` / `explain_detection_cluster`
ngày 2026-08-31 (`32478c8`). Guard đó viết cho `/chat`, chấm điểm bằng
`max(partial_ratio, token_set_ratio)` ngưỡng 85. `token_set_ratio` **bỏ qua thứ tự từ** —
nó chỉ hỏi "các từ của mảnh prompt có xuất hiện đâu đó không". Câu trả lời chẩn đoán thì
**buộc** phải dùng đúng từ vựng prompt ra lệnh (`sensor`, `transform`, `anomaly`,
`overlaps`), nên bị coi là lộ prompt và bị thay bằng `[blocked]`.

Hậu quả đo được: **18/68 cụm mất sạch `findings`** → mỗi cụm 0 điểm. Phát lại 269 câu
trả lời đúng đã lưu qua guard cũ: **chặn nhầm 16,4%**. Trên một câu trả
lời đúng, `partial_ratio` cao nhất chỉ **63** trong khi `token_set_ratio` chạm **85** —
toàn bộ false positive đến từ `token_set_ratio`.

### 10.2. Đã sửa gì

- Bỏ `token_set_ratio`, chỉ giữ `partial_ratio` (nhạy thứ tự).
- Tầng fuzzy phải trúng ≥ 2 mảnh khác nhau (`MIN_FUZZY_FRAGMENTS`) mới tính là rò rỉ —
  prompt *ra lệnh* cho model viết một số câu, nên lặp lại đúng 1 câu là dấu hiệu trả lời
  đúng. Tầng verbatim và tầng chuẩn hoá vẫn chặn chỉ với 1 lần trúng.
- `llm_max_tokens` 1024 → 2048, và thêm log `llm.output_truncated` /
  `llm.cluster_findings_empty` để hai cách hỏng này không còn im lặng.

False positive sau khi sửa: **0/269**. Mọi mẫu dump prompt (verbatim, sai chính tả, phá
khoảng trắng) vẫn bị bắt — xem `TestLeakGuardPrecision`.

### 10.3. Số đo

median [min–max] qua 3 lượt, `gpt-4o-mini`:

| Chỉ số | Trước khi sửa (guard hỏng) | **Hiện hành** | Δ | mốc `gpt-4.1` |
|---|---:|---:|---:|---:|
| `root_cause_pct` | 76,92 [67,69–78,46] | **87,88 [86,36–89,39]** | **+11,0** | 87,7 [87,7–89,2] |
| `fault_diagnosed_pct` | 71,43 [60,71–76,79] | **83,93 [82,14–87,50]** | **+12,5** | 82,1 [82,1–83,9] |
| `run_level_pct` | 76,32 [63,16–76,32] | **86,84 [84,21–89,47]** | +10,5 | 81,6 [81,6–84,2] |
| `bag_any_correct_pct` | 81,58 [73,68–84,21] | **86,84 [86,84–89,47]** | +5,3 | 86,8 |
| `primary_rate_pct` | 35,77 | 58,61 | — | — |
| Dao động `root_cause_pct` | 10,8 điểm | **3,03 điểm** | −7,8 | 1,5 điểm |

Detector không đổi: `recall_pct` 98,21 · `healthy_per_bag` 0,20 · `cluster_with_gt_pct` 95,45.

`primary_rate_pct` tăng vì con số cũ **bị giảm giả tạo**: cụm bị chặn đóng góp 0 primary nhưng
vẫn cộng vào mẫu số. 58,61% là con số thật đầu tiên đo được — chưa có baseline sạch để so.

### 10.4. Kết luận

| Tầng | Trạng thái |
|---|---|
| **Detector + clustering** | ✅ Không đổi qua toàn bộ thay đổi. |
| **LLM root cause, `gpt-4o-mini`** | ✅ 87,88% median, dao động 3,03 điểm — **ngang `gpt-4.1`**, rẻ hơn 24×. |
| **Trần còn lại** | `cluster_with_gt_pct` 95,45% → 3/66 cụm không chứa topic ground truth. Trên phần khả thi: 58/63 = **92,1%**. |

---

*Script: `scripts/eval_root_cause.py` · Dữ liệu: `~/ros2_doctor_ws/bags/` (48 bag có nhãn)*
