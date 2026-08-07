# PHẦN 3: THIẾT KẾ GIAO DIỆN DASHBOARD

## (Dashboard UI/UX Specification)

Reference spec cho **Rosbag Health Check Dashboard** screen. Demo frontend (`frontend/app/rav-console.tsx`) drive mock data via in-memory store; các sections này specify *intended* live behavior để wiring pass kết nối với real `GET /api/v1/analysis/{run_id}/health` response.

---

## 3.1 Layout Tổng quan (8-Panel Grid)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  HEADER: [← Back] [Bag: rosbag_A] [Run: run_a]    ● HS=72    [Export] [Share]     │
├─────────────────────────────┬─────────────────────────────────────────────────────┤
│                             │                                                      │
│   3.2 HEALTH GAUGE          │   3.4 LOG SYSTEM SEVERITY                          │
│   HS = 72 / 🟡 Yellow       │   ERROR 2 · WARN 8 · FATAL 0  [View Logs]         │
│   (0-100 radial gauge)      │   🔴 Red band if errors, 🟡 Yellow if warns         │
│                             │                                                      │
├─────────────────────────────┼─────────────────────────────────────────────────────┤
│                             │                                                      │
│   3.3 TF TREE STATUS       │   3.5 TOPIC FREQUENCY & DROP                       │
│   (Node-Edge graph)        │   (Rate lanes chart)                               │
│   map → odom → base_link   │   Hz badges + −X% Hz indicators                    │
│   🔴 Red = Disconnected    │   ⚪ Grey = Silent node                             │
│                             │                                                      │
├─────────────────────────────┴─────────────────────────────────────────────────────┤
│                                                                                   │
│   3.6 LATENCY & JITTER                    │   3.7 DATA BANDWIDTH & ANOMALY       │
│   (Toggle: header latency/jitter/drift)   │   (Doughnut + topic bubble cards)    │
│   🟡 Red dots for >100ms sustained        │   🔴 Red row = zero-byte topic        │
│                                                                                   │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│   3.8 TIMELINE DENSITY HEATMAP & DETECTION TIMELINE                               │
│   [━━━━━━━━━━●━━━━━━━●━━●━━━━━━━━━━━●━━━━━━━━━━●━━━━━━━]                         │
│   Red/Yellow/Grey bands for incident markers                                       │
│                                                                                   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Design Principles:**
- Colour từ Health Score zone (`green/yellow/red`, Phần 1.4) là **first thing** user đọc
- 1-2 seconds glance = immediate situational awareness
- Progressive disclosure: click để expand details

---

## 3.2 Header KPI Cards (4 metrics)

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│   HS SCORE   │    WORST     │   TOPIC     │  DURATION   │
│              │   SEVERITY   │  DROP MAX   │   (HH:MM)   │
│     72       │   critical   │    -45%     │   05:32     │
│    🟡 YEL   │     🔴       │   /cmd_vel  │  12,450 msg │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

| KPI | Mô tả | Color Logic |
|-----|-------|-------------|
| **HS Score** | Health Score 0-100 | 🟢≥80, 🟡60-79, 🔴<60 |
| **Worst Severity** | Severity cao nhất detected | 🔴 critical, 🟠 high, 🟡 medium, ⚪ low |
| **Topic Drop Max** | % Hz drop lớn nhất + topic | 🔴 >50%, 🟡 30-50%, ⚪ <30% |
| **Duration** | Bag duration + message count | Static |

---

## 3.3 Timeline Density Heatmap (Biểu đồ Mật độ Lỗi)

### 3.3.1 Concept

Heatmap hiển thị **mật độ detection** theo thời gian, giúp user nhanh chóng xác định:
- **Khi nào** vấn đề xảy ra
- **Nghiêm trọng như thế nào** (màu đậm = nhiều lỗi)
- **Loại vấn đề** (hover để xem chi tiết)

