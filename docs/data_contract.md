# Data Contract — Diagnostics JSON Shapes

Single source of truth for all JSON shapes produced by the rule engine and consumed by the API, LLM explainer, and frontend.

> **Nguồn dữ liệu:** toàn bộ rosbag trong `data/` hiện là **synthetic** — sinh
> bởi `scripts/seed_*.py` với lỗi được inject có chủ đích để test rule engine.
> Chưa chạy với rosbag thật. Pipeline (`iter_bag_messages` → `detect_anomalies`)
> không phân biệt nguồn: một bag thật upload qua `POST /api/v1/datasets/upload`
> đi qua đúng đường đó.

## Shape 0: Dataset Item

Output of `GET /api/v1/datasets` and the upload endpoint. Backed by
`src/services/experiments.py` (`_load_item`, `_read_bagfile_info`).

```json
{
  "id": "robot_trip_01",
  "name": "robot_trip_01.db3",
  "robotType": "amr-delivery",
  "sizeBytes": 2048,
  "durationSec": 1,
  "recordedAt": "1970-01-01T00:00:00+00:00",
  "uploadedAt": "1970-01-01T00:00:00+00:00",
  "status": "uploaded",
  "analysisStatus": "not_analyzed",
  "analysisAnomalyCount": null,
  "worstSeverity": null,
  "lastRunId": null,
  "messageCount": 2,
  "topics": [
    {
      "name": "/scan",
      "type": "sensor_msgs/msg/LaserScan",
      "serialization_format": "cdr",
      "offered_qos_profiles": {}
    }
  ],
  "site": "Unknown",
  "rosVersion": "ROS 2 Jazzy"
}
```

### How `messageCount` / `topics` / `durationSec` are populated

The dataset items are produced by `_read_bagfile_info()` in
`src/services/experiments.py:97-228`. Three producer paths, applied in order:

| Storage | `metadata.yaml` present? | Producer | Result |
|---|---|---|---|
| `.db3` (or directory with `.db3`) | yes | parse YAML → `rosbag2_bagfile_information` | standard rosbag2 metadata |
| `.db3` | no | `_read_bagfile_info_from_db3` (sqlite scan of `topics` + `messages`) | derived counts, min/max `timestamp` for duration |
| `.mcap` | no | `_read_bagfile_info_from_mcap` (`rosbags.highlevel.AnyReader` walk) | derived counts, min/max observed `timestamp` for duration |
| `.bag` | any | none | folder is skipped (returns `None`) |

The `analysisStatus` family is enriched at read time from the latest `runs` row for that `id` (`not_analyzed` when no run exists, otherwise `succeeded`/`failed`/`running`/`queued` with `analysisAnomalyCount`/`worstSeverity`/`lastRunId`). The raw `status` field remains `"uploaded"` for backward compatibility.

A flat `.db3` or `.mcap` upload **never** gets a fabricated `metadata.yaml` —
the same dict shape is produced either way, so downstream consumers
(`GET /api/v1/datasets`, `_load_item`) cannot tell the two paths apart.

## Shape 1: Diagnostics Summary

Output of `POST /analysis/diagnose` and the internal `detect_anomalies()` call in `run_analysis`.

```json
{
  "summary": {
    "total_messages": 1234,
    "total_detections": 1,
    "severity": "medium"
  },
  "detections": [
    {
      "kind": "frequency_gap",
      "topic": "/scan",
      "severity": "medium",
      "confidence": 0.81,
      "tSec": 1.2,
      "endSec": 2.0,
      "evidence": {
        "interval_sec": 0.8,
        "threshold_sec": 0.12
      }
    }
  ],
  "thresholds": {
    "frequency_gap_min_threshold_sec": 0.08,
    "frequency_gap_multiplier": 1.5,
    "max_gap_burst_sec": 1.0,
    "timestamp_jitter_max_sec": 0.02,
    "clock_drift_max_sec": 0.1,
    "silent_node_min_span_sec": 0.3
  },
  "logs": [
    {
      "event": "diagnostics.rule_evaluation",
      "level": "warn",
      "message": "Evaluated frequency gap rule.",
      "details": {
        "topic": "/scan",
        "message_count": 85,
        "median_interval_sec": 0.08,
        "max_interval_sec": 0.8,
        "threshold_sec": 0.12,
        "thresholds": {
          "frequency_gap_min_threshold_sec": 0.08,
          "frequency_gap_multiplier": 1.5
        },
        "detected": true
      }
    }
  ]
}
```

## Shape 2: Detection Object (per `kind`)

