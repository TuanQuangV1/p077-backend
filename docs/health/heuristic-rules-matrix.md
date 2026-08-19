# PHẦN 2: BỘ QUY TẮC DỰA TRÊN ĐỊNH LƯỢNG

## (Heuristic Rules Matrix)

Full Rule ID / Condition / Penalty / UI-warning table. Penalties là per-detection sub-score deductions được áp dụng trong `health.py` và feed vào colour zone của Health Score (Phần 1).

**Threshold keys** được đọc từ `DEFAULT_DIAGNOSTICS_THRESHOLDS` (`src/services/diagnostics_config.py`); tất cả overridable at runtime via `POST /api/v1/analysis/thresholds`.

---

## 2.1 Bảng Ma trận Quy tắc Tổng hợp

| Nhóm | Rule ID | Detection Kind | Điều kiện Kích hoạt (Condition) | Penalty | UI Warning |
|------|---------|----------------|----------------------------------|---------|------------|
| **LOG** | `LOG-01` | `log_fatal` | `count(fatal) ≥ 1` | −50 (critical) | 🔴 Red band "FATAL on /rosout" |
| **LOG** | `LOG-02` | `log_error_burst` | `count(error) ≥ 3` trong burst window | −30 (high) | 🔴 Red band "ERROR burst" |
| **LOG** | `LOG-03` | `log_warn_storm` | `count(warn) ≥ 10` trong window | −5 (low) | 🟡 Yellow band "WARN storm" |
| **FREQ** | `FREQ-01` | `frequency_gap` | `max interval > max(0.08s, median × 1.5)` | −15 (medium) / −30 (high, sustained ≥10 breaches) | 🟡 Band on lane |
| **FREQ** | `FREQ-02` | `message_drop_burst` | `single interval > 1.0s` | −15 (medium) | 🟡 Band on lane |
| **FREQ** | `FREQ-03` | `hz_drop` | `window rate < expected × 0.70` (drop > 30%) | −15 (medium) | 🟡 Lane + "−X% Hz" badge |
| **FREQ** | `FREQ-04` | `hz_drop_critical` | `window rate < expected × 0.50` (drop > 50%) | −30 (high) | 🔴 Lane + "−X% Hz" badge |
| **FREQ** | `FREQ-05` | `silent_node` | `node active span ≥ 0.3s` | −15 (medium) / −50 (critical, span ≥ `silent_node_critical_sec`) | ⚪ "Node silent" |
| **LAT** | `LAT-01` | `timestamp_jitter` | `std-dev intervals > 0.02s` | −5 (low) | ⚪ "Jitter" |
| **LAT** | `LAT-02` | `clock_drift` | sustained (≥3 msg, ≥0.5s) `|bag − header| > 0.1s`, ổn định (`step`) hoặc đường thẳng sạch (`ramp`) | `step`: −50 (critical) luôn. `ramp`: −30 (high) / −50 (critical, tốc độ ≥40ms/s) | 🟡/🔴 "Clock drift" |
| **LAT** | `LAT-03` | `header_latency` | `≥3 messages với lag > 100ms` | −15 (medium) | 🟡 "Stale stamps" |
| **TF** | `TF-01` | `tf_missing_gap` | `consecutive gap > 0.5s` **on one edge** (grouped by `child_frame_id`) | −30 (high) / −50 (critical, gap ≥15.0s) | 🔴 Edge turns red (Disconnected) |
| **TF** | `TF-02` | `tf_drift_jump` | `child frame re-parented` (VD: odom → map) | −50 (critical) | 🔴 "Localization jump" |
| **TF** | `TF-03` | `tf_conflict` | `≥3 lần nhảy > 0.5m` trên cùng edge, gom trong 2.0s | −30 (high) | 🔴 "Conflicting publishers" |
| **PLD** | `PLD-01` | `payload_zero_byte` | `≥5 messages với payload_bytes == 0` | −30 (high) | 🔴 "PointCloud → 0 B" |
| **PLD** | `PLD-02` | `payload_nan` | `≥5 tin nhắn liên tiếp` có tỉ lệ NaN trong `ranges`/Imu `> 5%` | −50 (critical) | 🔴 "Sensor payload NaN" |
| **PLD** | `PLD-03` | `payload_out_of_range` | `≥5 tin nhắn liên tiếp` có tỉ lệ vượt dải hợp lệ `> 5%` | −30 (high) | 🔴 "Out-of-range readings" |

