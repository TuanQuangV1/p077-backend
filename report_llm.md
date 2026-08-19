# Report: Đánh giá LLM Root-Cause Analysis trên dữ liệu rosbag thật

**Ngày:** 2026-08-18
**Backend:** FastAPI `localhost:8000`, `POST /api/v1/analysis` (LLM thật, không dùng canned fallback)
**LLM:** `LLM_PROVIDER=openai`, `model_name=gpt-4o-mini`, `temperature=0.2`
**Ground truth:** `~/ros2_doctor_ws/bags/{faulty,healthy}/*_ground_truth.json`
**Dataset:** 7 bag `.mcap` — 1 healthy đối chứng + 6 faulty, tổng **9 lỗi được tiêm**, sinh ra **40 anomaly**

---

## 1. Tóm tắt kết quả

| Bag | Lỗi tiêm (GT) | Detect | Kết quả | Verdict |
|---|---|---|---|---|
| `healthy_01_0` | 0 | 0 | Không dương tính giả | ✅ |
| `F1_01_0` | 1 — `/scan` chết 115s | 15 | Đúng topic, đúng cơ chế, fix đúng | ✅ |
| `F1_03_0` | 1 — `/odom` 50→10Hz 80s | 2 | Đúng topic, sai quy mô + severity | ⚠️ |
| `F2_04_0` | 1 — `/imu` stamp lùi 5s | 3 | Đúng cửa sổ + độ lớn, **sai phân loại** | ⚠️ |
| `F3_01_0` | 1 — `/tf` mất edge 40s | 5 | Đúng topic, không nêu edge gãy | ⚠️ |
| `F6_03_0` | 3 — `/scan` 3 gap 5s | 8 | **Chỉ bắt 1/3 gap** | ❌ |
| `C_01_0` | 2 — `/scan` NaN + `/tf` gap | 7 | **Bỏ sót cả 2** | ❌ |

**Theo 9 lỗi được tiêm:**

| Mức độ | Số lỗi | Chi tiết |
|---|---|---|
| ✅ Nhận đúng hoàn toàn + fix dùng được | **1** | `F1_01` |
| ⚠️ Đúng topic nhưng thiếu/sai thông tin then chốt | **4** | `F1_03`, `F2_04`, `F3_01`, `F6_03` gap3 |
| ❌ Bỏ sót hoàn toàn | **4** | `C_01` ×2, `F6_03` gap1+gap2 |

**Theo 40 anomaly sinh ra:** 12 chỉ đúng component cần sửa, 28 còn lại sai hướng hoặc giải thích cho nhiễu.

---

## 2. Chi tiết từng bag

### 2.1 `healthy_01_0` — đối chứng

**GT:** `fault_count: 0`. Mô tả: *"Bag đối chứng — robot tuần tra bình thường, KHÔNG tiêm lỗi nào. Dùng làm nền để đo false positive."*

**Kết quả:** 0 anomaly, run `succeeded` 661ms.

✅ **Đúng.** Không dương tính giả — chỉ số tốt nhất của toàn hệ thống.

---

### 2.2 `F1_01_0` — LiDAR chết hoàn toàn ✅

**GT (1 lỗi):** `topic_dead` trên `/scan`, cửa sổ sim **425.2 → 540.2s** (115.0s), severity **critical**, 10Hz → 0Hz.
Root cause GT: *"LiDAR driver crash hoặc bridge mất kết nối gz transport"*

**15 anomaly → 3 cụm.** Cụm chính:

| role | topic | kind | tSec → endSec | Bằng chứng thô |
|---|---|---|---|---|
| **primary** | /scan | silent_node | 425.133→540.223 | im lặng 115.09s, ngưỡng 0.5s |
| **primary** | /scan | frequency_gap | 425.133→540.223 | interval 115.09s, ngưỡng 0.15s |
| **primary** | /scan | message_drop_burst | 425.133→540.223 | max_gap 115.09s |
| consequence | /cmd_vel | silent_node | 427.301→540.287 | im lặng 112.986s |
| consequence | /cmd_vel | frequency_gap | 427.301→540.287 | interval 112.986s |
| consequence | /cmd_vel | message_drop_burst | 427.301→540.287 | max_gap 112.986s |

> **Root cause:** */scan hỏng trước do silent node, kéo theo lỗi ở /cmd_vel vì nó phụ thuộc dữ liệu scan.*
> **Fix:** (1) Điều tra node `/scan` tìm lỗi phần cứng/phần mềm · (2) Kiểm tra tài nguyên hệ thống có làm `/scan` đói không · (3) Xem lại cấu hình mạng để đảm bảo giao message tin cậy cho `/scan`

**Đối chiếu GT:** onset lệch **0.067s**, kết thúc lệch **0.023s**, thời lượng lệch **0.09s**, severity critical ✅.
FIX1 khớp giả thuyết *"LiDAR driver crash"*; FIX3 khớp giả thuyết *"bridge mất kết nối gz transport"*.

✅ **Đây là ca duy nhất đúng trọn vẹn từ phát hiện đến gợi ý sửa.**

*Hai cụm còn lại (5 anomaly `header_latency`/`jitter` @359s, 4 anomaly `/imu`+`/odom` @364.6s) là artifact — GT chỉ tiêm 1 lỗi. Cụm @364.6s nằm **trước** `bag_t0 = 365.2s`, tức vùng pre-roll lúc recorder khởi động.*

---

### 2.3 `F1_03_0` — `/odom` tụt tần số ⚠️

**GT (1 lỗi):** `frequency_drop` trên `/odom`, `keep_every: 5` (50Hz → 10Hz), cửa sổ **882.1 → 962.1s** (80.0s), severity **high**.
Root cause GT: *"DiffDrive plugin trễ / thread bị starve"*

**2 anomaly → 2 cụm:**

| topic | kind | tSec → endSec | Bằng chứng thô |
|---|---|---|---|
| /odom | frequency_gap | 882.8→882.901 | interval 0.101s, ngưỡng 0.08s |
| /odom | timestamp_jitter | 828.96→1035.581 | jitter 0.0253s, ngưỡng 0.02s |