### 3.3.2 Visual Design

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  TIMELINE DENSITY HEATMAP                                [Zoom -] [Reset] [Export]│
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  Bag Duration: 0s ──────────────────────────── 332s ──────────────────── 450s   │
│                                                                                     │
│  Heat    │                                                                      │
│  Level   │  ░░░░░░░░░░░░░░▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│    100%  │  ░░░░░░░░░░░░░░██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│          │                                                                      │
│   50%   │  ░░░░░░░░░░░░░░████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│          │                                                                      │
│    0%   │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│          │                                                                      │
│  Legend: ░ None  ▒ Low  ▓ Medium  █ High  ▓▓ Critical incident band            │
│                                                                                   │
│  Detections:                                                                         │
│  🔴 t=45s: TF-02 tf_drift_jump (critical)                                        │
│  🟡 t=120s: FREQ-03 hz_drop -45% on /cmd_vel                                      │
│  🟠 t=125s: LOG-02 log_error_burst (3 errors)                                    │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3.3 Implementation

```
# Heatmap data structure
heatmap_buckets = [
  { "start": 0, "end": 10, "density": 0, "severity": "none" },
  { "start": 10, "end": 20, "density": 3, "severity": "low" },
  { "start": 40, "end": 50, "density": 15, "severity": "critical" },
  # ... per 10-second bucket
]

# Color mapping
severity_colors = {
  "none": "#e0e0e0",     # Grey
  "low": "#fff3cd",      # Light yellow
  "medium": "#ffc107",   # Yellow
  "high": "#fd7e14",     # Orange
  "critical": "#dc3545"  # Red
}
```

### 3.3.4 Interaction

| Action | Behavior |
|--------|----------|
| Click bucket | Zoom to that time range |
| Hover bucket | Tooltip: "t=45-55s: 5 detections, worst: critical" |
| Click detection marker | Jump to rule panel + show evidence |
| Brush selection | Select time range for focused analysis |

---

## 3.4 TF Tree Status Graph (Node-Edge Widget)

### 3.4.1 Concept

Force-directed graph hiển thị TF chain `map → odom → base_link`:
- **Green edges** = healthy, connected
- **Red edges** = disconnected / missing transform
- **Red nodes** = anomaly detected (VD: localization jump)

### 3.4.2 Visual Design

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  TF TREE STATUS                               [Refresh] [Full Screen] [?]          │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│                            ┌─────────┐                                              │
│                            │   map   │                                              │
│                            │ (root)  │                                              │
│                            └────┬────┘                                              │
│                                 │ 🔴 RED (disconnected 0.8s gap at t=45s)          │
│                                 │                                                   │
│                                 ▼                                                   │
│                            ┌─────────┐                                              │
│                            │  odom   │                                              │
│                            └────┬────┘                                              │
│                                 │ 🔴 RED (re-parented to map at t=45.2s)           │
│                                 │                                                   │
│                                 ▼                                                   │
│                            ┌─────────┐                                              │
│                            │base_link│ (🚨 ANOMALY)                                │
│                            └─────────┘                                              │
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │ ANOMALY DETAILS                                                              │   │
│  │ Rule: TF-02 tf_drift_jump (critical)                                        │   │
│  │ At: t=45.2s                                                                 │   │
│  │ Previous parent: odom                                                        │   │
│  │ New parent: map                                                             │   │
│  │ Impact: Localization re-root detected                                       │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.4.3 Node States

| State | Visual | Meaning |
|-------|--------|---------|
| Healthy | 🟢 Green | Transform connected, no anomaly |
| Gap | 🔴 Red edge | Missing transform > 0.5s |
| Jump | 🔴 Red node | Localization re-root detected |
| Silent | ⚪ Grey | Node stopped publishing |

---

## 3.5 Topic Health Table (Danh sách Topic)

### 3.5.1 Concept

Bảng danh sách tất cả topics với:
- **Current Hz** vs **Expected Hz**
- **Drop Rate %**
- **Status badge** (color-coded)
- **Filter buttons** để isolate groups