---

## 2.2 Chi tiết từng nhóm (Detailed Breakdown)

### 2.2.1 Log System Severity (Nhóm LOG)

**Nguồn:** `/rosout`, `/diagnostics` (yêu cầu message có `level` field)

> Requires messages carrying a `level` field (the decoded bag reader maps
> `rosgraph_msgs/Log.level` bitmask → `debug|info|warn|error|fatal`).

#### LOG-01: log_fatal

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `log_fatal` |
| Severity | `critical` |
| Penalty | −50 |
| Threshold | `log_fatal_min_count = 1` |
| Điều kiện | `count(fatal) ≥ 1` |
| UI | 🔴 Red banner: "FATAL on /rosout" + LLM auto deep-dive |

**ROS2 Context:**
```
# Ví dụ log fatal từ Nav2
[FATAL] [nav2_controller]: Controller failed: obstacle detected in goal region
[FATAL] [nav2_planner]: Failed to compute path: no valid path found
```

#### LOG-02: log_error_burst (Continuous Detection)

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `log_error_burst` |
| Severity | `high` |
| Penalty | −30 |
| Threshold | `log_error_min_count = 3` |
| Điều kiện | `count(error) ≥ 3` trong **burst window** (liên tục) |
| UI | 🔴 Red band: "ERROR burst" |

**Continuous Detection Logic:**
```
# Burst detection = errors xảy ra trong window liên tiếp
# Window size: 5 seconds (configurable)
# Kích hoạt khi: errors.count >= log_error_min_count (3)
# Không kích hoạt nếu: errors spread > 5s apart (isolated errors)

Error detection pattern:
  ✗ t=1s: error    ← burst start
  ✗ t=2s: error    ← burst continues  
  ✗ t=3s: error    ← burst threshold reached → LOG-02 FIRE
  ✓ t=10s: error   ← outside burst window, ignored

Error isolation pattern (no detection):
  ✗ t=1s: error
  ✓ t=5s: error    ← gap > burst window, reset counter
  ✓ t=10s: error   ← isolated, no burst
```

#### LOG-03: log_warn_storm (Continuous Detection)

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `log_warn_storm` |
| Severity | `low` |
| Penalty | −5 |
| Threshold | `log_warn_min_count = 10` |
| Điều kiện | `count(warn) ≥ 10` trong window |
| UI | 🟡 Yellow band: "WARN storm" |

**Continuous Detection Logic:**
```
# Storm detection = warnings xảy ra với tần suất cao
# Window: 30 seconds (configurable)
# Kích hoạt khi: warns.count >= log_warn_min_count (10)
# Warning: Low severity nhưng có thể indicate underlying issue

Warn storm pattern:
  ⚠ t=1s-30s: 12 warnings logged
  → LOG-03 FIRE: "WARN storm detected"

# Storm có thể indicate:
# - Sensor noisy readings
# - Navigation instability  
# - Resource contention
```

---

### 2.2.2 Topic Frequency & Drop Rate (Nhóm FREQ)

> Hz tiers relative to `expected_hz` (passed by caller) hoặc peak window rate observed. Requires ≥ `hz_drop_min_messages` (50) để tránh flagging sparse streams. Windows: 5s.

#### FREQ-01: frequency_gap

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `frequency_gap` |
| Severity | `medium` |
| Penalty | −15 |
| Thresholds | `frequency_gap_min_threshold_sec = 0.08`, `frequency_gap_multiplier = 1.5` |
| Điều kiện | `max interval > max(0.08s, median × 1.5)` |
| UI | 🟡 Band on lane |

**Formula:**
```
gap_threshold = max(frequency_gap_min_threshold_sec, median_interval × frequency_gap_multiplier)
# Nghĩa là: gap phải lớn hơn 80ms HOẶC 1.5 lần median interval
```

#### FREQ-02: message_drop_burst

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `message_drop_burst` |
| Severity | `medium` |
| Penalty | −15 |
| Threshold | `max_gap_burst_sec = 1.0` |
| Điều kiện | `single interval > 1.0s` (absolute ceiling) |
| UI | 🟡 Band on lane |