> **Fix:** Điều tra nguồn gây frequency gap ở `/odom` · Kiểm tra cấu hình publisher `/odom` · Kiểm tra vấn đề phần cứng của odometry sensor

**Đối chiếu GT:** topic ✅, onset 882.8 vs 882.1 (lệch 0.7s) ✅.
❌ **Thời lượng: báo 0.101s, thực tế 80 giây.** ❌ **Severity: medium vs GT high.**

⚠️ `/odom` chạy 50Hz (chu kỳ 0.02s) tụt còn 10Hz (chu kỳ 0.1s) suốt 80s → mọi khoảng cách 0.1s đều vượt ngưỡng 0.08s và đáng lẽ phải báo liên tục. Detector chỉ giữ **một** sự kiện đại diện. Rule `hz_drop_critical` (từng bắn trên `/tf` của F3_01) không kích hoạt.

Fix "kiểm tra cấu hình publisher `/odom`" đúng hướng — DiffDrive plugin chính là publisher đó. Nhưng *"kiểm tra phần cứng odometry sensor"* vô nghĩa: đây là bag **Gazebo sim**, không có sensor vật lý.

---

### 2.4 `F2_04_0` — `/imu` timestamp đi lùi ⚠️ (sai phân loại)

**GT (1 lỗi):** `timestamp_backwards` trên `/imu`, `offset_sec: -5.0`, cửa sổ **114.0 → 189.0s** (75.0s), severity **critical**, direction **backward**.
Root cause GT: *"Node restart, clock khởi tạo lại về mốc cũ → stamp đi lùi"*

**3 anomaly → 2 cụm:**

| topic | kind | tSec → endSec | Bằng chứng thô |
|---|---|---|---|
| /tf | frequency_gap | 43.095→43.2 | interval 0.105s — artifact (trước `bag_t0=49.0`) |
| /cmd_vel | frequency_gap | 43.095→43.188 | interval 0.093s — artifact |
| **/imu** | **header_latency** | **114.001→188.995** | **max_latency 5004.0ms, ngưỡng 100ms, count 15000** |

> **Root cause:** */imu bị header latency đáng kể, có thể khiến consumer phía sau bị đình trệ do dữ liệu tới trễ.*
> **Fix:** (1) Điều tra nguồn gây trễ ở `/imu` · (2) Kiểm tra kết nối phần cứng và hiệu năng của IMU sensor · (3) Xem lại tải xử lý của hệ thống tìm nút thắt

**Đối chiếu GT:**
- Cửa sổ: 114.001 vs GT **114.0** → lệch **0.001s**; 188.995 vs **189.0** → lệch **0.005s** — khớp gần như tuyệt đối ✅
- Độ lớn: 5004ms = **5.004s** vs GT offset **-5.0s** — khớp chính xác ✅
- Topic `/imu` ✅
- ❌ **Severity: medium vs GT critical**
- ❌ **Phân loại sai bản chất: báo "độ trễ header", thực tế là "stamp nhảy lùi"**

⚠️ **Đây là ca sai nguy hiểm nhất về mặt chẩn đoán.** Stamp lùi 5s làm hiệu `log_time − header_stamp` bằng +5s, nên rule latency bắt được đúng con số nhưng gọi sai tên. Kỹ sư đọc *"trễ 5 giây, kiểm tra phần cứng và tải hệ thống"* sẽ đi săn một IMU chậm/quá tải — **trong khi không có gì chậm cả**: `relay_stats` cho thấy `/imu` giao đủ **46010/46010** message, không rơi cái nào. Sự thật là node restart và clock reset về mốc cũ.

Dữ liệu để chẩn đoán đúng **đã có sẵn**: độ trễ **hằng số 5004ms suốt 15000 message liên tiếp** là chữ ký của lệch clock cố định, không phải độ trễ mạng (vốn dao động). Cả detector lẫn LLM đều không nhận ra. Rule `clock_drift` tồn tại trong code nhưng không kích hoạt.

*Cụm artifact @43.095: cả `/tf` và `/cmd_vel` khởi phát cùng **một thời điểm** nhưng LLM vẫn gán `/cmd_vel` là hệ quả của `/tf`, và đề xuất "kiểm tra kết nối phần cứng của `/tf` sensor" — `/tf` là cây transform, không phải sensor.*

---

### 2.5 `F3_01_0` — mất transform `odom→base_footprint` ⚠️

**GT (1 lỗi):** `tf_gap` trên `/tf`, broken edge **`odom→base_footprint`**, cửa sổ **1816.1 → 1856.1s** (40.0s), severity **critical**.
Root cause GT: *"Node publish odom->base_footprint ngừng; chuỗi map->odom->base_link đứt"*

**5 anomaly → 2 cụm.** Cụm chính:

| role | topic | kind | tSec → endSec | Bằng chứng thô |
|---|---|---|---|---|
| **primary** | /tf | hz_drop_critical | 1815.0→1855.0 | 66.67Hz → 20.0Hz, giảm 70% |
| consequence | /cmd_vel | silent_node | 1818.279→1856.107 | im lặng 37.828s |
| consequence | /cmd_vel | frequency_gap | 1818.279→1856.107 | interval 37.828s |
| consequence | /cmd_vel | message_drop_burst | 1818.279→1856.107 | max_gap 37.828s |

> **Root cause:** */tf tụt tần số nghiêm trọng trước, dẫn tới các vấn đề sau đó ở /cmd_vel.*
> **Fix:** (1) Điều tra publisher `/tf` tìm nguyên nhân tụt tần số · (2) Kiểm tra tài nguyên hệ thống đảm bảo `/tf` đủ băng thông và CPU · (3) Theo dõi `/tf` sau khi thay đổi

**Đối chiếu GT:** topic ✅, cửa sổ lệch 1.1s ✅, thời lượng 40s **khớp chính xác** ✅.
❌ **Severity: high vs GT critical.**
❌ **Không nêu được edge nào gãy** — thông tin quan trọng nhất để sửa.

⚠️ Rule chuyên dụng `tf_missing_gap`/`tf_drift_jump` **không kích hoạt**; một rule tần số chung bắt thay. Hệ quả: FIX1 đúng component (`/tf` publisher) nhưng không dẫn kỹ sư tới `ros2 run tf2_tools view_frames` để tìm edge mất. FIX2 (băng thông/CPU) lệch hướng — nguyên nhân thật là một node ngừng publish một edge cụ thể.

