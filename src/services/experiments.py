"""Filesystem-backed experiment (rosbag dataset) storage under ``data/``.

Handles listing, upload (single file or rosbag2 zip), safe zip extraction and
deletion. Upload and extraction are bounded by ``MAX_UPLOAD_BYTES`` to prevent
disk-fill denial of service.
"""

import logging
import os
from datetime import UTC, datetime
from pathlib import Path
import re
import shutil
import sqlite3
import zipfile
from typing import Any, BinaryIO

import yaml
from dotenv import load_dotenv

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"

ALLOWED_BAG_EXTENSIONS = {".db3", ".mcap", ".bag"}

load_dotenv(DATA_DIR.parent / ".env")
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(1024 * 1024 * 1024)))
_COPY_CHUNK_BYTES = 1024 * 1024

ROS2_ROBOT_MAP = {
    "/mobile_base_controller/cmd_vel": "amr-delivery",
    "/scan": "amr-delivery",
    "/imu": "amr-delivery",
}


def list_experiments() -> list[dict[str, Any]]:
    """Scan data/ subfolders and return items for folders containing bag files."""
    if not DATA_DIR.exists():
        return []
    results = []
    for folder in sorted(DATA_DIR.iterdir()):
        if not folder.is_dir():
            continue
        item = _load_item(folder)
        if item:
            results.append(item)
    return results


def _bag_files(folder: Path) -> list[Path]:
    for ext in (".db3", ".mcap", ".bag"):
        files = sorted(p for p in folder.rglob(f"*{ext}") if p.is_file())
        if files:
            return files
    return []


def _load_item(folder: Path) -> dict[str, Any] | None:
    files = _bag_files(folder)
    if not files:
        return None
    info = _read_bagfile_info(folder)
    if info is None:
        return None
    file_size = sum(f.stat().st_size for f in files)
    duration_ns = info.get("duration", {}).get("nanoseconds", 0)
    duration_sec = int(duration_ns / 1_000_000_000)
    message_count = info.get("message_count", 0)
    topics = info.get("topics_with_message_count", [])
    topic_metas = [t["topic_metadata"] for t in topics]
    topic_names = [t["name"] for t in topic_metas]
    robot_type = "amr-delivery"
    for topic_name, rtype in ROS2_ROBOT_MAP.items():
        if topic_name in topic_names:
            robot_type = rtype
            break
    starting_time = info.get("starting_time", {})
    start_ns = starting_time.get("nanoseconds_since_epoch", 0)
    start_dt = _nanos_to_iso(start_ns) if start_ns else datetime.now(UTC).isoformat()
    file_name = files[0].name
    return {
        "id": folder.name,
        "name": file_name,
        "robotType": robot_type,
        "sizeBytes": file_size,
        "durationSec": duration_sec,
        "recordedAt": start_dt,
        "uploadedAt": start_dt,
        "status": "uploaded",
        "messageCount": message_count,
        "topics": topic_metas,
        "site": "Unknown",
        "rosVersion": "ROS 2 Jazzy",
    }


def _read_bagfile_info(folder: Path) -> dict[str, Any] | None:
    """Return rosbag2 bagfile information, preferring `metadata.yaml`.

    Falls back to deriving the information directly from the first bag file
    when no metadata file exists: ``.db3`` bags are read through SQLite and
    ``.mcap`` bags through the optional ``rosbags`` package. Unsupported
    formats (``.bag``) return None.
    """
    metadata_file = folder / "metadata.yaml"
    if metadata_file.exists():
        with metadata_file.open() as f:
            meta = yaml.safe_load(f)
        raw_info = (meta or {}).get("rosbag2_bagfile_information")
        if isinstance(raw_info, dict):
            return raw_info
    first = next(iter(_bag_files(folder)), None)
    if first is None:
        return None
    suffix = first.suffix.lower()
    if suffix == ".db3":
        return _read_bagfile_info_from_db3(folder)
    if suffix == ".mcap":
        return _read_bagfile_info_from_mcap(folder)
    return None