### 3.5.2 Visual Design

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  TOPIC HEALTH TABLE                                    [Filter ▼] [Sort ▼] [Export] │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  [All] [Critical] [Warning] [Healthy] [Silent]                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  Topic             │ Expected │ Actual │ Drop%  │ Status │ Last Msg │ Anomalies │
│────────────────────┼──────────┼────────┼────────┼────────┼──────────┼───────────│
│  🔴 /cmd_vel       │  20 Hz   │  11 Hz │ -45%   │ CRIT   │  2.3s    │ FREQ-04   │
│  🟡 /scan          │  10 Hz   │   8 Hz │ -20%   │ WARN   │  0.5s    │ FREQ-03   │
│  🟢 /odom          │  50 Hz   │  49 Hz │  -2%   │ OK     │  0.1s    │ -         │
│  🟢 /tf            │ 100 Hz   │ 100 Hz │   0%   │ OK     │  0.0s    │ -         │
│  ⚪ /image/comprsd  │  15 Hz   │   0 Hz │-100%   │ SILENT │  45.2s   │ FREQ-05   │
│  🟢 /pointcloud    │   5 Hz   │   5 Hz │   0%   │ OK     │  0.2s    │ -         │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  Summary: 6 topics | 1 Critical | 1 Warning | 3 Healthy | 1 Silent               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.5.3 Filter Buttons

| Filter | Shows | Color |
|--------|-------|-------|
| **All** | Tất cả topics | Default |
| **Critical** | Drop > 50% hoặc zero payload | 🔴 Red |
| **Warning** | Drop 30-50% hoặc errors | 🟡 Yellow |
| **Healthy** | Normal operation | 🟢 Green |
| **Silent** | Silent nodes (FREQ-05) | ⚪ Grey |

### 3.5.4 Row Details (Expandable)

```
🔴 /cmd_vel ──────────────────────────────────────────────────────────────────────
│  Expected Hz: 20 Hz          Actual Hz: 11 Hz (-45%)
│  ─────────────────────────────────────────────────────────────────────────────
│  DETECTIONS:
│  ├─ [t=45s] FREQ-04 hz_drop_critical: rate dropped 55% below expected
│  └─ [t=120s] FREQ-03 hz_drop: sustained drop 30-50%
│  ─────────────────────────────────────────────────────────────────────────────
│  Hz Over Time:
│  0s──────50s──────100s──────150s──────200s
│  ████████████████████████░░░░░░░░░░░░░  ← Drop at t=45s
│  ─────────────────────────────────────────────────────────────────────────────
│  [Ask LLM] [View Raw Messages] [Export]
```

---

## 3.6 Log System Severity Panel

### 3.6.1 Stat Cards

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  LOG SYSTEM SEVERITY                                                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                                        │
│  │  FATAL  │    │  ERROR  │    │  WARN   │                                        │
│  │    0    │    │    3    │    │   12    │                                        │
│  │  (🟢 OK)│    │ (🔴 1) │    │ (🟡 1) │                                        │
│  └─────────┘    └─────────┘    └─────────┘                                        │
│                                                                                     │
│  Latest ERROR: [t=125.3s] "Controller failed: obstacle in goal region"              │
│  Latest WARN:  [t=98.7s]  "Costmap cell (45,32) has high cost: 245"                │
│                                                                                     │
│  [View All Logs]                                                                  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.6.2 Log Banner States

| Type | Banner | Content |
|------|--------|---------|
| `log_fatal` | 🔴 Red banner | "FATAL x · `<sample message>` · at t=12s" |
| `log_error_burst` | 🔴 Red band | Burst window start–end ± count |
| `log_warn_storm` | 🟡 Yellow badge | "WARN storm: X warnings in Ys" |

---

## 3.7 Latency & Jitter Panel (Toggle)