All detection kinds share `kind`, `topic`, `severity`, `confidence`, `tSec`,
`endSec`, `evidence`. Evidence keys vary. The five timing kinds are listed
first; the five **health-extension** kinds (log / hz / latency / tf / payload)
follow.

### `frequency_gap`
> A single inter-message interval exceeds `max(frequency_gap_min_threshold_sec, median_interval * frequency_gap_multiplier)`.

```json
{"kind":"frequency_gap","topic":"/scan","severity":"medium","confidence":0.81,"tSec":1.2,"endSec":2.0,"evidence":{"interval_sec":0.8,"threshold_sec":0.12}}
```

| evidence key | description |
|---|---|
| `interval_sec` | Max inter-message interval in seconds |
| `threshold_sec` | Dynamic threshold applied |

### `message_drop_burst`
> A single inter-message interval exceeds the absolute ceiling `max_gap_burst_sec` (1.0 s default), independent of the median.

```json
{"kind":"message_drop_burst","topic":"/scan","severity":"medium","confidence":0.8,"tSec":0.0,"endSec":2.5,"evidence":{"max_gap_sec":2.5,"threshold_sec":1.0}}
```

| evidence key | description |
|---|---|
| `max_gap_sec` | Max inter-message interval in seconds |
| `threshold_sec` | Absolute drop-burst threshold (`max_gap_burst_sec`) |

### `timestamp_jitter`
> Population std-dev of inter-message intervals exceeds `timestamp_jitter_max_sec` (0.02 s default).

```json
{"kind":"timestamp_jitter","topic":"/imu","severity":"low","confidence":0.7,"tSec":0.0,"endSec":0.5,"evidence":{"jitter_sec":0.25,"threshold_sec":0.02}}
```

| evidence key | description |
|---|---|
| `jitter_sec` | Population std-dev of intervals |
| `threshold_sec` | Jitter threshold applied |

### `clock_drift`
> Median absolute `(bag timestamp − header.stamp)` exceeds `clock_drift_max_sec` (0.1 s default). Only evaluated when messages carry a `header` field.

```json
{"kind":"clock_drift","topic":"/imu","severity":"medium","confidence":0.85,"tSec":10.0,"endSec":11.0,"evidence":{"drift_sec":1.0,"threshold_sec":0.1}}
```

| evidence key | description |
|---|---|
| `drift_sec` | Median absolute bag−header offset |
| `threshold_sec` | Clock-drift threshold applied |

### `silent_node`
> A node's active span (last − first timestamp) reaches `silent_node_min_span_sec` (0.3 s default). `topic` is the dominant topic for that node.

```json
{"kind":"silent_node","topic":"/imu","severity":"low","confidence":0.72,"tSec":0.0,"endSec":0.8,"evidence":{"node":"imu_node","active_span_sec":0.8}}
```

| evidence key | description |
|---|---|
| `node` | Node name inferred from topic segments or bag mapping |
| `active_span_sec` | Span between first and last observed message |

### `log_fatal` / `log_error_burst` / `log_warn_storm`

> Evaluated on `/rosout` / `/diagnostics` messages carrying a `level` field.
> Count thresholds: `log_fatal_min_count` (1), `log_error_min_count` (3),
> `log_warn_min_count` (10). Requires the decoded reader
> (`iter_rosbag2_decoded`), which maps `rosgraph_msgs/Log.level` → level string.

```json
{"kind":"log_error_burst","topic":"/rosout","severity":"high","confidence":0.92,"tSec":12.0,"endSec":12.5,"evidence":{"level":"error","count":4,"threshold_count":3}}
```

| evidence key | description |
|---|---|
| `level` | `fatal` \| `error` \| `warn` |
| `count` | Number of messages at that level |
| `threshold_count` | Threshold that was exceeded |

### `hz_drop` / `hz_drop_critical`

> Windowed (5 s) rate compared against `expected_hz` (caller-supplied) or the
> peak window rate as fallback. Warn fires when the window rate drops more than
> `hz_drop_warn_pct` (30%), critical more than `hz_drop_critical_pct` (50%).
> Guarded by `hz_drop_min_messages` (50) so sparse streams aren't flagged.

```json
{"kind":"hz_drop","topic":"/cmd_vel","severity":"medium","confidence":0.88,"tSec":2.0,"endSec":7.0,"evidence":{"expected_hz":20.0,"actual_hz":12.5,"drop_pct":0.375,"window_sec":5.0,"min_messages":50}}
```

| evidence key | description |
|---|---|
| `expected_hz` | Expected rate (caller or peak-window fallback) |
| `actual_hz` | Measured rate in the worst window |
| `drop_pct` | Fractional drop below expected |
| `window_sec` | Sliding window size |
| `min_messages` | Guard: minimum messages before evaluation |