def _read_bagfile_info_from_db3(folder: Path) -> dict[str, Any] | None:
    """Derive bagfile information from the first `.db3` in `folder`.

    Reads only the `topics`/`messages` tables (message payloads are never
    decoded). Returns None when the file is not a readable rosbag2 database.
    """
    db3 = next((f for f in _bag_files(folder) if f.suffix.lower() == ".db3"), None)
    if db3 is None:
        return None
    try:
        conn = sqlite3.connect(f"file:{db3}?mode=ro", uri=True)
        try:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "topics" not in tables:
                return None
            topics = conn.execute("SELECT name, type FROM topics ORDER BY id").fetchall()
            if "messages" in tables:
                row = conn.execute("SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM messages").fetchone()
                counts = dict(
                    conn.execute(
                        "SELECT t.name, COUNT(*) FROM messages m JOIN topics t ON m.topic_id = t.id GROUP BY t.name"
                    ).fetchall()
                )
            else:
                row = None
                counts = {}
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    message_count = row[0] if row else 0
    start_ns = row[1] if row and row[1] is not None else 0
    end_ns = row[2] if row and row[2] is not None else start_ns
    topics_with_message_count = [
        {
            "topic_metadata": {
                "name": name,
                "type": mtype,
                "serialization_format": "cdr",
                "offered_qos_profiles": {},
            },
            "message_count": counts.get(name, 0),
        }
        for name, mtype in topics
    ]
    return {
        "version": 4,
        "storage_identifier": "sqlite3",
        "duration": {"nanoseconds": max(0, end_ns - start_ns)},
        "starting_time": {"nanoseconds_since_epoch": start_ns},
        "message_count": message_count,
        "topics_with_message_count": topics_with_message_count,
    }


def _read_bagfile_info_from_mcap(folder: Path) -> dict[str, Any] | None:
    """Derive bagfile information from the first ``.mcap`` in `folder`.

    Uses ``rosbags`` (:class:`rosbags.highlevel.AnyReader`) to walk the
    message index of the file: only per-topic message counts and timestamp
    bounds are collected, never the message payloads themselves. Returns None
    when the file cannot be opened as a valid MCAP recording.
    """
    mcap = next((f for f in _bag_files(folder) if f.suffix.lower() == ".mcap"), None)
    if mcap is None:
        return None
    try:
        from rosbags.highlevel import AnyReader  # noqa: PLC0415 - optional dependency

        counts: dict[str, int] = {}
        starts: dict[str, int] = {}
        ends: dict[str, int] = {}
        topics: dict[str, str] = {}
        with AnyReader([mcap]) as reader:
            for connection, timestamp_ns, _rawdata in reader.messages():
                topic = connection.topic
                counts[topic] = counts.get(topic, 0) + 1
                starts[topic] = min(starts.get(topic, timestamp_ns), timestamp_ns)
                ends[topic] = max(ends.get(topic, timestamp_ns), timestamp_ns)
                topics.setdefault(topic, connection.msgtype)
    except Exception:
        return None

    message_count = sum(counts.values())
    start_ns = min(starts.values(), default=0)
    end_ns = max(ends.values(), default=start_ns)
    topics_with_message_count = [
        {
            "topic_metadata": {
                "name": topic,
                "type": msgtype,
                "serialization_format": "cdr",
                "offered_qos_profiles": {},
            },
            "message_count": counts.get(topic, 0),
        }
        for topic, msgtype in topics.items()
    ]
    return {
        "version": 4,
        "storage_identifier": "mcap",
        "duration": {"nanoseconds": max(0, end_ns - start_ns)},
        "starting_time": {"nanoseconds_since_epoch": start_ns},
        "message_count": message_count,
        "topics_with_message_count": topics_with_message_count,
    }


