# Rosbag Health Check Framework - Index

## Tổng quan

Bộ tài liệu **Dashboard Đánh giá Sức khỏe Rosbag** cho RAV-13, phục vụ chẩn đoán sự cố Mobile Robot (AGV/AMR).

**Mục tiêu:** Cho Junior Engineer nhìn vào 1-2 giây biết được:
- **Which** signal group failed
- **When** it happened
- **Why** (với LLM assistance)

---

## Cấu trúc Tài liệu (4 Phần)

| Phần | File | Mô tả |
|------|------|--------|
| **Tổng quan** | [`rules-framework.md`](rules-framework.md) | Master document - data flow, detection kinds, quick reference |
| **Phần 1** | [`health-score.md`](health-score.md) | Health Score Algorithm, Weights, Color Zones |
| **Phần 2** | [`heuristic-rules-matrix.md`](heuristic-rules-matrix.md) | 15 Rules chi tiết (LOG, FREQ, LAT, TF, PLD) |
| **Phần 3** | [`dashboard-ui.md`](dashboard-ui.md) | 8-panel Dashboard UI/UX specification |
| **Phần 4** | [`llm-protocol.md`](llm-protocol.md) | LLM Integration, Triggers, Context Prompts |

---

## Quick Start

### 1. Đọc Health Score
```
src/services/health.py → compute_health_summary(detections)
→ Health Summary JSON (HS = 0-100)
```

### 2. Hiểu Detections
```
src/services/diagnostics.py → detect_anomalies(bag_stream)
→ detections[] (15 rule types)
```

### 3. Xem Dashboard
```
frontend/app/rav-console.tsx
→ GET /api/v1/analysis/{run_id}/health
```

### 4. Hỏi LLM
```
frontend → [Deep-dive] button
→ build_deep_dive_prompt(health)
→ llm.explain_diagnostics()
```

---

## Health Score Quick Reference

```
HS = Σ (w_i × S_i)  với i ∈ { log, frequency, latency, tf, payload }
```

| Zone | Range | Action |
|------|-------|--------|
| 🟢 GREEN | `HS ≥ 80` | No action needed |
| 🟡 YELLOW | `60 ≤ HS < 80` | Monitor + LLM auto deep-dive |
| 🔴 RED | `HS < 60` | Incident + priority LLM deep-dive |

**Weights:**
| Group | Weight | ROS2 Context |
|-------|--------|--------------|
| frequency | 0.30 | cmd_vel, odom, scan liveness |
| tf | 0.25 | map → odom → base_link |
| log | 0.20 | ERROR/FATAL from /rosout |
| latency | 0.15 | Header/publish skew |
| payload | 0.10 | Bandwidth anomalies |

---

## Rules Matrix Quick Reference

| ID | Detection | Severity | Penalty |
|----|-----------|----------|---------|
| LOG-01 | `log_fatal` | critical | −50 |
| LOG-02 | `log_error_burst` | high | −30 |
| LOG-03 | `log_warn_storm` | low | −5 |
| FREQ-01 | `frequency_gap` | medium | −15 |
| FREQ-02 | `message_drop_burst` | medium | −15 |
| FREQ-03 | `hz_drop` (>30%) | medium | −15 |
| FREQ-04 | `hz_drop_critical` (>50%) | high | −30 |
| FREQ-05 | `silent_node` | low | −5 |
| LAT-01 | `timestamp_jitter` | low | −5 |
| LAT-02 | `clock_drift` | medium | −15 |
| LAT-03 | `header_latency` (>100ms) | medium | −15 |
| TF-01 | `tf_missing_gap` | high | −30 |
| TF-02 | `tf_drift_jump` | critical | −50 |
| PLD-01 | `payload_zero_byte` | high | −30 |

---

## LLM Trigger Conditions

| Condition | Type | Action |
|-----------|------|--------|
| `HS < 70` | Auto | Explain degradation |
| `HS < 60` | Auto | Priority incident |
| `HS < 40` | Auto | Critical alert |
| User clicks detection | Manual | Explain anomaly |
| User clicks `[Ask LLM]` | Manual | Context question |

---

## Implementation Files

| File | Purpose |
|------|---------|
| `src/services/health.py` | Health Score calculation |
| `src/services/diagnostics.py` | Rule-based anomaly detection |
| `src/services/diagnostics_config.py` | Threshold configuration |
| `src/services/llm.py` | LLM integration |
| `tests/test_services/test_health.py` | Health score tests |
| `tests/test_services/test_diagnostics.py` | Detection tests |

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/analysis/{run_id}/health` | GET | Health Summary JSON |
| `/api/v1/analysis/{run_id}/deep-dive` | GET | LLM explanation |
| `/api/v1/analysis/thresholds` | POST | Override thresholds |

---

## Color System

| Color | Hex | Usage |
|-------|-----|-------|
| 🟢 Green | `#28a745` | Healthy, OK |
| 🟡 Yellow | `#ffc107` | Warning, Monitor |
| 🔴 Red | `#dc3545` | Critical, Incident |
| ⚪ Grey | `#6c757d` | Silent, Jitter |
| 🟠 Orange | `#fd7e14` | High severity |

---

## Safety Rules

> 1. **Never send raw rosbag content** to LLM
> 2. **Never send user comments** to LLM
> 3. **Always append guardrail** to prompts
> 4. **HS is ground truth** — LLM is supplement only
