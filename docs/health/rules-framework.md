# Khung Quy tắc Kiểm tra Sức khỏe Rosbag

## (Rosbag Health Check Framework)

**Maintainer Guide / Tổng hợp Kiến trúc** cho RAV-13 **Dashboard Đánh giá Sức khỏe Rosbag**
-(non-timing extensions to the existing `diagnostics.py` rule engine).

---

## Mục lục (Table of Contents)

| Phần | Chủ đề | File |
|------|--------|------|
| [Phần 1](#phần-1) | Health Score Algorithm, Weights, Color Zones | [`health-score.md`](health-score.md) |
| [Phần 2](#phần-2) | Heuristic Rules Matrix (Rule ID / Condition / Penalty / UI) | [`heuristic-rules-matrix.md`](heuristic-rules-matrix.md) |
| [Phần 3](#phần-3) | Dashboard UI/UX Component Specification | [`dashboard-ui.md`](dashboard-ui.md) |
| [Phần 4](#phần-4) | LLM Interaction Protocol & MCP/Context Contract | [`llm-protocol.md`](llm-protocol.md) |

---

## Mục đích (Purpose)

Cung cấp cho Junior Engineer (và LLM "bác sĩ") một con số có thể nhìn一眼 trong 1-2 giây — **Health Score (HS, 0–100)** — cùng với timeline mã màu và phân tích chi tiết theo topic/TF, để chẩn đoán sự cố **AGV / AMR** trong vài giây:

- **Which** signal group failed
- **When** it happened
- **Why** (grounded in evidence)

---

## Phạm vi Engine (Scope)

Engine chạy trong `src/services/diagnostics.py`, consume lazy message stream (không materialize bag), và trả về compact detection JSON. Health Score được tính bởi `src/services/health.py` từ detections thành **Health Summary JSON** — consumed bởi dashboard và LLM.

---

## Data Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  rosbag2/.db3 hoặc MCAP/JSONL                                                │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  bag_stream.iter_bag_messages
                                │  (timestamps, header.stamp,
                                │   frame_id/child_frame_id,
                                │   level, payload_bytes)
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  detect_anomalies(...)  ──►  detections[]                                    │
│  (timing + 5 rule groups: log, frequency, latency, tf, payload)            │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  compute_health_summary(detections)  ──►  Health Summary JSON (0-100 HS)     │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼                               ▼
        /health endpoint              /deep-dive endpoint
        (Dashboard render)              (trigger_llm_deep_dive)
                │                               │
                └───────────────┬───────────────┘
                                ▼
                    build_deep_dive_prompt() → LLM
```

### Database Index Notes (for SQLite)

```
db3 upload: save_uploaded_rosbag → _ensure_timestamp_index()
  → CREATE INDEX idx_messages_topic_time ON messages(topic_id, timestamp)
  → CREATE INDEX idx_messages_time ON messages(timestamp)
  (best-effort; failure logs experiments.index_skip and does not block upload)
```

---

## 5 Nhóm Chỉ số Cốt lõi (Core Indicator Groups)

| Nhóm | Mô tả | Weight |
|------|-------|--------|
| **Frequency** | Control-loop liveness (cmd_vel, odom, scan) | 0.30 |
| **TF** | Localization chain `map → odom → base_link` | 0.25 |
| **Log** | ERROR/FATAL từ `/rosout`, `/diagnostics` | 0.20 |
| **Latency** | Header/publish skew (sensor-controller staleness) | 0.15 |
| **Payload** | Bandwidth/size anomalies | 0.10 |

---

## Detection Kinds

| Nhóm | Kind IDs | Severity |
|------|----------|----------|
| Log | `log_fatal` / `log_error_burst` / `log_warn_storm` | critical / high / low |
| Frequency | `frequency_gap` / `message_drop_burst` / `silent_node` / `hz_drop` / `hz_drop_critical` | medium / medium / low / medium / high |
| Latency | `timestamp_jitter` / `clock_drift` / `header_latency` | low / medium / medium |
| TF | `tf_missing_gap` / `tf_drift_jump` | high / critical |
| Payload | `payload_zero_byte` | high |

---

## Review Status

| Component | Status | Notes |
|-----------|--------|-------|
| Code Implementation | ✅ Done | `src/services/diagnostics.py`, `health.py` |
| Unit Tests | ✅ Done | `tests/test_services/test_health.py`, `test_diagnostics.py` |
| Frontend Spec | ✅ Done | Demo frontend sử dụng mock store |
| LLM Protocol | ✅ Done | Data-only prompts, prompt-injection guardrail |

---

## Lưu ý quan trọng (v1 Boundary)

> **TF-02 Note.** Missing-transform detector trong v1 flag:
> - **Broadcast gap** (`tf_missing_gap`)
> - **Frame re-parenting / localization re-root jump** (`tf_drift_jump`)
>
> Full geometric `tf jump > distance` cần transform (translation) decoding — threshold `tf_jump_distance_m` reserved cho decode pass sau.

---

## Quick Reference Card

| Term | Định nghĩa |
|------|------------|
| HS (Health Score) | Composite 0-100, green ≥80, yellow 60-79, red <60 |
| HS < 70 | Auto-trigger LLM deep-dive |
| Detection | Một anomaly được phát hiện bởi rule engine |
| Severity | critical=-50, high=-30, medium=-15, low=-5 |
| Sub-score | Per-group score (0-100) trước khi weighted sum |