#### FREQ-03: hz_drop (>30% Drop)

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `hz_drop` |
| Severity | `medium` |
| Penalty | −15 |
| Threshold | `hz_drop_warn_pct = 0.30` |
| Điều kiện | `window rate < expected × (1 − 0.30)` = `expected × 0.70` |
| Guard | `hz_drop_min_messages = 50` |
| UI | 🟡 Lane + "−X% Hz" badge |

**Ví dụ:**
```
Expected Hz: 20 Hz (cmd_vel)
Drop threshold: 20 × 0.70 = 14 Hz
→ FREQ-03 FIRE khi: actual rate < 14 Hz (tụt > 30%)
```

#### FREQ-04: hz_drop_critical (>50% Drop)

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `hz_drop_critical` |
| Severity | `high` |
| Penalty | −30 |
| Threshold | `hz_drop_critical_pct = 0.50` |
| Điều kiện | `window rate < expected × (1 − 0.50)` = `expected × 0.50` |
| Guard | `hz_drop_min_messages = 50` |
| UI | 🔴 Lane + "−X% Hz" badge |

#### FREQ-05: silent_node

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `silent_node` |
| Severity | `medium` (span < `silent_node_critical_sec`) / `critical` (span ≥) |
| Penalty | −15 / −50 |
| Threshold | `silent_node_min_span_sec = 0.3`, `silent_node_critical_sec = 20.0` |
| Điều kiện | `node active span ≥ 0.3s` without publishing |
| UI | ⚪ "Node silent" |

**Hiệu chỉnh theo GT thực tế:** đối chiếu 39 bag ground truth cho thấy severity gắn liền với **thời lượng**, không phải hằng số: mọi khoảng lặng ≤5.1s trong dataset đều GT `medium`, mọi khoảng ≥60s đều GT `critical` — khoảng cách 5.1–60s không có mẫu quan sát, `silent_node_critical_sec = 20.0` chọn ở giữa với biên độ an toàn lớn cả hai phía.

---

### 2.2.3 Timestamp Latency & Jitter (Nhóm LAT)

> `header_latency` requires a `header` (stamp) field; "sustained" = at least 3 lagging messages (`_HEADER_LATENCY_MIN_SUSTAINED`).

#### LAT-01: timestamp_jitter

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `timestamp_jitter` |
| Severity | `low` |
| Penalty | −5 |
| Threshold | `timestamp_jitter_max_sec = 0.02` |
| Điều kiện | `std-dev of intervals > 0.02s` |
| UI | ⚪ "Jitter" |

**ROS2 Context:**
```
# Timestamp jitter xảy ra khi:
# - Network congestion
# - Node processing delay  
# - Timer callback inconsistency
# 20ms = 2% of 1Hz, acceptable for most systems
# >20ms jitter = potential timing issues
```

#### LAT-02: clock_drift

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `clock_drift` |
| Severity | `step` → luôn `critical`. `ramp` → `critical` nếu tốc độ ≥ `clock_drift_ramp_critical_rate_ms_per_sec`, ngược lại `high` |
| Penalty | −30 (high) / −50 (critical) |
| Threshold | `clock_drift_max_sec = 0.1`, `clock_drift_min_count = 3`, `clock_drift_ramp_critical_rate_ms_per_sec = 40.0`, `clock_drift_min_span_sec = 0.5`, `clock_drift_max_rate_ms_per_sec = 500.0` |
| Điều kiện | Đợt liên tục `≥ clock_drift_min_count` message, kéo dài `≥ clock_drift_min_span_sec`, có `\|bag_timestamp − header.stamp\| > clock_drift_max_sec` — **ổn định** (std-dev `< clock_drift_max_sec`, kind `step`) hoặc **đường thẳng sạch** (residual sau khi fit `< clock_drift_max_sec`, kind `ramp`) |
| UI | 🟡/🔴 "Clock drift" |