### `header_latency`

> Sustained skew between bag receive time and `header.stamp` exceeding
> `header_latency_max_ms` (100 ms) on at least `_HEADER_LATENCY_MIN_SUSTAINED`
> (3) consecutive lagging messages.

```json
{"kind":"header_latency","topic":"/scan","severity":"medium","confidence":0.8,"tSec":4.0,"endSec":4.6,"evidence":{"max_latency_ms":182.5,"threshold_ms":100.0,"lagging_messages":4}}
```

| evidence key | description |
|---|---|
| `max_latency_ms` | Worst `publish_ts − header.stamp` observed |
| `threshold_ms` | `header_latency_max_ms` |
| `lagging_messages` | Consecutive messages above threshold |

### `tf_missing_gap`

> A gap in consecutive `/tf` / `/tf_static` broadcasts longer than
> `tf_max_missing_span_sec` (0.5 s) — the transform chain is presumed stale.

```json
{"kind":"tf_missing_gap","topic":"/tf","severity":"high","confidence":0.86,"tSec":6.0,"endSec":6.7,"evidence":{"max_gap_sec":0.7,"threshold_sec":0.5,"child_frame_id":"base_link"}}
```

| evidence key | description |
|---|---|
| `max_gap_sec` | Longest inter-broadcast gap |
| `threshold_sec` | `tf_max_missing_span_sec` |
| `child_frame_id` | Child frame of the pair (e.g. `base_link`) |

### `tf_drift_jump`

> A child frame (typically `base_link`) is **re-parented** in the transform
> graph (identity switched, e.g. parent `odom` → `map`) — a localization
> re-root / relocalize event. Critical by default.

```json
{"kind":"tf_drift_jump","topic":"/tf","severity":"critical","confidence":0.93,"tSec":13.2,"endSec":13.2,"evidence":{"child_frame_id":"base_link","parent_before":"odom","parent_after":"map","prev_t":13.1,"cur_t":13.2}}
```

| evidence key | description |
|---|---|
| `child_frame_id` | Child frame whose parent changed |
| `parent_before` | Previous parent frame |
| `parent_after` | New parent frame |
| `prev_t` / `cur_t` | Timestamps across the switch |

> **v1 boundary:** this fires on parent *identity* switch. The geometric
> `tf_jump_distance_m` (0.5 m) threshold is reserved for a transform-decode
> pass reading `TransformStamped.transform.translation`.

### `payload_zero_byte`

> `payload_bytes == 0` on at least `payload_zero_byte_min_count` (5) messages
> of a topic — e.g. PointCloud / Image streams collapsing to empty.

```json
{"kind":"payload_zero_byte","topic":"/point_cloud","severity":"high","confidence":0.9,"tSec":8.0,"endSec":9.0,"evidence":{"zero_byte_count":6,"threshold_count":5,"topic_size_bytes":0}}
```

| evidence key | description |
|---|---|
| `zero_byte_count` | Messages with 0-byte payload |
| `threshold_count` | `payload_zero_byte_min_count` |
| `topic_size_bytes` | 0 (illustrative) |

## Shape 2b: Health Summary (Health Score)

Output of `GET /analysis/{run_id}/health` and embedded in
`GET /analysis/{run_id}` as `health`. See
[`docs/health/health-score.md`](health/health-score.md) for weights and zones.

```json
{
  "health_score": 65.0,
  "status": "red",
  "status_zones": {"green_min": 80, "yellow_min": 60, "red_max": 60},
  "trigger_llm_deep_dive": true,
  "summary": {
    "total_messages": 12000,
    "total_detections": 3,
    "worst_severity": "critical",
    "groups": {
      "frequency": {"score": 100.0, "weight": 0.30, "detection_count": 0},
      "tf": {"score": 0.0, "weight": 0.25, "detection_count": 2},
      "log": {"score": 50.0, "weight": 0.20, "detection_count": 1},
      "latency": {"score": 100.0, "weight": 0.15, "detection_count": 0},
      "payload": {"score": 100.0, "weight": 0.10, "detection_count": 0}
    }
  },
  "detections_by_group": {"tf": [{"kind": "tf_drift_jump", "topic": "/tf"}]}
}
```

## Shape 3: Window Export (NDJSON)

Output of `GET /analysis/{run_id}/export/windows`. One JSON row per `(topic, time window)`. Compresses message volume ~100x for LLM consumption.

```json
{"window_start":"1970-01-01T00:00:00+00:00","topic":"/imu","node":"imu_node","message_type":"sensor_msgs/msg/Imu","count":3,"expected_hz":20.0,"actual_hz":15.0,"max_gap_ms":100.0,"jitter_ms":0.0,"drift_ms":100.0}
```