---

### 2.6 `F6_03_0` — 3 gap 5 giây trên `/scan` ❌

**GT (3 lỗi riêng biệt):** `message_gap` trên `/scan`, mỗi lỗi 5.0s, severity **medium**:
- gap1: **94.8 → 99.8s**
- gap2: **139.8 → 144.8s**
- gap3: **184.8 → 189.8s**

Root cause GT: *"Queue overflow theo chu kỳ khiến message rơi thành cụm"*
`relay_stats`: `/scan` in=2363, out=2213 → **rơi đúng 150 message** = 3 × 5s × 10Hz ✓

**8 anomaly → 3 cụm:**

| Cụm | topic | kind | tSec → endSec | Đối chiếu GT |
|---|---|---|---|---|
| 1 | /scan | silent_node (critical) | 184.722→189.824 | = **gap3** ✅ |
| 1 | /scan | frequency_gap | 184.722→189.824 | = gap3 |
| 1 | /scan | message_drop_burst | 184.722→189.824 | = gap3 |
| 2 | /scan | timestamp_jitter | 49.226→258.823 | toàn bag |
| 2 | /cmd_vel | timestamp_jitter | 51.426→258.869 | toàn bag |
| 3 | /cmd_vel | silent_node (critical) | 96.937→100.084 | **hệ quả của gap1** |
| 3 | /cmd_vel | frequency_gap | 96.937→100.084 | hệ quả gap1 |
| 3 | /cmd_vel | message_drop_burst | 96.937→100.084 | hệ quả gap1 |

❌ **Chỉ bắt được gap3. gap1 và gap2 hoàn toàn không có detection nào trên `/scan`.**

Đây là bằng chứng dứt điểm cho lỗi "nén nhiều sự cố thành một": detector chỉ giữ **một** sự kiện lớn nhất mỗi topic mỗi rule, nên 3 lỗi tiêm → 1 báo cáo.

**Hệ quả dây chuyền:** gap1 có để lại dấu vết — `/cmd_vel` ngừng 3.147s @96.937, nằm trọn trong cửa sổ gap1 (94.8–99.8). Nhưng vì `/scan` gap1 không được báo, cụm 3 chỉ có `/cmd_vel`, nên LLM kết luận:

> **Root cause cụm 3:** */cmd_vel gặp silent node, gây ra frequency gap và message drop sau đó.*
> **Fix:** Điều tra node `/cmd_vel` tìm nguyên nhân im lặng · Kiểm tra tài nguyên hệ thống · Xem lại cấu hình node

❌ **Sai** — `/cmd_vel` là nạn nhân của gap1. gap2 thì vô hình hoàn toàn, không để lại dấu vết nào.

**Về cụm 1 (gap3 — cái duy nhất bắt đúng):**
> **Fix:** Điều tra node `/scan` tìm crash hoặc cạn tài nguyên · Kiểm tra CPU/memory · Xem lại cấu hình topic `/scan`

⚠️ Đúng topic, "cạn tài nguyên" gần với *queue overflow*, nhưng: (a) nói *"node crash"* trong khi node vẫn chạy bình thường, chỉ queue rơi message; (b) **không hề nhắc QoS / độ sâu queue** — chính là chỗ phải sửa; (c) severity báo **critical**, GT nói **medium**; (d) báo 1 sự cố đơn lẻ nên mất hẳn tính chất **"theo chu kỳ"** mà GT nhấn mạnh — kỹ sư sẽ tưởng là sự cố một lần.

---

### 2.7 `C_01_0` — LiDAR NaN + TF gap ❌

**GT (2 lỗi):**
1. `nan_values` trên `/scan`, 30% giá trị `ranges` là NaN, cửa sổ **155.45 → 215.45s** (60s), severity critical. Root cause GT: *"LiDAR lỗi phần cứng: một phần photodiode không trả tín hiệu"*
2. `tf_gap` trên `/tf`, edge `odom→base_footprint`, cửa sổ **205.45 → 250.45s** (45s), severity critical.

**7 anomaly → 2 cụm:**

| Cụm | topic | kind | tSec | Phân loại |
|---|---|---|---|---|
| 1 | /cmd_vel | timestamp_jitter | 109.108 | artifact (trước `bag_t0=115.45`) |
| 1 | /imu | frequency_gap | 110.291 | artifact |
| 1 | /odom | frequency_gap | 110.291 | artifact |
| 1 | /tf | frequency_gap | 110.291 | artifact |
| 2 | /cmd_vel | silent_node (critical) | 207.603→250.471 | hệ quả của lỗi 2 |
| 2 | /cmd_vel | frequency_gap | 207.603→250.471 | hệ quả |
| 2 | /cmd_vel | message_drop_burst | 207.603→250.471 | hệ quả |

❌ **Lỗi 1 (NaN): không phát hiện.** Detector **không có rule đọc payload** — chỉ phân tích thời gian. `/scan` vẫn giao đủ **3281/3281** message nên mọi rule timing đều thấy "bình thường". Đây đúng là hạng mục **NaN** ghi trong `architecture_diagram.pdf` nhưng chưa cài đặt.

❌ **Lỗi 2 (TF gap): không báo trên `/tf`.** Không có detection nào trên `/tf` trong cửa sổ 205–250s. Nhưng `/cmd_vel` im lặng **207.603→250.471** — trùng khớp gần như hoàn toàn với cửa sổ lỗi TF. Hệ thống nhìn thấy *bóng* của lỗi nhưng quy sai cho `/cmd_vel`:

> **Fix:** Điều tra node `/cmd_vel` tìm crash hoặc vấn đề tài nguyên · Kiểm tra tải hệ thống · Xem lại cấu hình publisher `/cmd_vel`

❌ Kỹ sư làm theo sẽ debug node hoàn toàn khỏe mạnh.

---

## 3. Đánh giá

### 3.1 Đã đúng và ổn

**a) LLM không bịa số — 40/40 chính xác.** Mọi con số trích dẫn đều khớp `evidence` thô của detector. Kiểm mẫu:

| LLM nói | Detector thô | |
|---|---|---|
| `/imu` gap 0.104s / ngưỡng 0.08s | `{interval_sec: 0.104, threshold_sec: 0.08}` | ✅ |
| `/cmd_vel` im lặng 42.868s | `{silent_duration_sec: 42.868}` | ✅ |
| `/tf` 20Hz vs kỳ vọng 66.67Hz, giảm 70% | `{actual_hz: 20.0, expected_hz: 66.6667, drop_pct: 0.7}` | ✅ |
| `/imu` latency tối đa 5004ms, 15000 lần | `{max_latency_ms: 5004.0, count: 15000}` | ✅ |

LLM còn phân biệt đúng ngưỡng riêng theo topic (`/scan` 0.15s vs `/imu` 0.08s; silent_node `/scan` 0.5s vs `/cmd_vel` 0.3s) mà không nhầm lần nào.

**b) 0 dương tính giả trên bag healthy.**

**c) Độ chính xác thời điểm xuất sắc khi rule đúng bắn:** `F1_01` lệch 0.067s, `F2_04` lệch **0.001s**, `F3_01` thời lượng khớp chính xác 40s.

**d) Phân tích nhân quả hoạt động** sau khi gom cụm (mục 4): `F1_01` và `F3_01` đều chỉ đúng topic gốc và gán `/cmd_vel` là hệ quả.

### 3.2 Chưa đúng

**Vấn đề 1 — Bỏ sót loại lỗi về chất lượng dữ liệu (NaN).**
`C_01` lỗi 1 vô hình vì detector chỉ đọc timing, không đọc payload. Mọi lỗi nhóm `data_quality` trong dataset đều sẽ bị bỏ qua.

**Vấn đề 2 — Nhiều sự cố cùng loại bị nén thành một.**
`F6_03` chứng minh dứt điểm: 3 gap tiêm → **1** được báo. `F1_03` cũng vậy: 80 giây suy giảm → 1 gap 0.101s. Mất cả số lượng lẫn tính chu kỳ của sự cố.

**Vấn đề 3 — Sai phân loại dẫn tới sai chẩn đoán.**
`F2_04`: stamp lùi 5s bị gọi là "header latency". Đúng cửa sổ, đúng độ lớn, sai bản chất → gợi ý sửa sai hoàn toàn. Rule `clock_drift` có sẵn nhưng không bắn.

**Vấn đề 4 — Rule TF chuyên dụng không kích hoạt.**
Cả `C_01` và `F3_01` đều tiêm `tf_gap` edge `odom→base_footprint`. `tf_missing_gap`/`tf_drift_jump` không bắn ở cả 2 ca. Output không bao giờ nêu được **frame nào gãy**.

**Vấn đề 5 — Severity không hiệu chỉnh.**
Lệch cả hai chiều: `F6_03` báo **critical** cho gap 5s mà GT nói **medium**; `F2_04` báo **medium** cho lỗi GT nói **critical**; `F3_01` báo **high** vs **critical**. Blip 0.338s lúc khởi động bị xếp cùng cấp critical với mất LiDAR 115 giây.

**Vấn đề 6 — Artifact pre-roll bị báo như lỗi thật.**
`C_01` (@110.291 < `bag_t0` 115.45), `F1_01` (@364.6 < 365.2), `F2_04` (@43.095 < 49.0) — cả 3 bag đều sinh detection **trước** thời điểm bag bắt đầu theo GT, tức vùng recorder khởi động. Chúng chiếm phần lớn số anomaly nhiễu.

**Vấn đề 7 — LLM suy diễn ngoài dữ liệu.**
Payload chỉ có số liệu timing, không có CPU/mạng/node. Nhưng LLM đề xuất *"kiểm tra kết nối phần cứng IMU"*, *"kiểm tra băng thông"*, *"kiểm tra phần cứng của `/tf` sensor"* (`/tf` không phải sensor). Đây là bag Gazebo — không có phần cứng nào để kiểm tra.

**Vấn đề 8 — Chuỗi bằng chứng trên UI yếu.**
`anomalies[].evidence` trả `null` qua API; evidence của AI result chỉ 1 phần tử. Các số đo thật (`interval_sec`, `threshold_sec`, `max_latency_ms`…) không có trong chuỗi bằng chứng người duyệt nhìn thấy.

**Vấn đề 9 — "Model confidence" không phải của model.**
Lấy từ detector rule-based, cố định theo loại lỗi (frequency_gap luôn 0.81, silent_node luôn 0.92) trên mọi bag. Nhãn UI gây hiểu nhầm.

---

## 4. Đã sửa trong đợt này

### 4.1 Ba lỗi ở tầng LLM

1. **Cổng chặn nhầm provider** — [analysis.py](src/services/analysis.py): điều kiện `llm_provider == "vllm"` khiến mọi cấu hình OpenAI rơi về template cứng dù key hợp lệ. Bỏ điều kiện thừa.
2. **`recommended_actions` hard-code** — [llm.py](src/services/llm.py): hàm gọi LLM thật rồi **vứt** câu trả lời, trả về 2 dòng cố định. Toàn bộ anomaly dùng chung 1 cặp câu. Đổi sang yêu cầu JSON có cấu trúc và parse thật.
3. **Cắt cụt giữa câu** — `content[:200]` / `content[:350]` làm 29/29 kết quả đứt ngang. Đã bỏ.

### 4.2 Gom cụm theo thời điểm khởi phát

`_cluster_detections()` gom detection thành *sự cố* theo khoảng cách onset (cửa sổ `_CLUSTER_WINDOW_SEC = 5.0s`, chọn từ độ trễ lan truyền ~2.2s đo được), xếp **sớm nhất trước**. `explain_detection_cluster()` gọi LLM **một lần cho cả cụm**, yêu cầu gán mỗi detection nhãn `primary`/`consequence`.

Prompt có 2 chốt chặn chống bịa nhân quả: chỉ gán `consequence` khi anomaly sớm hơn thực sự giải thích được nó; và hai anomaly cách nhau **dưới 0.5s** là triệu chứng đồng thời, không phải nhân–quả.

**Bug phụ đã sửa:** nhánh fallback cũ khiến mọi kết quả fallback đều mang `anomaly_001`, đè lên nhau.