**Sustained + stable/ramp, không phải median toàn topic.** Bản cũ lấy median trên **toàn bộ** message của topic — một lỗi chỉ chiếm một phần bag (VD 75s trong tổng 250s) bị pha loãng bởi phần khỏe mạnh, không bao giờ vượt ngưỡng. Bản hiện tại nhóm theo đợt liên tục vượt ngưỡng, rồi kiểm tra: một node restart/reset clock tạo ra độ lệch **gần như hằng số** (`step`); một sensor chạy clock riêng không đồng bộ tạo ra độ lệch **tăng dần tuyến tính** (`ramp`, fit `statistics.linear_regression`). Độ trễ mạng/xử lý thật **dao động** không theo mẫu nào, bị bỏ qua ở đây để `header_latency` xử lý; cửa sổ `clock_drift` đã báo bị loại khỏi `header_latency` để tránh gắn 2 nhãn mâu thuẫn.

**Severity theo kiểu lệch, không theo độ lớn.** Đối chiếu GT: `step` (`timestamp_backwards`/`timestamp_jump`) luôn `critical` dù offset nhỏ (quan sát thấp nhất −2.4s vẫn `critical`); `ramp` (`clock_drift` fault type) chỉ `critical` khi tốc độ đủ nhanh (≥40ms/s trong dataset), tốc độ chậm hơn giữ `high` dù chạy bao lâu.

**Tách episode tại điểm gãy khúc.** Hai lỗi clock khác nhau xảy ra liền kề không có khoảng nghỉ (offset không bao giờ tụt dưới ngưỡng giữa 2 lỗi) sẽ dính chung một episode theo logic gom nhóm — đường ramp bị gãy khúc bởi cú step ở giữa khiến fit thất bại cả 2 kiểu, mất tín hiệu hoàn toàn. `_split_at_change_points` phát hiện delta bất thường (vượt xa median delta cục bộ) giữa 2 message liên tiếp và tách episode tại đó trước khi phân loại.

**ROS2 Context:**
```
# Clock drift = system clock không sync (offset ổn định, ít dao động)
# Thường do:
# - Node restart, clock khởi tạo lại về mốc cũ (offset hằng số)
# - NTPD không chạy / Docker container clock drift / VM clock issues
# 100ms drift = nghiêm trọng cho real-time control
# ≥1.0s = critical: chữ ký rõ ràng của clock reset, không phải latency
```

#### LAT-03: header_latency (>100ms)

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `header_latency` |
| Severity | `medium` |
| Penalty | −15 |
| Threshold | `header_latency_max_ms = 100` |
| Điều kiện | `≥3 messages với publish_ts − header.stamp > 100ms` |
| Sustained | `≥3 messages` (sustained detection) |
| UI | 🟡 "Stale stamps" |

**Formula:**
```
latency_ms = (publish_timestamp - header.stamp) × 1000
# Kích hoạt khi: latency_ms > 100ms cho ≥3 messages liên tiếp
```

---

### 2.2.4 TF Tree Integrity (Nhóm TF)

> Operates on `/tf` + `/tf_static`. Canonical chain: `map → odom → base_link`

#### TF-01: tf_missing_gap

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `tf_missing_gap` |
| Severity | `high` |
| Penalty | −30 |
| Threshold | `tf_max_missing_span_sec = 0.5` |
| Điều kiện | `consecutive broadcast gap > 0.5s` **trên một edge cụ thể** |
| UI | 🔴 Node-edge turns red (Disconnected) |

**Per-edge, not per-topic:** gaps được nhóm theo `child_frame_id` (`base_footprint`, `odom`, `wheel_left_link`, ...), không phải theo timestamp gộp của cả topic `/tf`. Một edge chết (VD: broadcaster `odom→base_footprint` ngừng) sẽ **không** bị các edge khác trên cùng topic (VD: wheel joints) che khuất — trước đây, hệ thống chỉ nhìn `transforms[0]` của mỗi `/tf` message nên phần lớn edge bị bỏ sót; nay mọi edge trong một publish đều được nhóm đúng.

`/tf_static` bị loại khỏi phần "gap kéo dài tới cuối bag": static transform hợp lệ khi chỉ phát một lần duy nhất, nên không kiểm tra trailing-gap trên topic này (tránh báo dương tính giả trên mọi bag).

**ROS2 Context:**
```
# Missing TF gap = transform không được broadcast
# Ảnh hưởng:
# - Navigation không biết robot ở đâu
# - Costmap không update đúng
# - Planner không thể plan

Transform chain:
  map → odom: published by map_server/amcl
  odom → base_link: published by odometry node
  
# Gap > 0.5s = EMERGENCY cho navigation
```

