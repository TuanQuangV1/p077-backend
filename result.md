# Kết quả đánh giá LLM trên dataset thật

Chạy lại toàn bộ pipeline sản xuất (`detect_anomalies` → `_cluster_detections` → `explain_detection_cluster`)
với **LLM thật**, rồi so kết luận LLM trả về với ground truth của **từng lỗi tiêm**.

| Hạng mục | Giá trị |
|---|---|
| Thời điểm chạy | 2026-08-26 18:40–18:52 (+07) |
| Model | `gpt-4o-mini` (provider `openai`, đọc từ `.env`) |
| Dataset | `~/ros2_doctor_ws/bags/faulty` (38 bag, 56 lỗi tiêm) + `~/ros2_doctor_ws/bags/healthy` (10 bag sạch) |
| Ngưỡng detector | `data/diagnostics/eval_thresholds.json` (pin bởi script eval, không dùng ngưỡng đã tune qua API) |
| Số lần gọi LLM | 67 (65 cụm trên bag lỗi + 2 cụm trên bag sạch); 26 cụm chỉ chứa actuator bị bỏ qua trước khi gọi |
| Token | 72.539 prompt + 19.794 completion |
| Chi phí | ≈ **0,023 USD** cho một lượt chạy đủ 48 bag |
| Số lượt lặp | n=1 (README benchmark dùng n=3 với `gpt-4.1`, con số vì thế không so trực tiếp được) |

Lệnh tái lập phần detector và chỉ số tổng hợp:

```bash
python scripts/eval_root_cause.py --detector-only --refresh-cache   # detector + clustering, ghi cache detection
python scripts/eval_per_fault.py                                    # gọi LLM thật, chấm từng lỗi
python scripts/eval_root_cause.py --runs 3                          # chỉ số LLM tổng hợp (n=3)
```

Kết quả thô của lượt chạy này (nguyên văn từng câu trả lời LLM, từng cụm, từng lỗi):
`data/diagnostics/per_fault_results.json`.

---