| field | nullable | description |
|---|---|---|
| `window_start` | no | ISO-8601 UTC start of the aggregation window |
| `topic` | no | ROS topic name |
| `node` | no | Inferred or mapped node name |
| `message_type` | no | ROS message type |
| `count` | no | Message count in this window |
| `expected_hz` | yes (`null` when no `expected_hz` map provided) | Config-derived expected publish rate |
| `actual_hz` | yes (`null` when count ≤ 1) | `count / span` rate |
| `max_gap_ms` | yes (`null` when no gaps recorded) | Largest inter-message gap in ms |
| `jitter_ms` | yes (`null` when < 2 gaps) | Std-dev of intervals in ms |
| `drift_ms` | yes (`null` when stream has no `header` field) | Median `(bag ts − header.stamp)` in ms |

Source: `src/services/window_export.py:148-159` (`_summarize`).

## Thresholds Table

Sixteen keys. Source precedence: runtime override (API) > persisted file (`data/diagnostics/thresholds.json`) > Python default (`DEFAULT_DIAGNOSTICS_THRESHOLDS` in `diagnostics_config.py:18`).

| Key | Default | Used by |
|---|---|---|
| `frequency_gap_min_threshold_sec` | 0.08 | `frequency_gap` |
| `frequency_gap_multiplier` | 1.5 | `frequency_gap` |
| `max_gap_burst_sec` | 1.0 | `message_drop_burst` |
| `timestamp_jitter_max_sec` | 0.02 | `timestamp_jitter` |
| `clock_drift_max_sec` | 0.1 | `clock_drift` |
| `silent_node_min_span_sec` | 0.3 | `silent_node` |
| `hz_drop_warn_pct` | 0.30 | `hz_drop` |
| `hz_drop_critical_pct` | 0.50 | `hz_drop_critical` |
| `hz_drop_min_messages` | 50 | `hz_drop` / `hz_drop_critical` guard |
| `header_latency_max_ms` | 100 | `header_latency` |
| `log_error_min_count` | 3 | `log_error_burst` |
| `log_warn_min_count` | 10 | `log_warn_storm` |
| `log_fatal_min_count` | 1 | `log_fatal` |
| `tf_max_missing_span_sec` | 0.5 | `tf_missing_gap` |
| `tf_jump_distance_m` | 0.5 | `tf_drift_jump` (reserved for transform-decode pass) |
| `payload_zero_byte_min_count` | 5 | `payload_zero_byte` |

## Real Sample: E1-1 Run

Source: `docs/evaluation.md` §4. Run `POST /api/v1/analysis {"rosbag_id": "E1-1"}` (rosbag2 2024-03-11, ~7k messages, 268 ms total).

```
run.anomalyCount = 6
run.worstSeverity = medium
```

| # | kind | topic | tSec → endSec | severity | confidence |
|---|---|---|---|---|---|
| 1 | frequency_gap | `/mobile_base_controller/cmd_vel` | 1710159301.98 → 1710159303.67 | medium | 0.81 |
| 2 | frequency_gap | `/sonar_base` | 1710159310.97 → 1710159311.93 | medium | 0.81 |
| 3 | frequency_gap | `/tf` | 1710159323.54 → 1710159323.89 | medium | 0.81 |
| 4 | frequency_gap | `/scan` | 1710159301.50 → 1710159328.63 | medium | 0.81 |
| 5 | frequency_gap | `/mobile_base_controller/odom` | 1710159300.11 → 1710159306.87 | medium | 0.81 |
| 6 | silent_node | `/unknown` | 1710159259.64 → 1710159335.22 | low | 0.72 |

## Cross-References

| shape | producer | consumer | route |
|---|---|---|---|
| Dataset Item | `experiments.py:97-228` | `GET /datasets`, `POST /datasets/upload` | `/api/v1/datasets` |
| Diagnostics summary | `diagnostics.py:408` | API response, LLM explainer, run store | `/api/v1/analysis/diagnose`, internal `run_analysis` |
| Window export | `window_export.py:71` | LLM-friendly low-volume export, debugging | `GET /api/v1/analysis/{run_id}/export/windows` |
| Detection object | `diagnostics.py` (rules) | `run_anomalies` table in SQLite, frontend timeline | embedded in `AnalysisDetailResponse` |
| Health Summary | `health.py:84` (`compute_health_summary`) | dashboard gauge, `/deep-dive` prompt, LLM context | `GET /api/v1/analysis/{run_id}/health`, embedded in `AnalysisDetailResponse` |