### 3.7.1 Chart Design

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  LATENCY & JITTER                                    [Header Latency] [Jitter] [Clock]│
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  Header Latency (header.stamp vs publish time)                                      │
│  ms │                                                                        ▲   │
│ 150 ┤───────────────────────────────────────────────────────────────────────── █   │
│     │                                                                █             │
│ 100 ┤──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄──▄▄─ │
│  50 ┤  █   █   █   █   █   █   █   █   █   █   █   █   █   █   █   █   █   █  │
│   0 ┼───────────────────────────────────────────────────────────────────────────  │
│     0s      50s      100s     150s     200s     250s     300s     350s     400s  │
│                                                                                     │
│  ⚠ Threshold: 100ms ──────────────────────────────────────────────────────────    │
│  🔴 Sustained lag detected at t=234-267s (3+ messages > 100ms)                     │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.7.2 Toggle States

| Mode | Shows | Threshold |
|------|-------|-----------|
| **Header Latency** | `publish_ts − header.stamp` | 100ms |
| **Jitter** | Interval std-dev | 20ms |
| **Clock Drift** | `|bag − header|` median | 100ms |

---

## 3.8 Data Bandwidth & Anomaly Panel

### 3.8.1 Doughnut + Bubble Cards

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  DATA BANDWIDTH & ANOMALY                                [Per Topic] [Timeline]    │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  Bytes Distribution                    Topic Bubble Cards                           │
│  ┌──────────┐                        ┌─────────────────┐                           │
│  │          │                        │ /scan           │                           │
│  │   ●      │                        │ Avg: 1.2 KB     │                           │
│  │  /cmd    │                        │ Peak: 1.5 KB   │                           │
│  │  vel     │                        │ Zero: 0        │                           │
│  │  5%      │                        │ ████████████ 🟢│                           │
│  │          │                        └─────────────────┘                           │
│  │          │                        ┌─────────────────┐                           │
│  │  /scan   │                        │ /pointcloud     │                           │
│  │  15%     │                        │ Avg: 245 KB     │                           │
│  │          │                        │ Peak: 312 KB   │                           │
│  │ /odom    │                        │ Zero: 0        │                           │
│  │  25%     │                        │ ████████████ 🟢│                           │
│  │          │                        └─────────────────┘                           │
│  │ /tf      │                        ┌─────────────────┐                           │
│  │  50%     │                        │ /image/comprsd  │                           │
│  │          │                        │ Avg: 0 B  ⚠     │                           │
│  │ /image   │                        │ Peak: 0 B       │                           │
│  │  5%      │                        │ Zero: 45        │                           │
│  │          │                        │ ████ 🔴 PLD-01  │                           │
│  └──────────┘                        └─────────────────┘                           │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.8.2 Anomaly States

| State | Color | Reason |
|-------|-------|--------|
| Healthy | 🟢 | Normal size range |
| Warning | 🟡 | Unusual size variation |
| **Zero-byte** | 🔴 | `payload_zero_byte` detected (PLD-01) |

---

## 3.9 Export & Share

### 3.9.1 Export Options

| Format | Content |
|--------|---------|
| **JSON** | Full Health Summary + detections |
| **Markdown** | Human-readable report |
| **CSV** | Detection timeline |

### 3.9.2 Export Data

> Weak evidence only: message counts, band start/end ± timestamps, sample headers, frame IDs. **No raw content** exported (keeps LLM contract clean).

---

## 3.10 Color System Summary

| Color | Hex | Usage |
|-------|-----|-------|
| 🟢 Green | `#28a745` | HS ≥ 80, Healthy, OK |
| 🟡 Yellow | `#ffc107` | HS 60-79, Warning, Monitor |
| 🔴 Red | `#dc3545` | HS < 60, Critical, Incident |
| ⚪ Grey | `#6c757d` | Silent, Jitter, Low |
| 🟠 Orange | `#fd7e14` | High severity intermediate |

---

## 3.11 Component Priority

For quick 1-2 second scan, elements render in priority order:

1. **Health Score Gauge** — the number everyone looks at first
2. **Worst Severity Badge** — immediate context
3. **TF Tree Status** — most critical for navigation
4. **Timeline Heatmap** — "when did it happen"
5. **Topic Drop Badges** — which control topics affected