#### TF-02: tf_drift_jump (Critical)

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `tf_drift_jump` |
| Severity | `critical` |
| Penalty | −50 |
| Threshold | `tf_jump_distance_m = 0.5` (reserved for geometry) |
| Điều kiện | `child frame re-parented` (VD: base_link switch parent odom → map) |
| UI | 🔴 Red edge + "Localization jump" |

**v1 Boundary Note:**
> `tf_drift_jump` currently detects frame *identity* switch (re-rooting / transform-graph change), NOT geometric `||ΔT||` jump. Threshold `tf_jump_distance_m` (0.5 m) reserved for transform-decode pass that reads `TransformStamped.transform.translation` — both signals should share same Rule ID/UI once geometry available.

**ROS2 Context:**
```
# Localization jump = robot "nhảy" vị trí đột ngột
# Thường do:
# - AMCL relocalization
# - GPS injection
# - Lidar registration failure

# Symptom:
# - base_link re-parented từ odom sang map
# - Robot "teleport" trên rviz
# - Safety issue cho autonomous operation
```

---

### 2.2.5 Data Bandwidth & Anomaly (Nhóm PLD)

> Requires `payload_bytes` (SQLite path reads `LENGTH(data)`; decoded path uses `len(rawdata)`).

#### PLD-01: payload_zero_byte

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `payload_zero_byte` |
| Severity | `high` |
| Penalty | −30 |
| Threshold | `payload_zero_byte_min_count = 5` |
| Điều kiện | `≥5 messages với payload_bytes == 0` |
| UI | 🔴 "PointCloud/Image → 0 B" on topic row |

**ROS2 Context:**
```
# Zero-byte payload = message incomplete/corrupted
# Common causes:
# - Network packet loss
# - Camera driver issue
# - PointCloud compression failure
# - DDS middleware issues

Typical message sizes:
  /scan: ~1-2 KB
  /image: ~50-500 KB (compressed)
  /pointcloud: ~50KB-2MB
  
# 0 bytes = definitely broken
```

#### PLD-02: payload_nan

| Thuộc tính | Giá trị |
|------------|---------|
| Detection Kind | `payload_nan` |
| Severity | `critical` |
| Penalty | −50 |
| Threshold | `payload_nan_ratio_min = 0.05`, `payload_nan_min_count = 5` |
| Điều kiện | `≥5 message liên tiếp` có tỉ lệ `NaN` trong mảng payload (VD: `LaserScan.ranges`) `> 5%` |
| UI | 🔴 "Sensor payload NaN" on topic row |

**Phạm vi:** áp dụng cho bất kỳ message có field `ranges` (không hard-code theo topic `/scan`). `nan_ratio` được tính rồi bỏ ngay mảng gốc trong `bag_stream.py` (`_nan_ratio`) — không giữ payload đầy đủ trong bộ nhớ. Chỉ đếm `NaN`, không đếm `+/-Inf`: theo `sensor_msgs/LaserScan`, `+/-Inf` là giá trị hợp lệ cho "quá xa/quá gần để đo", nên đếm Inf sẽ gây dương tính giả trên dữ liệu khỏe mạnh.

**ROS2 Context:**
```
# NaN trong ranges = sensor hoặc driver hỏng
# Common causes:
# - Photodiode/hàng cảm biến lỗi phần cứng
# - Driver serialize sai giá trị lỗi thành NaN thay vì Inf/0
# - Firmware corruption

# NaN không có ý nghĩa hợp lệ trong LaserScan — không giống Inf
# (Inf = "quá xa/gần để đo", là dữ liệu hợp lệ, không được đếm ở đây)
```

---

## 2.3 Config Reference (All Threshold Keys)