def _ensure_timestamp_index(db3_path: Path) -> None:
    """Create timestamp indexes on a rosbag2 ``.db3`` to speed sorted reads.

    SQLite has no index backing ``ORDER BY timestamp`` on fresh bags, so
    read-time sorts fall back to a full table sort. Indexing once at upload
    time (a writable connection, unlike the read-only readers) lets later
    queries reuse ``idx_messages_topic_time`` / ``idx_messages_time``.

    Never raises: index creation is a best-effort optimization. Files that
    are not valid rosbag2 databases (e.g. no ``messages`` table) log a warning
    and are skipped so uploads are never blocked by a failed index build.
    """
    if db3_path.suffix.lower() != ".db3":
        return
    try:
        conn = sqlite3.connect(str(db3_path))
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_topic_time ON messages(topic_id, timestamp)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp)")
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error:
        logger = logging.getLogger(__name__)
        logger.warning(
            "experiments.index_skip",
            extra={
                "diagnostics": {
                    "event": "experiments.index_skip",
                    "level": "warning",
                    "db3": str(db3_path),
                }
            },
        )


def _nanos_to_iso(nanos: int) -> str:
    sec = nanos / 1_000_000_000
    return datetime.fromtimestamp(sec, tz=UTC).isoformat()


def _sanitize_dataset_id(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r"[^a-zA-Z0-9_-]", "-", stem).strip("-_")
    stem = re.sub(r"-+", "-", stem)
    if not stem:
        stem = "rosbag"
    if not DATA_DIR.exists():
        return stem
    existing = {folder.name for folder in DATA_DIR.iterdir() if folder.is_dir()}
    candidate, suffix = stem, 2
    while candidate in existing:
        candidate = f"{stem}-{suffix}"
        suffix += 1
    return candidate


def _write_minimal_metadata(folder: Path, file_name: str) -> None:
    now_ns = int(datetime.now(UTC).timestamp() * 1_000_000_000)
    meta = {
        "rosbag2_bagfile_information": {
            "version": 4,
            "storage_identifier": "sqlite3",
            "relative_file_paths": [file_name],
            "duration": {"nanoseconds": 0},
            "starting_time": {"nanoseconds_since_epoch": now_ns},
            "message_count": 0,
            "topics_with_message_count": [],
        }
    }
    with (folder / "metadata.yaml").open("w", encoding="utf-8") as f:
        yaml.safe_dump(meta, f, sort_keys=False)


def _extract_zip_safely(archive: Path, target: Path) -> None:
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ValueError("zip contains unsafe path")
        total_uncompressed = sum(member.file_size for member in zf.infolist())
        if total_uncompressed > MAX_UPLOAD_BYTES:
            raise ValueError("zip uncompressed size exceeds upload limit")
        zf.extractall(target)
    metadata = target / "metadata.yaml"
    if metadata.exists():
        return
    nested = [p for p in target.iterdir() if p.is_dir() and (p / "metadata.yaml").exists()]
    if len(nested) == 1:
        for child in nested[0].iterdir():
            shutil.move(str(child), str(target / child.name))
        nested[0].rmdir()


