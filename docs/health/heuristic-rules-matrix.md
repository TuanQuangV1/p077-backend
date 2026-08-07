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
| **FREQ** | `FREQ-01` | `frequency_gap` | `max interval > max(0.08s, median × 1.5)` | −15 (medium) | 🟡 Band on lane |
| **FREQ** | `FREQ-02` | `message_drop_burst` | `single interval > 1.0s` | −15 (medium) | 🟡 Band on lane |
| **FREQ** | `FREQ-03` | `hz_drop` | `window rate < expected × 0.70` (drop > 30%) | −15 (medium) | 🟡 Lane + "−X% Hz" badge |
| **FREQ** | `FREQ-04` | `hz_drop_critical` | `window rate < expected × 0.50` (drop > 50%) | −30 (high) | 🔴 Lane + "−X% Hz" badge |
| **FREQ** | `FREQ-05` | `silent_node` | `node active span ≥ 0.3s` | −5 (low) | ⚪ "Node silent" |
| **LAT** | `LAT-01` | `timestamp_jitter` | `std-dev intervals > 0.02s` | −5 (low) | ⚪ "Jitter" |
| **LAT** | `LAT-02` | `clock_drift` | `median |bag − header| > 0.1s` | −15 (medium) | 🟡 "Clock drift" |
| **LAT** | `LAT-03` | `header_latency` | `≥3 messages với lag > 100ms` | −15 (medium) | 🟡 "Stale stamps" |
| **TF** | `TF-01` | `tf_missing_gap` | `consecutive gap > 0.5s` | −30 (high) | 🔴 Edge turns red (Disconnected) |
| **TF** | `TF-02` | `tf_drift_jump` | `child frame re-parented` (VD: odom → map) | −50 (critical) | 🔴 "Localization jump" |
| **PLD** | `PLD-01` | `payload_zero_byte` | `≥5 messages với payload_bytes == 0` | −30 (high) | 🔴 "PointCloud → 0 B" |

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
| Severity | `low` |
| Penalty | −5 |
| Threshold | `silent_node_min_span_sec = 0.3` |
| Điều kiện | `node active span ≥ 0.3s` without publishing |
| UI | ⚪ "Node silent" |

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
| Severity | `medium` |
| Penalty | −15 |
| Threshold | `clock_drift_max_sec = 0.1` |
| Điều kiện | `median |bag_timestamp − header.stamp| > 0.1s` |
| UI | 🟡 "Clock drift" |

**ROS2 Context:**
```
# Clock drift = system clock không sync
# Thường do:
# - NTPD không chạy
# - Docker container clock drift
# - VM clock issues
# 100ms drift = nghiêm trọng cho real-time control
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
| Điều kiện | `consecutive /tf broadcast gap > 0.5s` |
| UI | 🔴 Node-edge turns red (Disconnected) |

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

---

## 2.3 Config Reference (All Threshold Keys)

| Key | Default | Used by |
|-----|---------|---------|
| `frequency_gap_min_threshold_sec` | 0.08 | FREQ-01 |
| `frequency_gap_multiplier` | 1.5 | FREQ-01 |
| `max_gap_burst_sec` | 1.0 | FREQ-02 |
| `silent_node_min_span_sec` | 0.3 | FREQ-05 |
| `hz_drop_warn_pct` | 0.30 | FREQ-03 |
| `hz_drop_critical_pct` | 0.50 | FREQ-04 |
| `hz_drop_min_messages` | 50 | FREQ-03/04 guard |
| `timestamp_jitter_max_sec` | 0.02 | LAT-01 |
| `clock_drift_max_sec` | 0.1 | LAT-02 |
| `header_latency_max_ms` | 100 | LAT-03 |
| `log_error_min_count` | 3 | LOG-02 |
| `log_warn_min_count` | 10 | LOG-03 |
| `log_fatal_min_count` | 1 | LOG-01 |
| `tf_max_missing_span_sec` | 0.5 | TF-01 |
| `tf_jump_distance_m` | 0.5 | TF-02 (reserved) |
| `payload_zero_byte_min_count` | 5 | PLD-01 |

---

## 2.4 Severity → Penalty Summary

| Severity | Penalty | Count in HS | Example Rules |
|----------|---------|-------------|--------------|
| `critical` | −50 | 2 → HS=0 | LOG-01, TF-02 |
| `high` | −30 | 2 → HS=40 | LOG-02, FREQ-04, TF-01, PLD-01 |
| `medium` | −15 | Multiple additive | FREQ-01/02/03, LAT-02/03 |
| `low` | −5 | Multiple additive | LOG-03, FREQ-05, LAT-01 |

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