### 4.3 Kết quả đo

| Chỉ số | Trước | Sau |
|---|---|---|
| Lời gọi LLM (40 anomaly) | 40 | **14** (−65%) |
| Kết luận riêng biệt cần duyệt | 40 | **14** |
| Detection quy sai nguyên nhân cho nạn nhân | 12 | **3** |

| Bag | Trước | Sau | GT |
|---|---|---|---|
| F1_01 | *"restart `/cmd_vel`"* | *"`/scan` hỏng trước"* → fix nhắm `/scan` | `/scan` ✅ |
| F3_01 | *"restart `/cmd_vel`"* | *"`/tf` tụt tần số trước"* → fix nhắm `/tf` | `/tf` ✅ |

`C_01` @110.291: 3 gap đồng thời trước bị gán hệ quả, nay **cả 4 đều `primary`** (độc lập) — đúng.

**Còn tồn tại:** chốt chặn đồng thời chưa ăn 100% (`F2_04` @43.095 và `F1_01` header_latency lệch 6ms vẫn bị gán nhân quả). `C_01` và `F6_03` cụm 3 vẫn quy cho `/cmd_vel` — **không phải lỗi LLM**: detector không báo gì trên `/scan`/`/tf` trong cửa sổ đó nên trong cụm không có ứng viên sớm hơn để chỉ vào.

**Kiểm chứng:** 239 test pass (thêm 7 test mới cho `_cluster_detections` và `_build_ai_results`), coverage 89.3%, ruff sạch.

*Trong lần chạy đầu của bản sửa, `F3_01` bị **đảo ngược nhân quả** vì cụm sắp theo vị trí gốc khiến `/tf`@1815.0 bị đẩy xuống sau `/cmd_vel`@1818.279. Đã sửa bằng cách gửi theo thứ tự khởi phát.*

---

## 5. Kết luận hệ thống sau khi chạy API thật

**Tầng LLM đáng tin trong phạm vi nó được giao.** Trên 40 anomaly, mọi con số trích dẫn đều chính xác — không bịa một số nào. Nó phân biệt đúng ngưỡng riêng từng topic, diễn giải đúng ý nghĩa kỹ thuật từng loại anomaly, và sau khi được cấp ngữ cảnh cụm thì suy luận nhân quả đúng ở cả 2 ca có thể kiểm chứng.

**Nhưng chất lượng chẩn đoán của cả hệ thống chưa đạt: 1/9 lỗi được tiêm có chẩn đoán và gợi ý sửa đúng trọn vẹn.** 4 lỗi nhận đúng topic nhưng thiếu thông tin then chốt, 4 lỗi bỏ sót hoàn toàn.

**Nút thắt đã dịch chuyển.** Trước đợt sửa, nút thắt là LLM bị cho ăn từng detection riêng lẻ nên không thể làm root-cause analysis. Sau khi gom cụm, nút thắt chuyển hẳn xuống **tầng detector**: nó bỏ sót lỗi (NaN, 2/3 gap của `F6_03`, TF gap), nén nhiều sự cố thành một, và phân loại sai bản chất (`F2_04`). LLM không thể chỉ đúng thứ mà detector chưa bao giờ báo — mọi ca sai còn lại đều truy về đúng nguyên nhân này.

**Ba dạng rủi ro thực tế khi dùng report hiện tại:**

1. **Dẫn sai người sửa.** `C_01` và `F6_03` cụm 3 hướng kỹ sư đi restart `/cmd_vel` — node hoàn toàn khỏe mạnh. `F2_04` hướng đi săn IMU chậm trong khi `/imu` giao đủ 46010/46010 message; lỗi thật là clock reset sau node restart.
2. **Đánh giá thiếu mức nghiêm trọng.** `F6_03` báo 1 sự cố đơn lẻ trong khi thực tế là **3 lần lặp theo chu kỳ**; `F1_03` báo gap 0.101s trong khi thực tế suy giảm 80 giây.
3. **Thiếu thông tin để hành động.** `F3_01` nói đúng *"kiểm tra `/tf` publisher"* nhưng không nêu **edge nào** mất — không có thông tin đó thì không sửa được.

Report càng trôi chảy và tự tin thì rủi ro dẫn sai càng cao — mọi ca sai ở trên đều được viết bằng văn phong chắc chắn, kèm số liệu đúng.

**Bốn việc cần làm, theo thứ tự ưu tiên:**

1. **Cho detector báo *mọi* lần xuất hiện, không chỉ lần lớn nhất.** Đây là lỗi tác động rộng nhất — nó làm mất 2/3 lỗi của `F6_03` và toàn bộ quy mô của `F1_03`, đồng thời che luôn nguyên nhân gốc của các cụm bị quy sai.
2. **Bổ sung rule chất lượng payload (NaN/Inf/out-of-range).** Không có nó thì cả nhóm lỗi `data_quality` vô hình.
3. **Phân biệt stamp nhảy lùi với độ trễ thật**, và sửa rule TF để nêu edge gãy. Dữ liệu đã đủ để làm cả hai (độ trễ hằng số 5004ms × 15000 message là chữ ký clock jump, không phải latency).
4. **Hiệu chỉnh severity và lọc vùng pre-roll** trước `bag_t0`.

Trước khi làm xong việc 1–3, **không nên dùng report của hệ thống làm căn cứ sửa lỗi trực tiếp** — chỉ nên dùng như bộ lọc sơ bộ, kèm người có chuyên môn ROS đối chiếu timeline.

*(Mục 5 là ảnh chụp trạng thái ngay sau khi sửa tầng LLM, trước khi làm việc 1. Mục 6–7 cập nhật sau khi việc 1 hoàn thành.)*

---

## 6. Đã sửa: detector báo mọi lần xuất hiện (việc 1)

### 6.1 Nguyên nhân

[diagnostics.py](src/services/diagnostics.py) cũ chỉ giữ **một** con số mỗi rule mỗi topic — `_gap_stats()` trả về `(median, max_interval, index_of_max)`, và `_evaluate_silent_rule()` chọn `max(intervals, key=...)`. Dù một topic vượt ngưỡng 1 lần hay 300 lần, chỉ lần lớn nhất được báo. Đây là nguyên nhân trực tiếp của 2 lỗi trong mục 2: `F6_03` mất 2/3 gap, `F1_03` nén 80 giây suy giảm thành một điểm 0.101s.