def save_uploaded_rosbag(filename: str, source: BinaryIO) -> dict[str, Any]:
    """Persist an uploaded rosbag file (or rosbag2 zip) under data/.

    Args:
        filename: Original upload filename (must end in a supported extension).
        source: Binary file-like object to stream from.

    Returns:
        DatasetItem-shaped dict for the newly stored experiment.

    Raises:
        ValueError: Unsupported extension, unsafe zip content or upload too large.
    """
    # #region agent debug log
    _debug_log_path = Path(__file__).resolve().parent.parent.parent / "debug-b95897.log"
    with _debug_log_path.open("a") as _f:
        import json
        _f.write(json.dumps({
            "sessionId": "b95897", "location": "experiments.py:save_uploaded_rosbag:entry",
            "message": "save_uploaded_rosbag called", "data": {"filename": filename},
            "timestamp": int(datetime.now(UTC).timestamp() * 1000), "hypothesisId": "H3,H4"
        }) + "\n")
    # #endregion
    suffix = Path(filename).suffix.lower()
    # #region agent debug log
    with _debug_log_path.open("a") as _f:
        _f.write(json.dumps({
            "sessionId": "b95897", "location": "experiments.py:save_uploaded_rosbag:suffix_check",
            "message": "suffix check", "data": {"suffix": suffix, "allowed": list(ALLOWED_BAG_EXTENSIONS)},
            "timestamp": int(datetime.now(UTC).timestamp() * 1000), "hypothesisId": "H3,H4"
        }) + "\n")
    # #endregion
    if suffix not in ALLOWED_BAG_EXTENSIONS and suffix != ".zip":
        raise ValueError(f"unsupported file type: {suffix}")

    dataset_id = _sanitize_dataset_id(filename)
    folder = DATA_DIR / dataset_id
    folder.mkdir(parents=True, exist_ok=True)

    def _copy_bounded(source: BinaryIO, out: BinaryIO) -> None:
        written = 0
        while True:
            chunk = source.read(_COPY_CHUNK_BYTES)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise ValueError("upload exceeds size limit")
            out.write(chunk)

    try:
        if suffix == ".zip":
            archive = folder / f"{dataset_id}.zip"
            with archive.open("wb") as out:
                _copy_bounded(source, out)
            _extract_zip_safely(archive, folder)
            archive.unlink(missing_ok=True)
            if not (folder / "metadata.yaml").exists():
                bag_files = _bag_files(folder)
                _write_minimal_metadata(folder, bag_files[0].name if bag_files else "rosbag.bag")
        else:
            safe_name = Path(filename).name
            with (folder / safe_name).open("wb") as out:
                _copy_bounded(source, out)
            # Never fabricate an empty metadata.yaml for a flat .db3/.mcap:
            # info is derived from the bag itself so uploads show real counts.
            # Unsupported formats (which have nothing to derive from) still
            # get a minimal metadata file when one is not already present.
            if suffix not in {".db3", ".mcap"} and not (folder / "metadata.yaml").exists():
                _write_minimal_metadata(folder, safe_name)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise

    for db3 in _bag_files(folder):
        _ensure_timestamp_index(db3)

    item = _load_item(folder)
    if item is None:
        raise ValueError("uploaded rosbag could not be indexed")
    return item


def delete_experiment(dataset_id: str) -> bool:
    """Remove an experiment folder under data/.

    Returns:
        True if the folder existed and was removed, False otherwise.
    """
    if not dataset_id or dataset_id in {".", ".."}:
        return False
    candidate = Path(dataset_id)
    if candidate.name != dataset_id:
        return False
    folder = DATA_DIR / dataset_id
    if not folder.is_dir():
        return False
    shutil.rmtree(folder)
    return True


def experiment_bag_files(dataset_id: str) -> list[Path]:
    """Return every bag file of an experiment folder, in shard order.

    A rosbag2 recording split across multiple ``.db3`` shards (``bag_0.db3``,
    ``bag_1.db3``, ...) is returned in full so callers can scan all messages
    instead of silently reading only the first shard.

    Args:
        dataset_id: ID of the dataset (folder name).

    Returns:
        List of bag files (.db3/.mcap/.bag), empty if the dataset does not
        exist or contains no bag file.
    """
    if not dataset_id or dataset_id in {".", ".."}:
        return []
    candidate = Path(dataset_id)
    if candidate.name != dataset_id:
        return []
    folder = DATA_DIR / dataset_id
    if not folder.is_dir():
        return []
    return _bag_files(folder)


def experiment_bag_path(dataset_id: str) -> Path | None:
    """Return the path of the first bag file of an experiment folder.

    Args:
        dataset_id: ID of the dataset (folder name).

    Returns:
        Path to the first bag file (.db3/.mcap/.bag), or None if the dataset
        does not exist or contains no bag file.
    """
    files = experiment_bag_files(dataset_id)
    return files[0] if files else None
