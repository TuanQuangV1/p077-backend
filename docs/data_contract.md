# Data Contract — Diagnostics JSON Shapes

Single source of truth for all JSON shapes produced by the rule engine and consumed by the API, LLM explainer, and frontend.

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

Five detection kinds. All share `kind`, `topic`, `severity`, `confidence`, `tSec`, `endSec`, `evidence`. Evidence keys vary:

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

Six keys. Source precedence: runtime override (API) > persisted file (`data/diagnostics/thresholds.json`) > Python default (`DEFAULT_DIAGNOSTICS_THRESHOLDS` in `diagnostics_config.py:18`).

| Key | Default | Persisted on disk? | Environment override |
|---|---|---|---|
| `frequency_gap_min_threshold_sec` | 0.08 | yes | `DIAGNOSTICS_THRESHOLDS_FILE` |
| `frequency_gap_multiplier` | 1.5 | yes | same |
| `silent_node_min_span_sec` | 0.3 | yes | same |
| `timestamp_jitter_max_sec` | 0.02 | no (Python default only) | same |
| `max_gap_burst_sec` | 1.0 | no (Python default only) | same |
| `clock_drift_max_sec` | 0.1 | no (Python default only) | same |

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
| Diagnostics summary | `diagnostics.py:408` | API response, LLM explainer, run store | `/api/v1/analysis/diagnose`, internal `run_analysis` |
| Window export | `window_export.py:71` | LLM-friendly low-volume export, debugging | `GET /api/v1/analysis/{run_id}/export/windows` |
| Detection object | `diagnostics.py` (rules) | `run_anomalies` table in SQLite, frontend timeline | embedded in `AnalysisDetailResponse` |