### 6.2 Thay đổi

Thêm `_threshold_episodes()` ([diagnostics.py](src/services/diagnostics.py)) — gộp các khoảng vượt ngưỡng liên tiếp thành *đợt* (episode), tách đợt khi xen giữa là traffic bình thường. Áp dụng cho cả 3 rule dùng chung mẫu này: `frequency_gap`, `message_drop_burst` ([_evaluate_topic_rules](src/services/diagnostics.py)), `silent_node` ([_evaluate_silent_rule](src/services/diagnostics.py)). Mỗi đợt sinh một detection riêng, kèm `occurrence_count` trong evidence. Giới hạn `_MAX_EPISODES_PER_RULE = 10` cho topic hỏng hệ thống (giữ 10 đợt nặng nhất, vẫn xếp theo thời gian) để tránh sinh hàng trăm detection.

### 6.3 Kết quả đo — đối chiếu ground truth

| Chỉ số | Trước | Sau |
|---|---|---|
| `F6_03`: số gap trong 3 gap tiêm được bắt | 1/3 | **3/3** |
| `F1_03`: cửa sổ suy giảm báo được | 0.101s | **80.000s** (GT 80.0s, lệch 0.001s) |
| `C_01`: thời điểm sớm nhất lộ dấu vết lỗi TF | 207.603 (lệch GT 2.15s) | **205.410** (lệch GT 0.04s) |
| `healthy`: dương tính giả | 0 | **0** |
| Tổng detection thô (7 bag) | 40 | 94 |
| Tổng cụm cần duyệt (7 bag, sau gom cụm) | 14 | **19** |

**`F6_03` — cả 3 gap tiêm đều bắt đúng và đúng hướng nhân quả:**

| Gap | Detect | GT | Lệch | Vai trò LLM gán |
|---|---|---|---|---|
| 1 | 94.717→99.818 | 94.8→99.8 | 0.08s | `/scan` primary, `/cmd_vel` consequence |
| 2 | 139.718→144.809 | 139.8→144.8 | 0.08s | `/scan` primary, `/cmd_vel` consequence |
| 3 | 184.722→189.824 | 184.8→189.8 | 0.08s | `/scan` primary, `/cmd_vel` consequence |

Đây là lỗi đầu tiên trong 9 lỗi GT được nhận diện **đúng cả về số lượng lẫn từng thời điểm riêng lẻ**, không chỉ đúng topic chung chung.

Đã xác minh tăng detection không phải nhiễu: so `/cmd_vel` giữa bag healthy (0 gap > 0.08s trên 3568 message, max 0.071s) với `C_01` (đúng 10 gap > 0.08s trên 3741 message) — số detection mới sinh ra khớp chính xác với số lần vượt ngưỡng thật.

### 6.4 Tác dụng phụ — lỗi nhân quả mới ở `F1_01`

Gom nhiều detection hơn vào cùng cụm khiến một cụm ở `F1_01` suy diễn phi lý: một blip `/cmd_vel` dài **0.34s** (358.682→359.025) bị gán `primary`, kéo theo `header_latency` dài **185 giây** trên cả `/scan`, `/imu`, `/odom` (359.026–546.049) bị gán `consequence` của nó:

> *"/cmd_vel timestamp jitter đầu tiên, có thể gây ra header latency sau đó ở /scan, /imu, /odom."*

Một blip 0.34s không thể gây trễ header 185 giây trên 3 topic khác. Nguyên nhân: 5 onset liên quan (358.383, 358.682, 359.026, 359.028, 359.032) cách nhau dưới 0.65s nên rơi vào cùng cụm 5s, nhưng mọi cặp liền kề đều cách nhau **dưới 0.5s** — đúng lẽ ra phải bị chốt chặn "đồng thời" trong prompt ([llm.py](src/services/llm.py)) chặn lại, nhưng chốt chặn đó chỉ dựa vào khoảng cách giữa các anomaly liền kề trong lời nhắc, không có ràng buộc tường minh "thời lượng hệ quả không được dài hơn thời lượng nguyên nhân nhiều lần" — model vẫn tự diễn giải theo hướng có lợi cho một câu chuyện nhân quả duy nhất. **Chưa sửa**, ghi nhận làm việc mới.

### 6.5 Kiểm chứng

243 test pass (thêm 4 test mới cho `_threshold_episodes`: tách đợt cách nhau bởi traffic khỏe, gộp đợt liên tục thành một khoảng, không báo gì khi mọi span đều dưới ngưỡng, giới hạn topic hỏng hệ thống mà vẫn giữ thứ tự thời gian), coverage 89.4%, ruff sạch.

---

## 7. Kết luận cập nhật sau việc 1

**Theo 9 lỗi GT: 3/9 giờ đúng hoàn toàn** (trước việc 1: 1/9) — thêm `F6_03` (cả 3 gap) và `F1_03`. `C_01` (2 lỗi) và `F2_04` vẫn sai như cũ — **đúng như dự đoán**, vì cả hai đều cần việc 2 (rule NaN, rule TF theo edge) và việc 3 (phân biệt clock jump), chưa làm.

**Bằng chứng ở `C_01` tốt hơn hẳn dù kết luận vẫn sai.** Cụm ứng với lỗi TF giờ bắt đầu tại 205.410s — lệch GT 0.04s thay vì 2.15s như trước. Con số này tự nó không đổi kết luận (`/cmd_vel` vẫn bị gán sai là nguyên nhân, vì detector chưa báo gì trên `/tf` trong cửa sổ đó để LLM có ứng viên khác), nhưng nó là tín hiệu mạnh cho việc 2: khi rule TF theo edge được thêm, dữ liệu thời gian đã đủ chính xác để khớp đúng.

**Danh sách ưu tiên còn lại** (đánh số lại từ mục 5, việc 1 đã xong):