| Key | Default | Used by |
|-----|---------|---------|
| `frequency_gap_min_threshold_sec` | 0.08 | FREQ-01 |
| `frequency_gap_multiplier` | 1.5 | FREQ-01 |
| `frequency_gap_high_occurrence_min` | 10 | FREQ-01 severity |
| `max_gap_burst_sec` | 1.0 | FREQ-02 |
| `silent_node_min_span_sec` | 0.3 | FREQ-05 |
| `silent_node_critical_sec` | 20.0 | FREQ-05 severity |
| `hz_drop_warn_pct` | 0.30 | FREQ-03 |
| `hz_drop_critical_pct` | 0.50 | FREQ-04 |
| `hz_drop_min_messages` | 50 | FREQ-03/04 guard |
| `timestamp_jitter_max_sec` | 0.02 | LAT-01 |
| `clock_drift_max_sec` | 0.1 | LAT-02 |
| `clock_drift_min_count` | 3 | LAT-02 sustained guard |
| `clock_drift_min_span_sec` | 0.5 | LAT-02 guard (rejects burst-flush artifacts) |
| `clock_drift_max_rate_ms_per_sec` | 500.0 | LAT-02 guard (rejects numerically unstable ramp fits) |
| `clock_drift_ramp_critical_rate_ms_per_sec` | 40.0 | LAT-02 `ramp` severity |
| `header_latency_max_ms` | 100 | LAT-03 |
| `log_error_min_count` | 3 | LOG-02 |
| `log_warn_min_count` | 10 | LOG-03 |
| `log_fatal_min_count` | 1 | LOG-01 |
| `tf_max_missing_span_sec` | 0.5 | TF-01 |
| `tf_missing_gap_critical_sec` | 15.0 | TF-01 severity |
| `tf_jump_distance_m` | 0.5 | TF-02 (reserved) / TF-03 |
| `tf_conflict_window_sec` | 2.0 | TF-03 |
| `tf_conflict_min_jumps` | 3 | TF-03 |
| `payload_zero_byte_min_count` | 5 | PLD-01 |
| `payload_nan_ratio_min` | 0.05 | PLD-02 |
| `payload_nan_min_count` | 5 | PLD-02 |
| `payload_out_of_range_ratio_min` | 0.05 | PLD-03 |
| `payload_out_of_range_min_count` | 5 | PLD-03 |
| `pre_roll_grace_sec` | 8.0 | Toàn cục — bỏ mọi detection khởi phát trong N giây đầu kể từ tin nhắn đầu tiên của topic đó |

---

## 2.4 Severity → Penalty Summary

| Severity | Penalty | Count in HS | Example Rules |
|----------|---------|-------------|--------------|
| `critical` | −50 | 2 → HS=0 | LOG-01, TF-02, PLD-02, FREQ-05 (span lớn), TF-01 (gap lớn), LAT-02 (`step`/`ramp` nhanh) |
| `high` | −30 | 2 → HS=40 | LOG-02, FREQ-04, TF-01, TF-03, PLD-01, PLD-03, LAT-02 (`ramp` chậm) |
| `medium` | −15 | Multiple additive | FREQ-01/02/03, LAT-03, FREQ-05 (span nhỏ) |
| `low` | −5 | Multiple additive | LOG-03, LAT-01 |

---

## 2.5 Quick Decision Tree

```
Detection detected
       │
       ▼
┌─────────────────────────────────────┐
│  Is it LOG?                         │
│    ├─ fatal count ≥ 1? → LOG-01 🔴 │
│    ├─ error count ≥ 3? → LOG-02 🔴 │
│    └─ warn count ≥ 10? → LOG-03 🟡 │
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Is it FREQ?                        │
│    ├─ interval > 1.0s? → FREQ-02 🟡 │
│    ├─ rate < 50% expected? → FREQ-04🔴│
│    ├─ rate < 70% expected? → FREQ-03🟡│
│    ├─ max gap > 1.5× median? → FREQ-01🟡│
│    └─ silent span > 0.3s? → FREQ-05 ⚪│
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Is it LAT?                         │
│    ├─ header lag > 100ms×3? → LAT-03🟡│
│    ├─ |bag-header| > 0.1s? → LAT-02 🟡│
│    └─ jitter std-dev > 20ms? → LAT-01⚪│
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Is it TF?                          │
│    ├─ gap > 0.5s? → TF-01 🔴      │
│    └─ re-parented? → TF-02 🔴     │
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Is it PLD?                         │
│    └─ zero-byte count ≥ 5? → PLD-01 🔴│
└─────────────────────────────────────┘
```
