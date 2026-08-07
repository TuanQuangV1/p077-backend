# Architecture Diagram (Concise)

## Data Flow

```mermaid
graph TB
    UPLOAD[Upload<br/>save_uploaded_rosbag] -. db3 only .-> IDX[CREATE INDEX<br/>idx_messages_topic_time<br/>idx_messages_time]
    UPLOAD -. mcap &amp; no metadata.yaml .-> DERIVE[_read_bagfile_info_from_mcap<br/>rosbags.AnyReader]
    BAG[Rosbag .db3/.mcap] --> ITER[iter_bag_messages<br/>bag_stream.py<br/>decode-first, .db3 fallback <br/>RuntimeError on non-db3]
    ITER --> DETECT[detect_anomalies<br/>diagnostics.py · numpy]
    DETECT -->|JSON summary| STORE[run_store.py<br/>SQLite]
    DETECT --> WINDOW[iter_window_summaries<br/>window_export.py]
    WINDOW -->|NDJSON| EXPORT[GET .../export/windows]
    STORE --> API[FastAPI routes.py]
    DETECT --> LLM[explain_diagnostics<br/>llm.py · httpx]
    LLM -->|root_cause + actions| STORE
    API --> FE[Next.js 16 / React 19]
```

## Service Layers

```
Frontend (Next.js 16 / React 19 / shadcn/ui)
    │ HTTP REST
    ▼
FastAPI ─── Auth (optional token) ─── Rate Limiter (in-memory, 120 req/min)
    │
    ├── diagnostics.py    — rule engine (5 detection kinds, numpy)
    ├── window_export.py  — NDJSON summarizer (~100x compress)
    ├── llm.py            — raw httpx → OpenAI-compatible endpoint
    ├── experiments.py    — upload/delete/scan datasets
    │      ├─ save_uploaded_rosbag indexes every .db3 shard
    │      │     (idx_messages_topic_time, idx_messages_time) so the streaming
    │      │     reader never hits an unindexed SQLite sort.
    │      └─ When metadata.yaml is missing, info is derived in place:
    │           .db3 → _read_bagfile_info_from_db3 (sqlite scan)
    │           .mcap → _read_bagfile_info_from_mcap (rosbags.AnyReader)
    │           No fabricated metadata.yaml is written for flat .db3/.mcap.
    ├── run_store.py      — SQLite persistence (runs/anomalies/ai_results/review)
    └── diagnostics_config.py — thresholds (defaults → file → runtime overrides)
    │
    ▼
Storage: SQLite (runs.db) + data/<id>/*.db3/.mcap + data/diagnostics/thresholds.json
```

## Streaming Reader Behaviours

`iter_bag_messages` is the single entry point used by analysis, export, and CLI:

- **Prefer decoded path** (`iter_rosbag2_decoded`) via `rosbags.highlevel.AnyReader`.
- **Fall back to SQLite** (`iter_rosbag2_messages`) when the decode fails **and** the
  path is `.db3` (or a directory containing a `.db3` shard). Best-effort: a
  `bag_stream.decode_fallback` warning is logged with the `diagnostics` extra.
- **Raise `RuntimeError`** when the path is non-`.db3` (e.g. `.mcap`) and the
  decode fails — SQLite cannot open `.mcap`, so the fallback would surface a
  confusing `sqlite3.DatabaseError`. The error message identifies the format
  and the original decode failure.
- `.db3` reads omit `ORDER BY` and sort in Python (`numpy.argsort(kind="stable")`),
  relying on the upload-time indexes to keep the SQL plan cheap.

## No LangGraph / ChromaDB / PostgreSQL

This system uses a straight function-call chain, not a graph; SQLite, not a vector store or RDBMS cluster. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the reasoning.