1. ~~Cho detector báo mọi lần xuất hiện~~ — **đã xong** (mục 6).
2. Bổ sung rule chất lượng payload (NaN/Inf/out-of-range) + sửa rule TF theo edge — vẫn là việc duy nhất có thể sửa cả 2 lỗi của `C_01`.
3. Phân biệt stamp nhảy lùi với độ trễ thật (`F2_04`).
4. Hiệu chỉnh severity, lọc vùng pre-roll trước `bag_t0`, và siết chốt chặn nhân quả ở tầng LLM để tránh lỗi mục 6.4 tái diễn.

---

## 8. Đã sửa: rule payload NaN + rule TF theo edge (việc 2)

### 8.1 Nguyên nhân

**`C_01` lỗi 1 (NaN 30% trên `/scan`) vô hình hoàn toàn.** [diagnostics.py](src/services/diagnostics.py) chỉ phân tích timing (`timestamp`/`topic`/`node`), không đọc payload — mọi lỗi nhóm `data_quality` bị bỏ qua triệt để, kể cả khi `/scan` vẫn giao đủ 100% message (3281/3281) nên mọi rule timing đều thấy "bình thường".

**`C_01` lỗi 2 và `F3_01` (`tf_gap` edge `odom→base_footprint`) không kích hoạt.** [bag_stream.py](src/services/bag_stream.py) cũ chỉ đọc `transforms[0]` của mỗi `/tf` message — một `TFMessage` thực tế gộp nhiều edge độc lập trong cùng một lần publish (`map→odom`, `odom→base_footprint`, 2 wheel joint), mỗi edge một tốc độ publish khác nhau. `tf_missing_gap` cũ tính gap trên timestamp gộp **cả topic** `/tf`, nên hễ một edge khác còn sống (VD wheel joint publish liên tục) là gap của `odom→base_footprint` — dù đã chết hàng chục giây — bị che khuất hoàn toàn.

### 8.2 Thay đổi

1. **`payload_nan` (rule mới)** — `bag_stream.py` `_nan_ratio()`: tính tỉ lệ NaN trong `ranges` của bất kỳ message dạng LaserScan (không hard-code topic `/scan`, hoạt động theo shape message), bỏ mảng gốc ngay sau khi tính, không giữ payload trong bộ nhớ. Chỉ đếm `NaN`, **không** đếm `+/-Inf` — theo spec `sensor_msgs/LaserScan`, `Inf` là giá trị hợp lệ ("quá xa/gần để đo"), đếm Inf sẽ gây dương tính giả trên sensor khỏe mạnh. `diagnostics.py` `_evaluate_data_quality_rule()`: gộp các message liên tiếp vượt `payload_nan_ratio_min` (5%) thành một episode khi đạt `payload_nan_min_count` (5) message, dùng lại `_threshold_episodes`-style grouping của việc 1.
2. **`tf_missing_gap` theo edge** — `bag_stream.py` `_transforms()` đọc **toàn bộ** edge trong một publish thay vì chỉ cái đầu tiên. `diagnostics.py` `_evaluate_tf_rules()` viết lại: nhóm `pairs` theo `child_frame_id`, mỗi edge tính gap độc lập bằng `_threshold_episodes`. `/tf_static` bị loại khỏi phần "gap kéo dài tới cuối bag" — static transform hợp lệ khi chỉ phát một lần duy nhất, nếu không loại trừ thì **mọi** bag sẽ báo dương tính giả trên `/tf_static`.

### 8.3 Kết quả đo — chạy lại API thật (`LLM_PROVIDER=openai`, `model=gpt-4o-mini`) trên toàn bộ 7 bag

| Bag | `payload_nan` | `tf_missing_gap` |
|---|---|---|
| `healthy_01_0` | 0 | 0 |
| `F1_01_0` | – | 1 (`map→odom`, hệ quả của `/scan` chết) |
| `F1_03_0` | – | 0 |
| `F2_04_0` | – | 0 |
| `F3_01_0` | – | 2 (`odom→map`, `base_footprint→odom`) |
| `F6_03_0` | – | 3 (`map→odom`, mỗi gap 5s — hệ quả) |
| `C_01_0` | 1 (`/scan`) | 2 (`base_footprint→odom`, `odom→map`) |

**`C_01` lỗi 1 (NaN `/scan`) — lần đầu tiên phát hiện được, LLM chẩn đoán đúng hoàn toàn:**

> root_cause: *"/scan failed due to a payload_nan anomaly, causing downstream consumers to stall."*
> fix: *"Investigate the source of the /scan data for potential issues causing NaN values. Implement validation checks on the /scan data before it is published."*

Đối chiếu GT: window `155.517→215.417` vs GT `155.45→215.45` (lệch <0.1s), `max_nan_ratio: 0.333` vs GT `fraction: 0.3`. Severity `critical` = GT.

**`F3_01` (`tf_gap` edge `odom→base_footprint`) — giờ chẩn đoán đúng hoàn toàn:**

> root_cause: *"The /tf topic experienced a critical drop in frequency starting at 1815.0 seconds, which led to multiple subsequent failures in the /cmd_vel topic due to missing transforms."*
> finding (index 3): *"Missing transform gaps for base_footprint to odom due to /tf failure."*
> fix: *"Investigate the source of the /tf topic to identify why it dropped in frequency."*

Detection thô: `child_frame: base_footprint`, `parent_frame: odom`, `gap_sec: 40.02` — khớp GT (`broken_edge: odom->base_footprint`, `gap_sec: 40.0`) lệch 0.02s. Severity vẫn báo `high` (GT `critical`, chưa hiệu chỉnh — việc 4).

**`C_01` lỗi 2 (cùng edge, cùng bag) — bằng chứng đúng, nhưng causal ordering vẫn sai.** Cụm bị gộp chung với `/cmd_vel` (`silent_node` bắt đầu **205.410s**, chỉ sớm hơn `tf_missing_gap` (205.420/205.441s) đúng **10–31 mili-giây**), và LLM chọn `/cmd_vel` làm "primary":

> root_cause: *"The /cmd_vel topic experienced a critical silent node anomaly starting at 205.41 seconds, which led to subsequent frequency gaps and silent nodes..."*
> fix: *"Investigate the /cmd_vel node... Restart the /cmd_vel node if necessary to restore functionality."*

