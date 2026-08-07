# PHẦN 1: MÔ HÌNH TÍNH ĐIỂM SỨC KHỎE TỔNG PHÁT

## (Health Score Algorithm)

**Source:** `src/services/health.py`

Tạo ra một composite score **0–100** từ 5 core indicator groups, phục vụ chẩn đoán sự cố AGV/AMR.

---

## 1.1 Công thức Tổng quát (Composite Formula)

```
HS = Σ (w_i × S_i)      với i ∈ { log, frequency, latency, tf, payload }

S_i ∈ [0, 100]          per-group sub-score (bắt đầu từ 100, trừ penalty per detection)
Σ w_i = 1.0
HS ∈ [0, 100]           clamped
```

**Ý nghĩa:**
- `HS` = Health Score tổng (0 = failure hoàn toàn, 100 = hoàn toàn healthy)
- `w_i` = Trọng số (weight) của nhóm i
- `S_i` = Sub-score của nhóm i (bắt đầu 100, trừ penalties)

---

## 1.2 Bảng Trọng số (Weights Table)

| Nhóm | Weight (w_i) | ROS2 Context |
|------|--------------|--------------|
| `frequency` | **0.30** | Control-loop liveness: cmd_vel, odom, scan — drives AGV safety |
| `tf` | **0.25** | Localization chain: `map → odom → base_link` — break = no pose |
| `log` | **0.20** | Explicit ERROR/FATAL từ `/rosout`, `/diagnostics` |
| `latency` | **0.15** | Header/publish skew = sensor–controller staleness |
| `payload` | **0.10** | Bandwidth/size anomalies (VD: PointCloud → 0 bytes) |

> **Lưu ý:** Weights sum to `1.0` (asserted by test). Boundary ưu tiên TF + frequency vì với Mobile Robot, *mất transform hoặc control stream là emergency*.

---

## 1.3 Mô hình Sub-score & Severity Penalties

Mỗi nhóm bắt đầu tại `100.0` và bị trừ theo severity của từng detection mapped vào nó, floor tại `0.0`:

| Severity | Per-detection Penalty | ROS2 Example |
|----------|---------------------|-------------|
| `critical` | **−50.0** | `log_fatal`, `tf_drift_jump` |
| `high` | **−30.0** | `log_error_burst`, `hz_drop_critical`, `tf_missing_gap`, `payload_zero_byte` |
| `medium` | **−15.0** | `frequency_gap`, `message_drop_burst`, `hz_drop`, `clock_drift`, `header_latency` |
| `low` | **−5.0** | `log_warn_storm`, `silent_node`, `timestamp_jitter` |

**Ví dụ:**
- 2 detection `tf` critical → `S_tf = 100 − 50 − 50 = 0`
- 1 detection `log` high + 1 detection `frequency` medium → `S_log = 70`, `S_frequency = 85`

---

## 1.4 Phân vùng Màu (Color Zones / Thresholds)

```
┌─────────────────────────────────────────────────────────────┐
│  🔴 RED ZONE    │  🟡 YELLOW ZONE  │  🟢 GREEN ZONE       │
│   HS < 60       │   60 ≤ HS < 80   │   HS ≥ 80            │
└─────────────────────────────────────────────────────────────┘
```

| Zone | Màu | Range | Meaning |
|------|-----|-------|---------|
| GREEN | 🟢 | `HS ≥ 80` | Healthy, no action |
| YELLOW | 🟡 | `60 ≤ HS < 80` | Degraded, monitor |
| RED | 🔴 | `HS < 60` | Incident, deep-dive required |

### LLM Deep-Dive Trigger

Trigger riêng biệt cho LLM deep-dive fires sớm hơn, tại `HS < 70`:

| HS | Zone | LLM Deep-dive |
|----|------|---------------|
| 85 | 🟢 green | No |
| 75 | 🟡 yellow | **Yes (auto)** |
| 55 | 🔴 red | Yes (auto) + user click |
| 40 | 🔴 red | Yes (auto) + priority alert |

---

## 1.5 Group Mapping (Detection Kind → Group)

```
┌──────────────────────────────────────────────────────────────────┐
│                    GROUP_BY_KIND Mapping                        │
├──────────────────────────────────────────────────────────────────┤
│  log:        log_fatal, log_error_burst, log_warn_storm        │
│  frequency:  frequency_gap, message_drop_burst, hz_drop,        │
│              hz_drop_critical, silent_node                     │
│  latency:    timestamp_jitter, clock_drift, header_latency      │
│  tf:         tf_missing_gap, tf_drift_jump                      │
│  payload:    payload_zero_byte                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 1.6 Output — Health Summary JSON

```json
{
  "health_score": 65.0,
  "status": "yellow",
  "status_zones": {
    "green_min": 80,
    "yellow_min": 60,
    "red_max": 60
  },
  "trigger_llm_deep_dive": true,
  "summary": {
    "total_messages": 12000,
    "total_detections": 3,
    "worst_severity": "critical",
    "groups": {
      "frequency": {
        "score": 100.0,
        "weight": 0.30,
        "detection_count": 0
      },
      "tf": {
        "score": 0.0,
        "weight": 0.25,
        "detection_count": 2
      },
      "log": {
        "score": 50.0,
        "weight": 0.20,
        "detection_count": 1
      },
      "latency": {
        "score": 100.0,
        "weight": 0.15,
        "detection_count": 0
      },
      "payload": {
        "score": 100.0,
        "weight": 0.10,
        "detection_count": 0
      }
    }
  },
  "detections_by_group": {
    "tf": [
      {
        "kind": "tf_drift_jump",
        "topic": "/tf",
        "frame_id": "odom",
        "child_frame_id": "base_link",
        "severity": "critical",
        "timestamp": "2024-01-15T10:23:45.123Z",
        "evidence": {
          "previous_parent": "odom",
          "new_parent": "map",
          "jump_detected_at": "t=13.2s"
        }
      }
    ]
  }
}
```

---

## 1.7 ROS2 Terminology Quick Reference

| Term | ROS2 Definition |
|------|-----------------|
| `map → odom → base_link` | Localization transform chain trong Nav2 |
| `/cmd_vel` | Command velocity topic — control input cho robot |
| `/odom` | Odometry topic — estimated position |
| `/scan` | Laser scan topic từ LiDAR sensor |
| `/tf` | Transform broadcaster — coordinate frames |
| `/tf_static` | Static transforms (VD: sensor mounting) |
| `/rosout` | ROS logging topic |
| `header.stamp` | Message timestamp từ sensor/controller |
| `publish_ts` | Timestamp khi message được publish |

---

## 1.8 Implementation Reference

**Source:** `src/services/health.py`

**Key Functions:**
- `_subscore(severities)` — tính sub-score từ penalties
- `_color_zone(score)` — trả về "green", "yellow", hoặc "red"
- `compute_health_summary(detections, total_messages)` — main entry point
- `build_deep_dive_prompt(health)` — render context prompt cho LLM

**Config:**
- `GREEN_THRESHOLD`: 80.0
- `YELLOW_THRESHOLD`: 60.0
- `DEEP_DIVE_TRIGGER_THRESHOLD`: 70.0