> **Cập nhật 2026-08-26 19:15** — mục 1–6 là số đo *trước* khi sửa code. Hai chốt chặn thứ tự nhân quả
> đã được áp dụng sau đó; kết quả đo lại nằm ở [mục 8](#8-thay-đổi-đã-áp-dụng-và-kết-quả-đo-lại).

## 1. Chỉ số tổng hợp

| Chỉ số | Kết quả | Ghi chú |
|---|---|---|
| Detector phát hiện lỗi tiêm | **55/56 = 98,2%** | chỉ trượt `F4_05` (`/plan`) |
| Báo nhầm trên bag sạch | **2 cảnh báo / 10 bag = 0,2/bag** | `healthy_04`, `healthy_06`, đều là `frequency_gap` ~150 ms trên `/scan`, severity `medium` |
| Cụm có chứa topic ground truth (trần lý thuyết) | **63/65 = 96,9%** | cụm không chứa topic đúng thì không model nào trả lời đúng được |
| Cụm được LLM chỉ đúng topic nguồn | **58/65 = 89,2%** | primary đầu tiên nằm trong tập topic bị tiêm lỗi |
| Lỗi có chẩn đoán riêng chỉ đúng topic | **51/56 = 91,1%** | mỗi lỗi tiêm được một kết luận gọi tên topic của nó, trong đúng cửa sổ thời gian |
| Bag có ít nhất một chẩn đoán đúng | **36/38 = 94,7%** | |
| **Chấm thủ công theo cơ chế lỗi** | **43 ✅ / 8 ⚠️ / 5 ❌** | 76,8% đúng hoàn toàn, 91,1% đúng topic |

Quy ước chấm ở cột "Kết luận" của bảng chi tiết:

- ✅ **Đúng** — LLM chỉ đúng topic nguồn *và* mô tả đúng cơ chế theo bằng chứng detector cấp cho nó.
- ⚠️ **Đúng một phần** — đúng topic nhưng gọi sai/thiếu cơ chế, hoặc lỗi không có kết luận của riêng nó (bị gộp).
- ❌ **Sai** — chỉ sai topic nguồn, hoặc không có chẩn đoán nào cho lỗi đó.

## 2. Kết quả theo nhóm lỗi

| Loại lỗi | Số lỗi | ✅ | ⚠️ | ❌ |
|---|---:|---:|---:|---:|
| `message_gap` | 8 | 8 | 0 | 0 |
| `clock_drift` | 5 | 4 | 1 | 0 |
| `frequency_drop` | 5 | 4 | 1 | 0 |
| `node_crash` | 5 | 1 | 2 | 2 |
| `out_of_range` | 4 | 4 | 0 | 0 |
| `qos_mismatch` | 4 | 4 | 0 | 0 |
| `tf_conflict` | 4 | 3 | 1 | 0 |
| `nan_values` | 3 | 3 | 0 | 0 |
| `node_restart` | 3 | 0 | 2 | 1 |
| `tf_gap` | 3 | 2 | 0 | 1 |
| `timestamp_backwards` | 3 | 2 | 1 | 0 |
| `topic_dead` | 3 | 3 | 0 | 0 |
| `burst` | 2 | 2 | 0 | 0 |
| `tf_loop` | 2 | 1 | 0 | 1 |
| `timestamp_jump` | 2 | 2 | 0 | 0 |
| **Tổng** | **56** | **43** | **8** | **5** |

Đọc bảng này: mọi nhóm lỗi *cấp topic* (mất message, sai payload, lệch clock, hỏng TF) gần như sạch.
Toàn bộ 5 ca ❌ và 4/8 ca ⚠️ nằm ở hai nhóm **`node_crash`** và **`node_restart`** — tức lỗi cấp node,
nơi triệu chứng nằm rải trên nhiều topic và bài toán là chọn đúng topic *nào* trong cụm là nguồn.

## 3. Năm ca sai (❌) — nguyên nhân

| Ca | Chuyện gì xảy ra |
|---|---|
| `C_01` / `F3_01_tf_gap` | Lỗi NaN trên `/scan` (t=155–215s) và tf gap trên `/tf` (t=205–250s) chồng thời gian → clustering gộp thành **một cụm 21 detection**. LLM ra một kết luận duy nhất, coi `/tf` là hệ quả của `/scan`. Detector bắt đúng cả hai (`payload_nan`, `tf_missing_gap×2`), lỗi nằm ở bước gộp cụm. |
| `C_08` / `F3_03_tf_loop` | tf loop kết thúc ở t=142,25s, cụm `/scan` chết bắt đầu ở t=142,22s — lệch **30 ms**. Hai sự cố độc lập bị dính làm một, `/tf` mất chẩn đoán riêng. |
| `C_06` / `F4_01_crash` | Cụm chứa `/tf:tf_conflict` + `/cmd_vel:silent_node`. Quy tắc "lỗi lan từ trên xuống" xếp `/tf` (transform) trên `/cmd_vel` (actuator) nên LLM chọn `/tf`. Ground truth: `collision_monitor` bị OOM-kill, `/cmd_vel` mới là nguồn. |
| `F4_01` / `F4_01_crash` | Y hệt: `/cmd_vel` im từ t=65s, `/tf` conflict mãi t=92s mới xuất hiện, nhưng LLM vẫn kết luận `/tf` gây ra `/cmd_vel` — **ngược chiều thời gian**, và chính câu trả lời của nó ghi rõ hai mốc đó. Ưu tiên tầng đang lấn át bằng chứng thứ tự thời gian. |
| `F4_05` / `F4_05_restart` | **Bag không hề ghi topic `/plan`** (topic có mặt: `/imu`, `/tf`, `/odom`, `/cmd_vel`, `/scan`, `/diagnostics`, `/amcl_pose`, `/tf_static`). Ground truth trỏ vào một topic không tồn tại trong bản ghi → detector không thể bắt, LLM quy nguồn cho `/scan`. Đây là **lỗi dữ liệu**, không phải lỗi pipeline. |

Bốn ca ⚠️ còn lại thuộc cùng họ vấn đề: `C_10/F4_04`, `C_10/F3_05`, `F4_02/F4_02_crash`, `F4_04/F4_04_restart`
đều rơi vào cụm 22–27 detection do amcl crash/restart kéo cả `/scan`, `/imu`, `/tf`, `/odom` chết cùng lúc.
`/tf` có được đánh dấu primary nên chỉ số tự động tính là "đã chẩn đoán", nhưng câu root cause văn xuôi
lại quy nguồn cho `/scan` — người vận hành đọc sẽ đi sai hướng.

## 4. Bag sạch — dương tính giả

| Bag | Số detection | Chi tiết |
|---|---:|---|
| `healthy_04` | 1 | `/scan` `frequency_gap` `medium`, t=47,91→48,07s (gap ~156 ms). LLM: *"/scan failed due to a frequency gap…"* |
| `healthy_06` | 1 | `/scan` `frequency_gap` `medium`, t=14,63→14,79s (gap ~154 ms). LLM: *"The /scan topic experienced a frequency gap…"* |
| 8 bag còn lại | 0 | sạch hoàn toàn |

Cả hai đều là gap ~150 ms trên topic 10 Hz (chu kỳ danh nghĩa 100 ms) — nhiễu ghi hình, không phải lỗi.
Severity `medium` nên không leo lên mức cảnh báo cao. Tỉ lệ 0,2 cảnh báo/bag giữ nguyên như benchmark trong README.

## 5. Bảng chi tiết 56 lỗi

Cột "Detector bắt được" ghi ✔/✘ và các `kind` mà detector sinh ra **trên topic của lỗi, trong cửa sổ tiêm ±10s** —
đây là toàn bộ bằng chứng LLM có; cột "Root cause LLM trả về" là nguyên văn trường `root_cause` model trả về.

| # | Bag | Lỗi tiêm (ground truth) | Topic | Detector bắt được | LLM primary | Root cause LLM trả về | Kết luận |
|---|-----|------------------------|-------|-------------------|-------------|-----------------------|----------|
| 1 | `C_01` | **nan_values** — LiDAR lỗi phần cứng: một phần photodiode không trả tín hiệu | `/scan` | ✔ payload_nan | `/scan` | The /scan topic failed first due to a payload_nan, which caused the /tf transform to have a missing gap, leading to issues in the /cmd_vel actuator. | ✅ |
| 2 | `C_01` | **tf_gap** — Node publish odom->base_footprint ngừng; chuỗi map->odom->base_link đứt | `/tf` | ✔ tf_missing_gap×2 | `/scan` | The /scan topic failed first due to a payload_nan, which caused the /tf transform to have a missing gap, leading to issues in the /cmd_vel actuator. | ❌ — Gộp chung cụm với /scan; tf gap bị coi là hệ quả, không có chẩn đoán riêng |
| 3 | `C_02` | **clock_drift** — LiDAR clock lệch dần; AMCL/costmap dùng dữ liệu quá hạn | `/scan` | ✔ clock_drift, hz_drop, frequency_gap, hz_drop_critical | `/scan` | The /scan topic experienced a critical clock drift first, which caused subsequent anomalies in the /tf transform and /cmd_vel actuator topics due to the lack of reliable sensor data. | ✅ |
| 4 | `C_02` | **frequency_drop** — CPU quá tải / driver không giữ kịp update_rate | `/scan` | ✔ clock_drift, hz_drop, frequency_gap, hz_drop_critical | `/scan` | The /scan topic experienced a critical clock drift first, which caused subsequent anomalies in the /tf transform and /cmd_vel actuator topics due to the lack of reliable sensor data. | ⚠️ — Cùng cụm với drift; kết luận chỉ nêu clock drift, bỏ hz_drop |
| 5 | `C_03` | **frequency_drop** — CPU quá tải / driver không giữ kịp update_rate | `/scan` | ✔ frequency_gap, hz_drop_critical | `/scan` | The /scan topic experienced a frequency gap and a critical Hz drop, which caused the /cmd_vel actuator to fail shortly after due to the lack of timely input. | ✅ |
| 6 | `C_03` | **node_crash** — amcl crash; mọi topic và transform nó sở hữu tắt cùng lúc -> suy luận được là lỗi cấp node chứ không phải cấp topic | `/amcl_pose,/tf` | ✔ tf_missing_gap | `/tf` | The /tf transform failed first, leading to the /cmd_vel actuator becoming silent as it could not receive necessary updates. | ⚠️ — Đúng /tf nhưng không nhận ra đây là lỗi cấp node (amcl) |
| 7 | `C_04` | **tf_conflict** — Launch file khai báo trùng: hai node cùng publish một transform với giá trị khác nhau | `/tf` | ✔ tf_conflict | `/tf` | The /tf topic experienced a conflict first, which likely caused the subsequent issues with the /cmd_vel topic, including a frequency gap and a silent node. | ✅ |
| 8 | `C_04` | **timestamp_backwards** — Node restart, clock khởi tạo lại về mốc cũ -> stamp đi lùi | `/imu` | ✔ clock_drift | `/imu` | The /imu sensor experienced critical clock drift, which caused downstream components to fail together. | ✅ — Detector chỉ có kind clock_drift; LLM bám đúng bằng chứng |
| 9 | `C_04` | **frequency_drop** — DiffDrive plugin trễ / thread bị starve | `/odom` | ✔ frequency_gap | `/odom` | /odom experienced a frequency gap, which likely caused downstream issues in the system. | ✅ |
| 10 | `C_05` | **qos_mismatch** — Publisher khai BEST_EFFORT còn subscriber RELIABLE -> endpoint không match, message mất thầm lặng, không log | `/scan` | ✔ frequency_gap, message_drop_burst, silent_node | `/scan` | The /scan topic experienced a silent node failure first, which caused subsequent frequency gaps and message drop bursts as the sensor stopped providing data. | ✅ — QoS không quan sát được từ bag; LLM mô tả đúng triệu chứng silent_node |
| 11 | `C_05` | **message_gap** — Depth queue quá nhỏ so với tần số 200Hz -> rơi cụm message | `/imu` | ✔ frequency_gap, message_drop_burst, silent_node | `/imu` | The /imu sensor failed first due to a frequency gap, which caused subsequent message drop bursts and silent node issues. | ✅ |
| 12 | `C_06` | **out_of_range** — Sai hệ số scale trong driver: giá trị vượt dải đo của cảm biến (±16g) | `/imu` | ✔ payload_out_of_range | `/imu` | The /imu sensor experienced a payload out of range failure, which likely caused downstream components to malfunction due to the lack of valid data. | ✅ |
| 13 | `C_06` | **clock_drift** — Clock trôi dần trước khi daemon NTP step-correct | `/odom` | ✔ clock_drift | `/odom` | The /odom topic experienced clock drift, which likely caused issues in the state estimation layer. No other anomalies were recorded, indicating that this was the primary failure. | ✅ |
| 14 | `C_06` | **node_crash** — collision_monitor bị OOM-kill; nó là node cuối chuỗi vận tốc nên /cmd_vel mất hoàn toàn, robot đứng im | `/cmd_vel` | ✔ silent_node | `/odom` | The /odom topic experienced clock drift, which likely caused issues in the state estimation layer. No other anomalies were recorded, indicating that this was the primary failure. | ❌ — Cụm ghép /tf conflict + /cmd_vel silent; LLM chọn /tf làm nguồn |
| 15 | `C_08` | **tf_loop** — URDF/launch sai: base_link->map khép vòng với map->odom->base_footprint->base_link | `/tf` | ✔ tf_missing_gap×2 | `/scan` | The /scan topic experienced a critical silent node failure first, which caused subsequent failures in the /tf transform and /cmd_vel actuator topics due to the lack of valid sensor data. | ❌ — tf gap bị hút vào cụm /scan chết ngay sau đó |
| 16 | `C_08` | **topic_dead** — LiDAR driver crash hoặc bridge mất kết nối gz transport | `/scan` | ✔ frequency_gap, message_drop_burst, silent_node | `/scan` | The /scan topic experienced a critical silent node failure first, which caused subsequent failures in the /tf transform and /cmd_vel actuator topics due to the lack of valid sensor data. | ✅ |
| 17 | `C_09` | **burst** — Driver buffer message rồi flush theo cụm thay vì stream đều | `/imu` | ✔ frequency_gap×10, message_drop_burst×10, silent_node×10, header_latency | `/imu` | The /imu sensor experienced multiple failures simultaneously, including a frequency gap, message drop burst, silent node, and header latency, which caused downstream issues in the /cmd_vel actuator. | ✅ |
| 18 | `C_09` | **timestamp_jump** — Clock reset / NTP step-adjust nhảy về tương lai | `/odom` | ✔ clock_drift | `/odom` | The /odom topic experienced a critical clock drift, which likely caused the downstream actuator anomalies in /cmd_vel to occur simultaneously as they all depend on the state estimate provided by /odom. | ✅ — Detector gộp jump vào clock_drift |
| 19 | `C_09` | **out_of_range** — Lỗi encoding: raw count không được scale, vượt xa range_max vật lý 3.5m | `/scan` | ✔ payload_out_of_range | `/scan` | The /scan topic experienced a payload_out_of_range anomaly first, which caused the subsequent issues with the /cmd_vel actuator topics that followed due to the lack of valid sensor data. | ✅ |
| 20 | `C_10` | **node_restart** — Supervisor restart amcl: gap rồi phục hồi -> phân biệt với node_crash ở chỗ topic sống lại | `/amcl_pose,/tf` | ✔ tf_missing_gap×2, hz_drop | `/scan` | The /scan topic experienced a frequency gap, message drop burst, and silent node failure starting at 45.013 seconds, which caused subsequent failures in the /imu and /odom topics. The /tf transform anomalies followed due to the issues with the upstream sensor data. | ⚠️ — /tf có được gán primary nhưng câu root cause quy nguồn cho /scan |
| 21 | `C_10` | **tf_conflict** — Static transform publisher thừa trong launch, tranh map->odom với AMCL | `/tf` | ✔ tf_conflict×2, tf_missing_gap×2 | `/scan` | The /scan topic experienced a frequency gap, message drop burst, and silent node failure starting at 45.013 seconds, which caused subsequent failures in the /imu and /odom topics. The /tf transform anomalies followed due to the issues with the upstream sensor data. | ⚠️ — Cụm 22 detection; tf_conflict không được nêu tên trong kết luận |
| 22 | `F1_01` | **topic_dead** — LiDAR driver crash hoặc bridge mất kết nối gz transport | `/scan` | ✔ frequency_gap×2, message_drop_burst, silent_node | `/scan` | The /scan topic experienced a critical silent node failure first, which caused subsequent failures in the /tf transform and /cmd_vel actuator topics due to the lack of data. | ✅ |
| 23 | `F1_02` | **frequency_drop** — CPU quá tải / driver không giữ kịp update_rate | `/scan` | ✔ frequency_gap, hz_drop_critical | `/scan` | The /scan topic experienced a frequency gap and a critical Hz drop, which caused the /cmd_vel actuator to also experience a frequency gap as it relied on the data from /scan. | ✅ |
| 24 | `F1_03` | **frequency_drop** — DiffDrive plugin trễ / thread bị starve | `/odom` | ✔ frequency_gap | `/odom` | /odom experienced a frequency gap that lasted for 80 seconds, which likely caused downstream issues in the system. | ✅ |
| 25 | `F1_04` | **burst** — Driver buffer message rồi flush theo cụm thay vì stream đều | `/imu` | ✔ frequency_gap×10, message_drop_burst×10, silent_node×10 | `/imu` | The /imu sensor failed first due to a frequency gap, which led to subsequent message drops and the node becoming silent. | ✅ |
| 26 | `F1_05` | **topic_dead** — IMU mất nguồn tạm thời, sau đó driver kết nối lại | `/imu` | ✔ frequency_gap, message_drop_burst, silent_node | `/imu` | The /imu sensor failed first due to a silent node, which caused subsequent frequency gaps and message drop bursts. | ✅ |
| 27 | `F2_01` | **clock_drift** — Sensor dùng clock riêng, không sync NTP/PTP với host | `/imu` | ✔ clock_drift | `/imu` | The /imu sensor experienced clock drift, which caused a prolonged issue affecting the data flow. | ✅ |
| 28 | `F2_02` | **clock_drift** — LiDAR clock lệch dần; AMCL/costmap dùng dữ liệu quá hạn | `/scan` | ✔ frequency_gap×2, clock_drift | `/scan` | The /scan topic experienced a frequency gap, which caused downstream components to potentially stall or behave unexpectedly. | ⚠️ — Đúng topic nhưng gọi tên frequency gap thay vì clock drift (kind critical trong cụm) |
| 29 | `F2_03` | **timestamp_jump** — Clock reset / NTP step-adjust nhảy về tương lai | `/odom` | ✔ clock_drift | `/odom` | /odom experienced clock drift, which likely caused downstream issues in the state estimation layer. | ✅ — Detector gộp jump vào clock_drift |
| 30 | `F2_04` | **timestamp_backwards** — Node restart, clock khởi tạo lại về mốc cũ -> stamp đi lùi | `/imu` | ✔ clock_drift | `/imu` | The /imu sensor experienced critical clock drift, which caused downstream components to fail together due to their reliance on the faulty data. | ✅ — Detector gộp stamp lùi vào clock_drift |
| 31 | `F2_05` | **clock_drift** — Clock trôi dần trước khi daemon NTP step-correct | `/odom` | ✔ clock_drift×2 | `/odom` | /odom experienced clock drift, which likely caused issues in downstream components relying on accurate state estimation. | ✅ |
| 32 | `F2_05` | **timestamp_backwards** — NTP step-adjust kéo clock lùi lại đột ngột | `/odom` | ✔ clock_drift×2 | `/odom` | /odom experienced clock drift, which likely caused issues in downstream components relying on accurate state estimation. | ⚠️ — Hai lỗi cùng topic dùng chung một kết luận |
| 33 | `F3_01` | **tf_gap** — Node publish odom->base_footprint ngừng; chuỗi map->odom->base_link đứt | `/tf` | ✔ hz_drop_critical, tf_missing_gap×2 | `/tf` | The /tf transform experienced a critical drop in frequency, which caused subsequent failures in the /cmd_vel actuator topics. They all failed together due to the lack of valid transform data. | ✅ |
| 34 | `F3_02` | **tf_conflict** — Launch file khai báo trùng: hai node cùng publish một transform với giá trị khác nhau | `/tf` | ✔ tf_conflict | `/tf` | The /tf topic experienced a conflict, which likely caused downstream components to fail as they relied on the transform data. | ✅ |
| 35 | `F3_03` | **tf_loop** — URDF/launch sai: base_link->map khép vòng với map->odom->base_footprint->base_link | `/tf` | ✔ tf_missing_gap | `/tf` | The /tf transform failed first, leading to the subsequent failures of /cmd_vel due to the lack of necessary transform data for proper operation. | ✅ — Detector báo tf_missing_gap, không có kind riêng cho loop |
| 36 | `F3_04` | **tf_gap** — Nguồn TF odometry ngừng hoàn toàn | `/tf` | ✔ tf_missing_gap×2, hz_drop_critical | `/tf` | The /tf transform experienced a critical missing gap starting at 70.256 seconds, which caused subsequent failures in the /cmd_vel actuator topics due to lack of timely data. | ✅ |
| 37 | `F3_05` | **tf_conflict** — Static transform publisher thừa trong launch, tranh map->odom với AMCL | `/tf` | ✔ tf_conflict | `/tf` | The /tf transform experienced a critical conflict starting at 51.148 seconds, which led to multiple issues with the /cmd_vel actuator that began shortly after at 52.488 seconds. | ✅ |
| 38 | `F4_01` | **node_crash** — collision_monitor bị OOM-kill; nó là node cuối chuỗi vận tốc nên /cmd_vel mất hoàn toàn, robot đứng im | `/cmd_vel` | ✔ silent_node | `/tf` | The /tf topic experienced a critical conflict starting at 92.306 seconds, which caused the /cmd_vel actuator to become silent starting at 65.098 seconds and continuing until the end of the recording. | ❌ — Cụm ghép /tf conflict (t=92s) với /cmd_vel silent (t=65s); LLM chọn /tf dù nó xảy ra sau |
| 39 | `F4_02` | **node_crash** — amcl crash; mọi topic và transform nó sở hữu tắt cùng lúc -> suy luận được là lỗi cấp node chứ không phải cấp topic | `/amcl_pose,/tf` | ✔ tf_missing_gap | `/scan` | The /tf transform failed first, causing the downstream anomalies in /odom and /cmd_vel to occur as a consequence of the missing transform data. | ⚠️ — Câu kết luận nêu đúng /tf nhưng vẫn gán primary cho cả /scan và /imu |
| 40 | `F4_03` | **node_crash** — controller_server chết; velocity_smoother hết đầu vào, /cmd_vel về 0 rồi ngừng | `/cmd_vel` | ✔ silent_node | `/cmd_vel` | /cmd_vel failed first due to being a silent node, which caused the actuator to stop functioning for the remainder of the recording. | ✅ |
| 41 | `F4_04` | **node_restart** — Supervisor restart amcl: gap rồi phục hồi -> phân biệt với node_crash ở chỗ topic sống lại | `/amcl_pose,/tf` | ✔ tf_missing_gap×2 | `/scan` | The /scan and /imu topics failed together due to a frequency gap and message drop burst, which caused downstream anomalies in the /odom and /cmd_vel topics. | ⚠️ — /tf có primary nhưng root cause quy cho /scan+/imu |
| 42 | `F4_05` | **node_restart** — planner_server restart; bt_navigator báo lỗi rồi lập kế hoạch lại được | `/plan` | ✘ — | `/scan` | The /scan topic experienced a frequency gap, message drop burst, and silent node failure first, which caused subsequent failures in the /imu, /tf, and /odom topics due to their reliance on the /scan data. The /cmd_vel anomalies occurred later as a consequence of the earlier failures. | ❌ — Detector không phát hiện gì trên /plan -> LLM không có dữ liệu |
| 43 | `F5_01` | **nan_values** — LiDAR lỗi phần cứng: một phần photodiode không trả tín hiệu | `/scan` | ✔ payload_nan | `/scan` | The /scan topic experienced a critical payload_nan failure, which caused the downstream /cmd_vel actuator anomalies to occur as a consequence of the lack of valid sensor data. | ✅ |
| 44 | `F5_03` | **nan_values** — IMU mất I2C/SPI, driver đẩy NaN thay vì giữ giá trị cũ | `/imu` | ✔ payload_nan | `/imu` | The /imu sensor experienced a critical payload_nan failure, which caused downstream components to fail as well. | ✅ |
| 45 | `F5_04` | **out_of_range** — Lỗi encoding: raw count không được scale, vượt xa range_max vật lý 3.5m | `/scan` | ✔ payload_out_of_range, frequency_gap | `/scan` | /scan failed first due to payload being out of range, which likely caused downstream anomalies in the system. | ✅ |
| 46 | `F5_05` | **out_of_range** — Sai hệ số scale trong driver: giá trị vượt dải đo của cảm biến (±16g) | `/imu` | ✔ payload_out_of_range | `/imu` | The /imu sensor experienced a payload out of range issue, which caused downstream anomalies in the system. | ✅ |
| 47 | `F6_01` | **qos_mismatch** — Publisher khai BEST_EFFORT còn subscriber RELIABLE -> endpoint không match, message mất thầm lặng, không log | `/scan` | ✔ frequency_gap, message_drop_burst, silent_node | `/scan` | The /scan topic experienced a silent node failure first, which caused both the frequency gap and message drop burst anomalies to occur simultaneously. | ✅ — Mô tả đúng triệu chứng; QoS profile không có trong bag |
| 48 | `F6_02` | **qos_mismatch** — Odometry publisher hạ xuống BEST_EFFORT sau khi sửa config; recorder giữ RELIABLE nên không nhận được gì | `/odom` | ✔ frequency_gap, message_drop_burst, silent_node | `/odom` | The /odom topic experienced a silent node failure first, which led to both a frequency gap and a message drop burst as downstream consumers were unable to receive updates. | ✅ |
| 49 | `F6_03` | **message_gap** — Queue overflow theo chu kỳ khiến message rơi thành cụm | `/scan` | ✔ frequency_gap, message_drop_burst, silent_node | `/scan` | The /scan topic experienced multiple failures simultaneously, including a frequency gap, message drop burst, and silent node, which caused the downstream /tf transform to also fail. The /cmd_vel actuator anomalies followed due to the lack of valid transform data. | ✅ |
| 50 | `F6_03` | **message_gap** — Queue overflow theo chu kỳ khiến message rơi thành cụm | `/scan` | ✔ frequency_gap, message_drop_burst, silent_node | `/scan` | The /scan topic experienced a frequency gap, message drop burst, and silent node failure simultaneously, which caused the downstream /tf transform to report a missing gap. This, in turn, led to the actuator anomalies in /cmd_vel. | ✅ |
| 51 | `F6_03` | **message_gap** — Queue overflow theo chu kỳ khiến message rơi thành cụm | `/scan` | ✔ frequency_gap, message_drop_burst, silent_node | `/scan` | The /scan topic experienced a frequency gap, message drop burst, and silent node issues simultaneously, which caused the downstream /tf transform to fail and subsequently led to the /cmd_vel actuator anomalies. | ✅ |
| 52 | `F6_04` | **message_gap** — Depth queue quá nhỏ so với tần số 200Hz -> rơi cụm message | `/imu` | ✔ frequency_gap, message_drop_burst, silent_node | `/imu` | The /imu sensor experienced a frequency gap, which caused message drops and resulted in the node becoming silent. These failures occurred simultaneously. | ✅ |
| 53 | `F6_04` | **message_gap** — Depth queue quá nhỏ so với tần số 200Hz -> rơi cụm message | `/imu` | ✔ frequency_gap, message_drop_burst, silent_node | `/imu` | The /imu sensor failed first due to a frequency gap, which caused subsequent message drops and a silent node condition. | ✅ |
| 54 | `F6_04` | **message_gap** — Depth queue quá nhỏ so với tần số 200Hz -> rơi cụm message | `/imu` | ✔ frequency_gap, message_drop_burst, silent_node | `/imu` | The /imu sensor experienced a frequency gap, which caused message drop bursts and resulted in the node becoming silent. All three anomalies failed together. | ✅ |
| 55 | `F6_04` | **message_gap** — Depth queue quá nhỏ so với tần số 200Hz -> rơi cụm message | `/imu` | ✔ frequency_gap, message_drop_burst, silent_node | `/imu` | The /imu sensor experienced a frequency gap, which led to message drops and the node becoming silent during the same time frame. | ✅ |
| 56 | `F6_05` | **qos_mismatch** — IMU publisher BEST_EFFORT còn recorder RELIABLE | `/imu` | ✔ frequency_gap, message_drop_burst, silent_node | `/imu` | The /imu sensor experienced a silent node failure, which caused a frequency gap and message drop burst as a consequence of the same underlying issue. | ✅ |

## 6. Giới hạn của phép đo này

- **n=1.** Nhiệt độ/độ ngẫu nhiên của model chưa được khử; README dùng n=3. Các con số ⚠️/❌ ở nhóm node có thể dao động vài ca giữa các lượt.
- **Model khác README.** Chạy này dùng `gpt-4o-mini` (theo `.env` hiện tại), benchmark trong README dùng `gpt-4.1`. Không so trực tiếp 89,2% ở đây với 87,7% trong README.
- **Một số cơ chế lỗi detector không nhìn thấy được**, nên LLM không thể gọi đúng tên dù trả lời hợp lý:
  - `timestamp_jump` và `timestamp_backwards` đều được detector gắn nhãn `clock_drift` → LLM luôn nói "clock drift".
  - `qos_mismatch` chỉ hiện ra dưới dạng `silent_node` + `frequency_gap` + `message_drop_burst`; QoS profile không nằm trong bag.
  - `tf_loop` chỉ hiện ra dưới dạng `tf_missing_gap`.
  - `node_crash` vs `node_restart` chỉ khác nhau ở chỗ topic có sống lại hay không. Tín hiệu này **có trong bag** nhưng detector đang bỏ qua — xem mục 7.1.
- **Chấm ✅/⚠️/❌ là thủ công** (đọc từng câu root cause so với `expected_anomaly.root_cause`). Các chỉ số ở mục 1 tính bằng máy theo topic + cửa sổ thời gian, có thể tái lập.

## 7. Việc nên làm tiếp

### 7.1. Bỏ chặn `/amcl_pose` trong detector — việc đáng làm nhất

`src/services/diagnostics.py:49` liệt `PoseWithCovarianceStamped` vào `_EVENT_DRIVEN_MESSAGE_TYPES`,
và `diagnostics.py:1534` loại mọi topic thuộc nhóm đó khỏi toàn bộ luật cadence. Hệ quả:
`/amcl_pose` là topic mục tiêu của **4 lỗi tiêm** nhưng **không sinh một detection nào trên toàn bộ 38 bag**.
Cả 4 lỗi đó chỉ lộ ra gián tiếp qua `/tf`, và đó chính là 4 ca ⚠️ ở nhóm node.

Số đo trực tiếp trên bag (gap lớn nhất giữa hai message `/amcl_pose`):

| Bag | median | gap lớn nhất | im lặng tới cuối bag |
|---|---:|---:|---:|
| 10 bag `healthy` | 0,90–1,00 s | **2,50–3,11 s** | < 1,8 s |
| `C_03` (amcl crash) | 0,90 s | 10,80 s | **125,25 s** |
| `F4_04` (amcl restart) | 0,90 s | **19,90 s** | 0,78 s |
| `F4_02` (amcl crash) | — | topic chết ở t=54,6 s, bag chạy tới ~180 s | |

Ngưỡng ~5 s (median × 5) tách sạch faulty khỏi healthy với biên 60%, **0 dương tính giả trên cả 10 bag sạch**.
Thêm nữa, chính bảng này phân biệt được `node_crash` (im tới hết bag) với `node_restart` (gap rồi hồi phục) —
điều mục 6 đang ghi là "không có tín hiệu phân biệt".

Cách làm an toàn với lý do ban đầu của việc loại trừ (tránh báo nhầm khi topic nghỉ tự nhiên):
giữ nguyên `_EVENT_DRIVEN_MESSAGE_TYPES` cho các luật cadence, nhưng thêm một luật **chỉ bắt "ngừng hẳn"** —
gap ≥ max(5 s, median × 5) trên topic vốn có nhịp đều — rồi đo lại `healthy_per_bag` để xác nhận vẫn bằng 0,2.

### 7.2. Các việc còn lại

1. **Chống gộp cụm quá tay** — hai ca ❌ (`C_01`, `C_08`) và bốn ca ⚠️ đều do nhiều sự cố độc lập rơi vào một cụm. Cân nhắc tách cụm khi có hai detection `critical` trên hai topic khác nhau cách nhau > 30s, hoặc cho phép trả về nhiều root cause trên một cụm.
2. **Ràng buộc thứ tự thời gian mạnh hơn ưu tiên tầng** — `F4_01` và `C_06` sai vì `/tf` xuất hiện *sau* `/cmd_vel` mà vẫn được chọn làm nguồn. Một chốt chặn code (nguồn không được bắt đầu sau hệ quả quá X giây) sẽ chặn cả hai.
3. **Sửa dữ liệu `F4_05`** — bag không ghi `/plan`; hoặc ghi lại bag có topic đó, hoặc đổi `target_topics` sang tín hiệu thực sự quan sát được. Recall không bao giờ chạm 100% chừng nào ground truth còn trỏ vào topic không tồn tại.
4. **Thêm `kind` riêng cho `timestamp_jump` / `timestamp_backwards`** — hiện gộp vào `clock_drift`, làm trần chính xác về mặt cơ chế thấp hơn thực lực của model.

---

## 8. Thay đổi đã áp dụng và kết quả đo lại

Áp dụng khuyến nghị 7.2.2 (chốt thứ tự thời gian). Chạy lại trên **đúng cache detection cũ**
(`data/diagnostics/eval_detections.json` không đổi), nên toàn bộ chênh lệch là do thay đổi code.

### Hai thay đổi trong `src/services/llm.py`

1. **`_gate_actuator_primary`** — trước đây hạ `/cmd_vel` xuống `consequence` khi *bất kỳ* bất thường
   upstream nào chồng thời gian, không xét cái nào bắt đầu trước. Nay chỉ hạ khi bất thường upstream
   bắt đầu **không muộn hơn** actuator (biên `_SIMULTANEOUS_WINDOW_SEC` = 0,5 s).
2. **`_enforce_causal_order`** (mới) — nâng ngược một bất thường bị gán `consequence` nhưng bắt đầu
   sớm hơn *mọi* bất thường được gán `primary` quá 0,5 s. Cần thêm hàm này vì `_gate_actuator_primary`
   chỉ biết hạ cấp: ở `F4_01`, chính model đã gán `/cmd_vel` (im từ t=304 s) là hệ quả của `/tf` conflict
   (t=331 s), nên sửa cổng gác không đủ.

Thứ tự áp dụng: `_enforce_simultaneity` → `_enforce_causal_order` → `_gate_actuator_primary`.
Cổng gác không còn đảo ngược bước mới, vì upstream bắt đầu sau actuator thì không hạ cấp nữa.

Kèm 6 test hồi quy trong `tests/test_services/test_llm_payload.py` (gồm cả nhánh hỏng lại và nhánh chèn đính chính); toàn bộ **327 test pass**, ruff sạch trên các file đã sửa.

### Đo lại (cùng model `gpt-4o-mini`, cùng cache detection)

| Chỉ số | Trước | Sau |
|---|---:|---:|
| Lỗi có chẩn đoán riêng đúng topic | 51/56 (91,1%) | **54/56 (96,4%)** |
| Cụm chỉ đúng topic nguồn (primary đầu tiên) | 58/65 (89,2%) | 58/65 (89,2%) |
| Detection trên 10 bag sạch | 2 | 2 |
| Token completion | 19.794 | 19.907 |

Ba lỗi được sửa, không có lỗi nào hỏng đi:

| Lỗi | Trước | Sau |
|---|---|---|
| `C_06` / `F4_01_crash` (`/cmd_vel`) | ❌ | ✅ role đúng |
| `F4_01` / `F4_01_crash` (`/cmd_vel`) | ❌ | ✅ role đúng |
| `C_08` / `F3_03_tf_loop` (`/tf`) | ❌ | ✅ role đúng (được hưởng lợi ngoài dự kiến: tf gap bắt đầu trước cụm `/scan`) |

Số ❌ còn lại: **2** — `C_01`/`F3_01_tf_gap` (gộp cụm) và `F4_05`/`F4_05_restart` (bag thiếu topic `/plan`).

### Bước 3: hỏi lại model khi phát hiện chiều nhân quả bất khả thi

Hai chốt chặn trên chỉ viết lại `findings[].role`; trường `root_cause` dạng văn xuôi — thứ người vận hành
thực sự đọc — vẫn giữ nguyên câu sai chiều. Bổ sung trong `explain_detection_cluster`:

khi `_causal_order_violations` phát hiện một anomaly bắt đầu sớm hơn *mọi* anomaly bị gán primary,
gọi model **thêm đúng một lần**, đính kèm câu trả lời cũ và trích lại chính các mốc `start_sec` của nó:
*"…index 2 (/cmd_vel) starts at 304.020s. The earliest anomaly you marked primary is /tf at 331.230s…
A consequence cannot start before its cause. Re-answer…"*.
Nếu lượt hỏi lại vẫn vi phạm, code sửa role như cũ **và** chèn một câu đính chính vào `explanation`
để văn xuôi không mâu thuẫn với bảng bằng chứng.

Đo trên toàn corpus: đúng **3/65 cụm** kích hoạt hỏi lại (`C_06`, `C_08`, `F4_01`), và **cả 3 lần model tự sửa**,
nên nhánh chèn câu đính chính không phải dùng tới (vẫn có test bao phủ).

> ⚠️ Chỉ số "lỗi có chẩn đoán riêng đúng topic" trong mục 8–10 là **định nghĩa lỏng của riêng
> `scripts/eval_per_fault.py`** (chấp nhận bất kỳ topic nào được gán primary, dung sai ±10 s), khác với
> `fault_diagnosed_pct` chính thức của `scripts/eval_root_cause.py` (chỉ tính primary **đầu tiên**, không dung sai).
> Xem [mục 11](#11-đối-chiếu-với-chỉ-số-chính-thức--đính-chính) trước khi trích các con số này.

| Chỉ số | Trước khi sửa | Sau 2 chốt chặn | Sau khi thêm hỏi lại |
|---|---:|---:|---:|
| Lỗi có chẩn đoán riêng đúng topic | 51/56 (91,1%) | 54/56 (96,4%) | **54/56 (96,4%)** |
| Cụm chỉ đúng topic nguồn | 58/65 (89,2%) | 58/65 (89,2%) | **60/65 (92,3%)** |
| Detection trên 10 bag sạch | 2 | 2 | 2 |
| Chi phí một lượt 48 bag | 0,0228 USD | 0,0229 USD | **0,0242 USD** (+6%) |

Câu văn của `F4_01` sau khi hỏi lại đã đúng chiều:
*"The /cmd_vel actuator became silent starting at 65.098 seconds, which led to the critical tf_conflict
on the /tf topic beginning at 92.306 seconds."* — trước đó là câu ngược lại.

### Điều còn lại: văn xuôi vẫn có thể sai dù role đã đúng

Cơ chế hỏi lại chỉ kích hoạt khi thứ tự thời gian **bất khả thi** (hệ quả bắt đầu trước mọi nguyên nhân).
Nó không bắt được câu văn sai kiểu tinh vi hơn, khi role đã đúng nhưng lời giải thích vẫn gán nhân quả ngược.
Ví dụ `C_06` cụm 2 sau khi sửa: `primary_topics = ['/cmd_vel']` (đúng), nhưng câu văn vẫn là
*"The /cmd_vel actuator became silent due to the earlier /tf transform conflict"* — trong khi `/cmd_vel`
im từ t=189,1 s còn `/tf` conflict mãi t=220,4 s mới có, tức `/tf` không hề "earlier".
`C_08` cụm 4 cũng vậy: role đúng, câu văn vẫn kể `/scan` hỏng trước `/tf`.

Muốn chặn nốt lớp này thì phải đối chiếu *nội dung câu văn* với các mốc `start_sec` — tốn kém hơn nhiều
(cần một lượt kiểm tra riêng hoặc bắt model xuất thứ tự dưới dạng có cấu trúc rồi mới sinh văn xuôi từ đó).
Đây là việc còn để ngỏ.

Tỉ lệ anomaly được gán `primary` tăng nhẹ 52,5% → 56,0%; số cụm có nhiều hơn một topic primary tăng 13 → 17/65,
tức chốt chặn không làm "mọi thứ đều primary".

### Kết quả thô

- `data/diagnostics/per_fault_results.json` — lượt sau khi sửa
- `data/diagnostics/per_fault_results_before_fix.json` — lượt gốc dùng cho mục 1–6

---

## 9. Bỏ chặn `/amcl_pose` (khuyến nghị 7.1) — đã làm, kết quả nửa vời

### Thay đổi

`src/services/diagnostics.py`: topic event-driven vẫn nằm ngoài các luật cadence, nhưng nay **có** chạy
luật `silent_node` với hai ràng buộc riêng — ngưỡng sàn `event_topic_silent_min_sec` = 5 s
(`diagnostics_config.py`) và **chỉ tính quãng im mà topic không bao giờ hồi phục**.
Mọi detection `silent_node` nay kèm `evidence.resumed`.

### Vì sao phải thêm ràng buộc "không hồi phục"

Bản đầu chỉ đặt sàn 5 s. Đo lại: recall và false positive không đổi, nhưng số cụm nhảy 65 → 81 và
**trần lý thuyết tụt 96,9% → 81,5%**. Nguyên nhân: `/amcl_pose` không hề đều đặn như 10 bag sạch gợi ý.

| Bag | median | p90 | max gap |
|---|---:|---:|---:|
| `healthy_*` | 0,90–1,00 s | ~1,0 s | 2,50–3,11 s |
| `C_09` | 0,30 s | 2,00 s | 9,21 s |
| `F3_03` | 0,31 s | 2,20 s | 8,59 s |
| `C_10` | 0,30 s | 6,50 s | 12,80 s |

Ở các bag mà định vị bị suy giảm, amcl publish theo cụm với quãng nghỉ 7–12 s **là bình thường**.
Ngưỡng 5 s biến chúng thành ~10 detection nhiễu mỗi bag; tệ hơn, vì `/amcl_pose` không thuộc tầng actuator,
những detection đó "cứu" các cụm toàn `/cmd_vel` khỏi bộ lọc cascade, khiến 16 cụm vô nghĩa được đưa lên LLM.
Siết thành "chỉ khi ngừng hẳn" đưa số detection `/amcl_pose` trên toàn corpus xuống còn **4**, đều là critical:
`C_03` (125 s), `F4_02` (149 s), `F4_03` (133 s), `F5_01` (52 s).

### Đo lại

| Chỉ số | Trước mục 9 | Sau mục 9 |
|---|---:|---:|
| Detector recall | 55/56 | 55/56 |
| Detection trên bag sạch | 2 | 2 |
| Trần lý thuyết (cụm chứa topic GT) | 63/65 (96,9%) | 63/66 (95,5%) |
| Lỗi có chẩn đoán đúng topic | 54/56 | 55/56 |
| Cụm chỉ đúng topic nguồn | 60/65 (92,3%) | 59/66 (89,4%) |
| Chi phí | 0,0242 USD | 0,0239 USD |

**Không quy công cho thay đổi này được.** Lỗi duy nhất đổi trạng thái là `C_01`/`F3_01_tf_gap`
(False → True), mà `C_01` không còn detection `/amcl_pose` nào — nên đó là dao động của model giữa hai lượt,
không phải tác dụng của bản vá. Với n=1 thì chênh lệch ±1 ca nằm trong nhiễu; muốn kết luận phải chạy n=3.

### Cái thu được, và cái không

Thu được: ở hai bag amcl crash, bằng chứng nay có chính topic của node chết. `F4_02` trả lời:
*"The /tf transform failed first due to a critical missing gap, which led to the /amcl_pose state estimate
becoming silent"* — trước đó `/amcl_pose` hoàn toàn vô hình.

Không thu được: **vẫn chưa phải cách diễn giải cấp node**. Ground truth nói amcl chết nên mọi thứ nó publish
tắt cùng lúc; model vẫn kể `/tf` hỏng trước rồi `/amcl_pose` hỏng theo. Và đây là chỗ số liệu nói ngược lại model:

```
/amcl_pose silent_node  start 82.316s   (amcl ngừng publish)
/tf         tf_missing_gap start 82.916s (cạnh map->odom đứt)
```

Hai thứ cách nhau **0,6 s**, và `/amcl_pose` là cái *sớm hơn*. Chúng cách nhau 0,6 s chỉ vì tần số publish
khác nhau (amcl_pose ~1,1 Hz, tf 80 Hz). `_SIMULTANEOUS_WINDOW_SEC` = 0,5 s nên chốt chặn "đồng thời"
không kích hoạt, và `_enforce_causal_order` cũng không, vì cả hai đều đã là primary — chỉ có câu văn sai.

Lỗi `node_restart` thì mất hẳn khả năng phát hiện qua `/amcl_pose`: quãng gián đoạn rồi hồi phục
(`C_10` 12,8 s, `F4_04` 19,9 s) không tách được khỏi nhịp publish theo cụm của chính amcl trong bag khác.
Đây là điều chỉnh so với dự đoán ở mục 7.1 — nới lỏng để bắt restart thì kéo theo nhiễu đã đo ở trên.

### Hai hướng còn lại cho lớp lỗi cấp node

1. **Nới cửa sổ "đồng thời" cho các topic cùng chết**: hai topic có message cuối cách nhau < ~2 s và
   đều không hồi phục là một sự kiện, không phải nhân quả. Đây là cách rẻ nhất để ép ra câu
   "chúng chết cùng lúc" đúng như ground truth mô tả. Cần đo vì `_SIMULTANEOUS_WINDOW_SEC` dùng chung toàn hệ.
2. **Cấp bản đồ `topic -> node` cho reader**: bag ROS 2 không lưu tên node publisher —
   `evidence.node` hiện chỉ là đoạn đầu của tên topic (`_infer_node` trong `bag_stream.py:70`),
   nên `/amcl_pose` báo node `"amcl_pose"`. Reader đã có sẵn tham số `node_map`
   (`bag_readers/base.py:75`); khai báo `/amcl_pose` và cạnh `map->odom` cùng thuộc `amcl`
   sẽ cho model căn cứ thật để kết luận lỗi cấp node thay vì suy từ thứ tự thời gian.

---

## 10. Chạy n=3 — mọi con số ở trên đều phải đọc lại

Ba lượt LLM trên **cùng một cache detection** (`eval_detections.json` không đổi giữa các lượt),
cùng code hiện tại, cùng `gpt-4o-mini`.

| Chỉ số | run 1 | run 2 | run 3 | median [min–max] |
|---|---:|---:|---:|---|
| Lỗi có chẩn đoán đúng topic | 55 | 53 | 53 | **53/56** [53–55] |
| Cụm chỉ đúng topic nguồn | 59 | 58 | 58 | **58/66** [58–59] |
| Số cụm gửi LLM | 66 | 66 | 66 | 66 |
| Lượt hỏi lại vì sai chiều nhân quả | 2 | 3 | 4 | 3 |
| Chi phí | 0,0239 | 0,0251 | 0,0251 | **0,0251 USD** |
| Detection trên bag sạch | 2 | 2 | 2 | 2 |

### Phân rã theo độ ổn định của từng lỗi

| Nhóm | Số lỗi |
|---|---:|
| Đúng cả 3 lượt | **52/56** |
| Sai cả 3 lượt | 1/56 — `F4_05` (bag không ghi `/plan`) |
| Lúc đúng lúc sai | 3/56 |

Ba ca dao động: `C_01`/`F3_01_tf_gap` [T,F,F] (cụm bị gộp), `C_08`/`F1_01_topic_dead` [T,F,T],
`C_09`/`F5_04_oor` [T,T,F].

### Điều này nói gì về các mục 8–9

**Ba trong năm ca ❌ ban đầu nay đúng cả 3 lượt:**

| Lỗi | Lượt gốc | n=3 hiện tại |
|---|---|---|
| `C_06` / `F4_01_crash` | ❌ | [T, T, T] |
| `F4_01` / `F4_01_crash` | ❌ | [T, T, T] |
| `C_08` / `F3_03_tf_loop` | ❌ | [T, T, T] |
| `C_01` / `F3_01_tf_gap` | ❌ | [T, F, F] |
| `F4_05` / `F4_05_restart` | ❌ | [F, F, F] |

Với hai ca `F4_01_crash`, đây không chỉ là quan sát thống kê mà là hệ quả logic: dưới code cũ,
`/cmd_vel` **không thể** giữ vai primary — cổng gác hạ nó xuống bất cứ khi nào có bất thường upstream
chồng thời gian, mà `/tf` thì luôn chồng. Sửa điều kiện thứ tự đã gỡ đúng chỗ chặn đó.

**Ngược lại, mọi so sánh ±1 ca giữa hai lượt đơn ở mục 8–9 đều vô nghĩa.** Biên dao động tự nhiên là
±2 ca. Cụ thể: kết luận "mục 9 làm `C_01`/`F3_01_tf_gap` chuyển True" đã sai — ở n=3 ca này là [T,F,F],
tức nó vốn dao động chứ không phải được bản vá `/amcl_pose` sửa. Con số 55/56 của run 1 là đầu may mắn
của dải, không phải giá trị đại diện.

### Trần thực tế hiện tại

- **55/56** là trần: `F4_05` không thể đúng chừng nào bag còn thiếu topic `/plan`.
- **52/56 (92,9%)** là phần chắc chắn, không phụ thuộc may rủi.
- **53/56 (94,6%)** là median — con số nên dùng khi báo cáo.

So sánh với mốc 51/56 ở mục 1 vẫn **chưa có ý nghĩa thống kê**, vì mốc đó cũng chỉ n=1.
Muốn có delta bảo vệ được thì phải revert code + khôi phục cache detection cũ rồi chạy lại 3 lượt
(~36 phút, ~0,075 USD). Riêng hai ca `F4_01_crash` thì không cần, vì lập luận logic ở trên đã đủ.

### Kết quả thô

`data/diagnostics/per_fault_amcl_run{1,2,3}.json` (cấu hình mục 8+9, sau này bị loại — xem mục 12).

---

## 11. Đối chiếu với chỉ số chính thức — đính chính

Chạy n=3 với `gpt-4.1` để so cùng model với benchmark trong README. Khi tính lại bằng **đúng công thức**
`fault_diagnosed_pct` của `scripts/eval_root_cause.py`, bức tranh khác hẳn những gì mục 8–10 báo cáo.

### Sai sót phương pháp

`scripts/eval_per_fault.py` (tôi viết cho báo cáo này) đếm một lỗi là "đã chẩn đoán" khi **bất kỳ** topic nào
trong cụm được gán primary trùng topic mục tiêu, với dung sai ±10 s.
`fault_diagnosed_pct` chính thức chỉ tính **primary đầu tiên** (`primaries[0]`) và không có dung sai.
Hai chốt chặn ở mục 8 chủ yếu **thêm** primary chứ không đổi primary đứng đầu — nên chúng cải thiện chỉ số lỏng
mà gần như không chạm chỉ số chính thức. Mọi con số 51 → 53/54/55 ở mục 8–10 đều là chỉ số lỏng.

### Số liệu theo chỉ số chính thức

| Cấu hình | `fault_diagnosed_pct` | `root_cause_pct` (cụm) | Chi phí/lượt |
|---|---:|---:|---:|
| README (code cũ, `gpt-4.1`, n=3) | 82,1% [82,1–83,9] | 87,7% [87,7–89,2] | ~0,48 USD |
| Code cũ, `gpt-4o-mini`, n=1 | **83,9%** (47/56) | 89,2% (58/65) | 0,023 USD |
| Code mới, `gpt-4o-mini`, n=3 | **83,9%** (47–48/56) | 87,9% (58/66) | 0,025 USD |
| Code mới, `gpt-4.1`, n=3 | **83,9%** (46–47/56) | 87,9% (57–58/66) | **0,40 USD** |

Nói thẳng: **các thay đổi ở mục 8–9 không làm dịch chỉ số chính thức.** 83,9% trước, 83,9% sau, với cả hai model.

### Vì sao net = 0: một cái được, một cái mất

| Lỗi | Code cũ | 4o-mini n=3 | gpt-4.1 n=3 | Diễn giải |
|---|---|---|---|---|
| `F4_01`/`F4_01_crash` | sai | **T T T** | T . T | Được — đúng như lập luận logic ở mục 10 |
| `C_06`/`F4_01_crash` | sai | T . T | . . . | Được, nhưng không ổn định |
| `C_08`/`F3_03_tf_loop` | sai | . T . | T . T | Được, không ổn định |
| `F4_03`/`F4_03_crash` | **đúng** | **. . .** | **. . .** | **Hỏng — sai ở cả 6 lượt mới** |

`F4_03` là hồi quy thật, không phải nhiễu, và nguyên nhân truy được: luật `/amcl_pose` ở mục 9 thêm một
detection `silent_node` critical vào `F4_03` (amcl cũng chết theo, t=132,2 s, 133 s im lặng). `/amcl_pose`
nằm ở tầng state_estimate, trên `/cmd_vel`, nên nó chiếm mất vị trí primary đầu tiên và lỗi `/cmd_vel`
mất kết luận mang tên mình.

### `gpt-4.1` không mắc lỗi mà chốt chặn mục 8 sinh ra để chặn

Số lượt hỏi lại vì sai chiều nhân quả: `gpt-4o-mini` 2–4 lượt/lần chạy, `gpt-4.1` **0 lượt ở cả 3 lần chạy**.
Cơ chế ở mục 8 là nạng cho model rẻ; với model mạnh nó gần như vô tác dụng.

Đổi lại, phát hiện có giá trị thực tế: **`gpt-4o-mini` ngang `gpt-4.1` trên cả hai chỉ số chính thức,
với 1/16 chi phí** (0,025 so với 0,40 USD một lượt 48 bag). Và điều này đúng từ **trước** khi sửa code —
bản chạy code cũ với `gpt-4o-mini` cũng đã 83,9%. Không hề có khoảng cách model nào để thu hẹp.

### Khuyến nghị

1. **Hoàn tác mục 9 (luật `/amcl_pose`).** Nó không đạt mục tiêu ban đầu (không tạo được diễn giải cấp node),
   hạ trần lý thuyết 96,9% → 95,5%, và gây hồi quy ổn định ở `F4_03`. Hoàn tác thì `fault_diagnosed_pct`
   dự kiến về 48/56 (85,7%) — vượt dải cũ 82,1–83,9% — và `root_cause_pct` về 58/65 (89,2%).
   Cần chạy lại để xác nhận, không nên tin con số dự kiến này.
2. **Giữ mục 8.** Chi phí ~6% token trên model rẻ, sửa được `F4_01` một cách chắc chắn về mặt logic,
   và không gây hồi quy nào.
3. **Đổi nhãn model trong README sang `gpt-4o-mini`**, kèm chi phí 0,025 USD/lượt. Không cần đổi các con số
   chính (82,1% → 83,9% nằm trong dải cũ), nhưng nên ghi rõ chi phí giảm 16 lần.

---

## 12. Cấu hình chốt lại — đã đo, đây là bản nên dùng

Hoàn tác mục 9, giữ mục 8, chạy `gpt-4o-mini`. Detector trở về đúng trạng thái trước mục 9:
cache detection sinh lại **trùng khớp từng byte** với bản cũ, trần lý thuyết về lại 96,9%, 65 cụm.

### Số liệu theo chỉ số chính thức, n=3

| Cấu hình | `fault_diagnosed_pct` | `root_cause_pct` | Chi phí/lượt |
|---|---|---|---:|
| README hiện tại (code cũ, `gpt-4.1`, n=3) | 82,1% [82,1–83,9] | 87,7% [87,7–89,2] | ~0,48 USD |
| Code cũ, `gpt-4o-mini`, n=1 | 83,9% | 89,2% | 0,023 USD |
| Mục 8+9, `gpt-4o-mini`, n=3 | 83,9% [83,9–85,7] | 87,9% [87,9–89,4] | 0,025 USD |
| Mục 8+9, `gpt-4.1`, n=3 | 83,9% [82,1–83,9] | 87,9% [85,7–87,9] | 0,40 USD |
| **Mục 8, bỏ mục 9, `gpt-4o-mini`, n=3** | **87,5%** [83,9–87,5] | **92,3%** [89,2–92,3] | **0,024 USD** |

Lượt cụ thể: `fault_diagnosed` 49, 49, 47 / 56 · `root_cause` 60, 60, 58 / 65 · hỏi lại 3, 2, 2 lượt.
Detector giữ nguyên 55/56 và 0,2 cảnh báo trên mỗi bag sạch.

Median vượt trên cả hai mốc cũ; ở `root_cause_pct` thì **min của cấu hình mới (89,2%) đúng bằng max của mốc README**.
Với n=3 thì đây là dấu hiệu rõ chứ chưa phải bằng chứng thống kê mạnh — dải vẫn chạm nhau ở mép.

### Vì sao bỏ mục 9 lại tăng điểm

`/amcl_pose` nằm ở tầng state_estimate, trên `/cmd_vel`. Bốn detection mà mục 9 thêm vào đẩy nó lên
vị trí primary đầu tiên ở những cụm mà thủ phạm thật là `/cmd_vel` — `F4_03` sai ở cả 6 lượt vì lý do đó.
Bỏ luật đi, `F4_03` trở lại đúng, số cụm về 65, và các cải thiện của mục 8 hiện ra trên chỉ số chính thức
thay vì bị bù trừ.

### Việc còn lại

1. **Cập nhật README và `docs/benchmark.md`**: đổi nhãn model sang `gpt-4o-mini`, số mới 87,5% / 92,3%,
   chi phí 0,024 USD/lượt (rẻ hơn 20 lần con số đang ghi).
2. **`F4_05`** vẫn ghim trần ở 55/56 vì bag không ghi topic `/plan` — lỗi dữ liệu, xem mục 3.
3. **Câu văn vẫn có thể mâu thuẫn với bảng bằng chứng** ở lớp tinh vi (mục 8, phần cuối) — rủi ro chất lượng
   duy nhất còn lại với người vận hành.

### Kết quả thô

| File | Cấu hình |
|---|---|
| `per_fault_final_run{1,2,3}.json` | **Bản chốt** — mục 8, không mục 9, `gpt-4o-mini` |
| `per_fault_results.json` | Trỏ tới `final_run1` (một lượt median) |
| `per_fault_results_before_fix.json` | Code gốc, `gpt-4o-mini`, n=1 |
| `per_fault_amcl_run{1,2,3}.json` | Mục 8+9 — đã loại |
| `per_fault_gpt41_run{1,2,3}.json` | Mục 8+9 với `gpt-4.1` — đã loại |