❌ Fix này dẫn sai người sửa — `/cmd_vel` khỏe mạnh, nguyên nhân thật là `/tf` (`odom→base_footprint`) ngừng broadcast. Chốt chặn "đồng thời" trong prompt (`_CLUSTER_SYSTEM_PROMPT`, [llm.py](src/services/llm.py)) nói rõ "anomalies whose start times differ by under half a second are simultaneous... mark each of those primary" — 10–31ms chắc chắn thuộc diện này, nhưng model vẫn chọn một topic làm nguyên nhân duy nhất. Cùng loại lỗi đã ghi nhận ở mục 6.4 (blip 0.34s bị gán primary cho hệ quả dài 185s), nay xuất hiện ở biên độ mili-giây thay vì giây: khi 2 topic chết gần như đồng thời, dữ liệu timing thuần không đủ để phân định hướng nhân quả — cần biết ROS computation-graph (`/cmd_vel` phụ thuộc `/tf`, không phải ngược lại), thứ hệ thống hiện không có.

**Nhưng bằng chứng thô đã đủ để kỹ sư tự sửa đúng nếu đọc anomaly list, không chỉ đọc root_cause.** Detection `tf_missing_gap child_frame=base_footprint gap=45.02s` (GT: edge đúng, gap 45.0s) vẫn hiển thị riêng trong response, độc lập với câu root_cause sai hướng. Trước việc 2, tín hiệu này không tồn tại ở bất kỳ đâu trong output.

### 8.4 Không có tác dụng phụ trên các bag không tiêm lỗi TF/NaN

`F1_01`, `F6_03` (chỉ tiêm lỗi `/scan`, không tiêm lỗi TF): edge `map→odom` mới cũng lặng thinh đúng lúc `/scan` hỏng — hệ quả dây chuyền thật của stack định vị (AMCL mất khả năng relocalize khi thiếu `/scan`), không phải nhiễu. LLM tự gán đúng "consequence":

> `F1_01`: *"The /scan topic experienced a critical silent node anomaly... which caused subsequent failures in the /tf and /cmd_vel topics due to their reliance on /scan data."* — finding: *"consequence: The /tf topic reported a missing gap due to the failure of the /scan topic."*

`healthy_01_0`: 0 dương tính giả trên cả 2 rule mới. `F1_03`, `F2_04` (không tiêm lỗi TF/NaN): 0 detection thuộc 2 rule mới, root cause của các cụm hiện có không đổi.

### 8.5 Kiểm chứng

248 test pass (thêm 6 test mới: 2 test dựng bag thật qua `rosbags.Writer` xác nhận `_transforms()`/`_nan_ratio()` decode đúng từ CDR thật, 4 test cho per-edge masking / loại trừ `/tf_static` / gộp NaN sustained / bỏ nhiễu rời rạc dưới ngưỡng), coverage 89.96%, ruff sạch trên mọi file sửa.

Tổng 7 bag: **103** detection thô, **20** cụm (root-cause cluster) cần duyệt — tăng từ 94/19 (sau việc 1) do 2 rule mới sinh thêm 9 detection thật, đã kiểm chứng không có dương tính giả trên bag healthy.

---

## 9. Kết luận cập nhật sau việc 2

**Theo 9 lỗi GT (đếm theo mục 1: `F1_01`=1, `F1_03`=1, `F2_04`=1, `F3_01`=1, `F6_03`=3, `C_01`=2): 7/9 giờ đúng hoàn toàn** (trước việc 2: 3/9) — thêm `F3_01` và `C_01` lỗi 1 (NaN).

| Lỗi GT | Trước việc 2 | Sau việc 2 |
|---|---|---|
| `F1_01`, `F1_03`, `F6_03` ×3 | ✅ | ✅ (không đổi) |
| `F3_01` (tf_gap) | ⚠️ đúng topic, sai severity, không nêu edge | ✅ đúng topic + đúng edge (trong finding) + fix đúng hướng; còn sai severity (`high` vs `critical`, giống mức độ sai còn tồn ở `F1_03`) |
| `C_01` lỗi 1 (NaN) | ❌ bỏ sót hoàn toàn | ✅ đúng topic, cơ chế, cửa sổ, severity, fix |
| `C_01` lỗi 2 (tf_gap) | ❌ bỏ sót hoàn toàn, quy 100% cho `/cmd_vel` | ⚠️ **chưa** ✅ — bằng chứng thô đúng edge, nhưng root_cause + fix vẫn chỉ tay vào `/cmd_vel` do 2 topic chết cách nhau chỉ 10–31ms |
| `F2_04` (clock jump) | ⚠️ sai phân loại | ⚠️ không đổi — cần việc 3 |

**0/9 lỗi còn bị bỏ sót hoàn toàn** (giảm từ 4/9 ở báo cáo gốc, 2/9 sau việc 1). Toàn bộ 9 lỗi GT giờ đều để lại ít nhất một detection thô đúng hướng; lỗi còn thiếu là hiệu chỉnh severity (`F1_03`, `F3_01`), phân loại clock jump (`F2_04`), và causal-ordering ở biên độ mili-giây khi 2 topic chết gần như đồng thời (`C_01` lỗi 2).

**Danh sách ưu tiên còn lại** (đánh số lại từ mục 7, việc 2 đã xong):

1. ~~Cho detector báo mọi lần xuất hiện~~ — đã xong (mục 6).
2. ~~Bổ sung rule chất lượng payload (NaN) + sửa rule TF theo edge~~ — đã xong (mục 8).
3. Phân biệt stamp nhảy lùi với độ trễ thật (`F2_04`).
4. Hiệu chỉnh severity (`F1_03`, `F3_01`: `frequency_gap`/`tf_missing_gap` severity hiện hardcode, không đọc từ độ lớn/thời lượng thực tế), lọc vùng pre-roll trước `bag_t0`, và siết chốt chặn nhân quả ở tầng LLM xuống biên độ mili-giây (không chỉ giây) để tránh lỗi `C_01` lỗi 2 và mục 6.4 tái diễn.

---

*Dữ liệu: `GET /api/v1/analysis/run_{healthy_01_0,C_01_0,F1_01_0,F1_03_0,F2_04_0,F3_01_0,F6_03_0}` · Ground truth: `~/ros2_doctor_ws/bags/`*
