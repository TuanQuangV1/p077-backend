"""Filesystem-backed experiment (rosbag dataset) storage under ``data/``.

Handles listing, upload (single file or rosbag2 zip), safe zip extraction and
deletion. Upload and extraction are bounded by ``MAX_UPLOAD_BYTES`` to prevent
disk-fill denial of service.
"""

import hashlib
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
import zipfile
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO

import yaml
from dotenv import load_dotenv

from src.services import perf

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"

ALLOWED_BAG_EXTENSIONS = {".db3", ".mcap", ".bag"}

load_dotenv(DATA_DIR.parent / ".env")
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(1024 * 1024 * 1024)))
_COPY_CHUNK_BYTES = 1024 * 1024

# Owner sanitization (username -> safe folder name)
def _sanitize_owner(owner: str) -> str:
    """Map a username to a filesystem-safe folder name, injectively.

    Sanitising alone is not injective: ``a-b``, ``a--b`` and ``a b`` all
    collapsed to ``a-b``, so three different users shared one dataset folder,
    and a user named ``..`` landed on ``admin``'s folder outright. When the
    sanitised form differs from the input, a hash of the original is appended
    so distinct usernames can never share a directory. Names that are already
    safe (the common case: ``admin``, ``bob``) are unchanged, so existing
    folders keep working.
    """
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "-", owner).strip("-_.")
    safe = re.sub(r"-+", "-", safe)
    if safe == owner:
        return safe
    digest = hashlib.sha256(owner.encode("utf-8")).hexdigest()[:8]
    return f"{safe}-{digest}" if safe else f"user-{digest}"


def _owner_dir(owner: str) -> Path:
    return DATA_DIR / _sanitize_owner(owner)


def _is_dataset_folder(folder: Path) -> bool:
    """Return True if folder directly contains a bag file or metadata.yaml."""
    if not folder.is_dir():
        return False
    # Direct bag files (non-recursive) - dataset folder has bag directly inside
    for ext in ALLOWED_BAG_EXTENSIONS:
        if any(folder.glob(f"*{ext}")):
            return True
    # Also check if folder has metadata.yaml (rosbag2)
    return bool((folder / "metadata.yaml").exists())


def _migrate_legacy_datasets() -> None:
    """Move flat datasets (data/<id>) into data/admin/<id> once."""
    if not DATA_DIR.exists():
        return
    admin_dir = _owner_dir("admin")
    for folder in list(DATA_DIR.iterdir()):
        if not folder.is_dir():
            continue
        # Skip already-owner dirs (they contain dataset subdirs, not bag files directly)
        # Heuristic: if folder directly contains bag files, it's a legacy dataset
        if _is_dataset_folder(folder):
            # It's a legacy dataset folder at top level -> move to admin
            target = admin_dir / folder.name
            if target.exists():
                continue
            admin_dir.mkdir(parents=True, exist_ok=True)
            with suppress(Exception):
                shutil.move(str(folder), str(target))
        else:
            # Could be owner dir (e.g., data/admin, data/demo) -> check inside
            # If folder.name is owner-like and contains subdirs with bags, it's already migrated
            continue

ROS2_ROBOT_MAP = {
    "/mobile_base_controller/cmd_vel": "amr-delivery",
    "/scan": "amr-delivery",
    "/imu": "amr-delivery",
}

_EXPERIMENTS_CACHE_TTL_SEC = float(os.environ.get("EXPERIMENTS_CACHE_TTL_SEC", "30"))

_cache_lock = threading.Lock()
_cached_state: tuple[float, list[dict[str, Any]]] | None = None
_owner_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def _set_cached_state(state: tuple[float, list[dict[str, Any]]] | None) -> None:
    global _cached_state  # noqa: PLW0603 - cache state lives at module scope
    _cached_state = state


def _get_owner_cached(owner: str) -> list[dict[str, Any]] | None:
    cache_key = f"{owner}:{DATA_DIR}"
    with _cache_lock:
        entry = _owner_cache.get(cache_key)
        if entry is not None and time.monotonic() - entry[0] < _EXPERIMENTS_CACHE_TTL_SEC:
            return list(entry[1])
    return None


def _set_owner_cached(owner: str, items: list[dict[str, Any]]) -> None:
    cache_key = f"{owner}:{DATA_DIR}"
    with _cache_lock:
        _owner_cache[cache_key] = (time.monotonic(), list(items))


def list_experiments(owner: str | None = None) -> list[dict[str, Any]]:
    """Scan data/ subfolders and return items for folders containing bag files.

    If ``owner`` is provided, only that owner's datasets are returned
    (``data/<owner>/<id>`` plus legacy ``data/<id>`` for ``admin``).
    If ``owner`` is None, all owners are scanned (backwards compat).

    Results are cached for ``EXPERIMENTS_CACHE_TTL_SEC`` seconds (default 30)
    because the scan reads bag metadata, which is expensive for large bags.
    Uploads and deletions invalidate the cache automatically.
    """
    if owner is not None:
        cached = _get_owner_cached(owner)
        if cached is not None:
            return cached
        _migrate_legacy_datasets()
        owner_results: list[dict[str, Any]] = []
        if DATA_DIR.exists():
            odir = _owner_dir(owner)
            if odir.exists():
                for folder in sorted(odir.iterdir()):
                    if not folder.is_dir():
                        continue
                    # Skip container dirs like 'bags' that are not datasets (contain nested datasets)
                    if not _is_dataset_folder(folder):
                        continue
                    try:
                        item = _load_item(folder)
                    except OSError:
                        logger = logging.getLogger(__name__)
                        logger.warning(
                            "experiments.load_skip",
                            extra={
                                "diagnostics": {
                                    "event": "experiments.load_skip",
                                    "level": "warning",
                                    "folder": str(folder),
                                }
                            },
                        )
                        continue
                    if item:
                        owner_results.append(item)
            if owner == "admin":
                for folder in sorted(DATA_DIR.iterdir()):
                    if not folder.is_dir():
                        continue
                    if _is_dataset_folder(folder):
                        try:
                            item = _load_item(folder)
                        except OSError:
                            continue
                        if item and not any(r["id"] == item["id"] for r in owner_results):
                            owner_results.append(item)
        _set_owner_cached(owner, owner_results)
        return list(owner_results)

    with _cache_lock:
        now = time.monotonic()
        if _cached_state is not None and now - _cached_state[0] < _EXPERIMENTS_CACHE_TTL_SEC:
            return list(_cached_state[1])
        results: list[dict[str, Any]] = []
        _migrate_legacy_datasets()
        if DATA_DIR.exists():
            # Scan all owner subdirs + legacy flat
            for entry in sorted(DATA_DIR.iterdir()):
                if not entry.is_dir():
                    continue
                if _is_dataset_folder(entry):
                    item = _load_item(entry)
                    if item:
                        results.append(item)
                else:
                    # Assume it's an owner dir (e.g., data/admin, data/demo)
                    for folder in sorted(entry.iterdir()):
                        if not folder.is_dir():
                            continue
                        item = _load_item(folder)
                        if item:
                            results.append(item)
        _set_cached_state((now, results))
        return list(results)


def _invalidate_experiments_cache() -> None:
    with _cache_lock:
        _set_cached_state(None)
        _owner_cache.clear()


def _bag_files(folder: Path) -> list[Path]:
    """Return bag files directly inside *folder* (non-recursive).

    Previous implementation used ``rglob`` which walked the entire subtree.
    That made ``data/admin/bags`` (a container with 49 nested datasets) appear
    as one giant dataset and exhausted file descriptors under load
    (ENOMEM on scandir). Direct ``glob`` plus a single-level shard check is
    sufficient — real datasets are flat (bag in folder root) or one-level
    sharded, never deeply nested. Deep containers like ``bags`` are skipped
    by the caller via ``_is_dataset_folder``.
    """
    try:
        for ext in (".db3", ".mcap", ".bag"):
            files = sorted(p for p in folder.glob(f"*{ext}") if p.is_file())
            if files:
                return files
            # Support one-level shard layout e.g. folder/sub/bag.db3 without deep walk
            nested = sorted(p for p in folder.glob(f"*/*{ext}") if p.is_file())
            if nested:
                return nested
        return []
    except OSError as exc:
        logging.getLogger(__name__).warning(
            "experiments.bag_scan_failed",
            extra={
                "diagnostics": {
                    "event": "experiments.bag_scan_failed",
                    "level": "warning",
                    "folder": str(folder),
                    "error": str(exc),
                }
            },
        )
        return []


# Sidecar cache for a dataset's content hash, not `metadata.yaml`: many
# datasets in this system (flat .db3/.mcap uploads) deliberately have no
# metadata.yaml at all (see `save_uploaded_rosbag`), so a hash cache tied to
# that file would miss most of them.
_CONTENT_HASH_FILENAME = ".content_sha256"


def _dataset_content_hash(folder: Path) -> str | None:
    """Return the SHA-256 of a dataset's primary bag file, cached in a sidecar file.

    Only the first bag file (what `_load_item` already treats as this
    dataset's identity for listing) is hashed — a multi-shard recording's
    later shards aren't part of the dedup key. Returns None for a folder with
    no bag file.
    """
    cache_file = folder / _CONTENT_HASH_FILENAME
    if cache_file.exists():
        cached = cache_file.read_text().strip()
        if cached:
            return cached
    files = _bag_files(folder)
    if not files:
        return None
    digest = hashlib.sha256()
    with files[0].open("rb") as f:
        while True:
            chunk = f.read(_COPY_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    content_hash = digest.hexdigest()
    cache_file.write_text(content_hash)
    return content_hash


def _find_duplicate_dataset(
    content_hash: str, exclude_id: str, owner: str = "admin"
) -> dict[str, Any] | None:
    """Return *this owner's* dataset with the same bag content, if any.

    Scoped to ``data/<owner>/`` (plus the legacy flat ``data/<id>`` layout, but
    only for ``admin``, who owns those). Scanning every owner's directory made
    an upload return a stranger's DatasetItem — id, name, size and topic list —
    and then dropped the uploader's own copy, so their dataset list stayed
    empty. Two users are entitled to hold the same bag.

    Owner directories themselves (e.g. ``data/admin``) are never treated as
    datasets, even though ``_bag_files`` with a one-level glob could find a
    nested bag inside them.
    """
    if not DATA_DIR.exists():
        return None

    candidates: list[Path] = []
    owner_dir = _owner_dir(owner)
    if owner_dir.is_dir():
        candidates.extend(sorted(owner_dir.iterdir()))
    if owner == "admin":
        # Datasets predating per-owner directories live at data/<id>.
        candidates.extend(f for f in sorted(DATA_DIR.iterdir()) if _is_dataset_folder(f))

    for folder in candidates:
        if not folder.is_dir() or folder.name == exclude_id:
            continue
        if not _is_dataset_folder(folder):
            continue
        if _dataset_content_hash(folder) == content_hash:
            return _load_item(folder)
    return None


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
        conn = perf.open_connection(f"file:{db3}?mode=ro", uri=True, source=f"bag.metadata:{db3.name}")
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

    Reads the MCAP summary/index section (chunk index, per-channel message
    counts and statistics) instead of iterating every message, so listing
    datasets is O(index size) and never deserializes payloads. Returns None
    when the file cannot be opened as a valid MCAP recording.
    """
    mcap = next((f for f in _bag_files(folder) if f.suffix.lower() == ".mcap"), None)
    if mcap is None:
        return None
    try:
        from rosbags.rosbag2.storage_mcap import McapReader  # noqa: PLC0415 - optional dependency

        reader = McapReader(mcap)
        try:
            reader.open()
            stats = reader.statistics
            if stats is None:
                return None
            counts = stats.channel_message_counts
            topics_with_message_count = [
                {
                    "topic_metadata": {
                        "name": channel.topic,
                        "type": channel.schema,
                        "serialization_format": "cdr",
                        "offered_qos_profiles": {},
                    },
                    "message_count": counts.get(channel.id, 0),
                }
                for channel in sorted(reader.channels.values(), key=lambda c: c.id)
            ]
            if stats.message_count:
                start_ns = stats.start_time
                end_ns = stats.end_time
            else:
                start_ns = 0
                end_ns = 0
            return {
                "version": 4,
                "storage_identifier": "mcap",
                "duration": {"nanoseconds": max(0, end_ns - start_ns)},
                "starting_time": {"nanoseconds_since_epoch": start_ns},
                "message_count": stats.message_count,
                "topics_with_message_count": topics_with_message_count,
            }
        finally:
            with suppress(Exception):
                reader.close()
    except Exception as exc:
        logger.warning("Failed to derive metadata from MCAP %s: %s", mcap.name, exc)
        return None


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
        conn = perf.open_connection(str(db3_path), source=f"bag.index:{db3_path.name}")
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_topic_time ON messages(topic_id, timestamp)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp)")
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error:
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


def _sanitize_dataset_id(filename: str, owner: str = "admin") -> str:
    stem = Path(filename).stem
    stem = re.sub(r"[^a-zA-Z0-9_-]", "-", stem).strip("-_")
    stem = re.sub(r"-+", "-", stem)
    if not stem:
        stem = "rosbag"
    owner_dir = _owner_dir(owner)
    if not owner_dir.exists():
        # Check legacy for admin even if owner dir not exists
        if owner == "admin" and DATA_DIR.exists():
            existing = set()
            for folder in DATA_DIR.iterdir():
                if folder.is_dir() and _is_dataset_folder(folder):
                    existing.add(folder.name)
            if stem in existing:
                # Need to dedup with legacy
                candidate, suffix = stem, 2
                while candidate in existing:
                    candidate = f"{stem}-{suffix}"
                    suffix += 1
                return candidate
        return stem
    existing = {folder.name for folder in owner_dir.iterdir() if folder.is_dir()}
    # Also check legacy flat for admin owner to avoid collision before migration
    if owner == "admin" and DATA_DIR.exists():
        for folder in DATA_DIR.iterdir():
            if folder.is_dir() and _is_dataset_folder(folder):
                existing.add(folder.name)
    candidate, suffix = stem, 2
    while candidate in existing:
        candidate = f"{stem}-{suffix}"
        suffix += 1
    return candidate


def _sanitize_dataset_id_legacy(filename: str) -> str:
    # Backwards compat wrapper without owner (defaults to admin)
    return _sanitize_dataset_id(filename, "admin")


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
    written = 0
    target = target.resolve()
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ValueError("zip contains unsafe path")
        total_uncompressed = sum(member.file_size for member in zf.infolist())
        if total_uncompressed > MAX_UPLOAD_BYTES:
            raise ValueError("zip uncompressed size exceeds upload size limit")
        for member in zf.infolist():
            dest = (target / member.filename).resolve()
            if dest != target and target not in dest.parents:
                raise ValueError("zip contains unsafe path")
            # Directory entries carry no data. Opening one for writing created a
            # *file* where a directory belongs, and the next member's `mkdir`
            # then failed with FileExistsError — so any archive written by
            # Windows Explorer or `zip -r`, both of which record directories by
            # default, could never be uploaded.
            if member.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, dest.open("wb") as out:
                while True:
                    chunk = src.read(_COPY_CHUNK_BYTES)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        raise ValueError("zip uncompressed size exceeds upload size limit")
                    out.write(chunk)
    metadata = target / "metadata.yaml"
    if metadata.exists():
        return
    nested = [p for p in target.iterdir() if p.is_dir() and (p / "metadata.yaml").exists()]
    if len(nested) == 1:
        for child in nested[0].iterdir():
            shutil.move(str(child), str(target / child.name))
        nested[0].rmdir()


def save_uploaded_rosbag(filename: str, source: BinaryIO, owner: str = "admin") -> dict[str, Any]:
    """Persist an uploaded rosbag file (or rosbag2 zip) under data/<owner>/.

    Args:
        filename: Original upload filename (must end in a supported extension).
        source: Binary file-like object to stream from.
        owner: Username who owns the dataset (from JWT sub).

    Returns:
        DatasetItem-shaped dict for the newly stored experiment.

    Raises:
        ValueError: Unsupported extension, unsafe zip content or upload too large.
    """
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_BAG_EXTENSIONS and suffix != ".zip":
        raise ValueError(f"unsupported file type: {suffix}")

    _migrate_legacy_datasets()
    dataset_id = _sanitize_dataset_id(filename, owner)
    folder = _owner_dir(owner) / dataset_id
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
        # Clean up empty owner dir to satisfy tests expecting no leftover
        try:
            owner_dir = _owner_dir(owner)
            if owner_dir.exists() and not any(owner_dir.iterdir()):
                owner_dir.rmdir()
        except OSError:
            # A concurrent upload repopulated the dir — harmless, leave it.
            pass
        raise

    # Same bag content re-uploaded under a new name/id gets a fresh folder from
    # `_sanitize_dataset_id` — it only avoids name collisions, not content
    # ones. Check before indexing so a detected duplicate skips that work
    # entirely rather than indexing a folder about to be deleted.
    content_hash = _dataset_content_hash(folder)
    if content_hash is not None:
        original = _find_duplicate_dataset(content_hash, exclude_id=dataset_id, owner=owner)
        if original is not None:
            shutil.rmtree(folder, ignore_errors=True)
            _invalidate_experiments_cache()
            return {**original, "duplicateOf": original["id"]}

    for db3 in _bag_files(folder):
        _ensure_timestamp_index(db3)

    item = _load_item(folder)
    if item is None:
        raise ValueError("uploaded rosbag could not be indexed")
    _invalidate_experiments_cache()
    return item


def delete_experiment(dataset_id: str, owner: str | None = None) -> bool:  # noqa: PLR0911
    """Remove an experiment folder under data/<owner>/.

    If ``owner`` is provided, only that owner's dataset can be deleted.
    If ``owner`` is None, search all owners (backwards compat for admin).

    Returns:
        True if the folder existed and was removed, False otherwise.
    """
    if not dataset_id or dataset_id in {".", ".."}:
        return False
    candidate = Path(dataset_id)
    if candidate.name != dataset_id:
        return False
    _migrate_legacy_datasets()
    if owner is not None:
        folder = _owner_dir(owner) / dataset_id
        if folder.is_dir():
            shutil.rmtree(folder)
            _invalidate_experiments_cache()
            return True
        # For admin, also check legacy flat location (if not yet migrated)
        if owner == "admin":
            legacy = DATA_DIR / dataset_id
            if legacy.is_dir() and _is_dataset_folder(legacy):
                shutil.rmtree(legacy)
                _invalidate_experiments_cache()
                return True
        return False
    # No owner specified: search legacy + all owners
    # Check legacy flat first
    legacy = DATA_DIR / dataset_id
    if legacy.is_dir() and _is_dataset_folder(legacy):
        shutil.rmtree(legacy)
        _invalidate_experiments_cache()
        return True
    if DATA_DIR.exists():
        for owner_dir in DATA_DIR.iterdir():
            if not owner_dir.is_dir():
                continue
            if _is_dataset_folder(owner_dir):
                continue  # legacy dataset, already handled
            folder = owner_dir / dataset_id
            if folder.is_dir():
                shutil.rmtree(folder)
                _invalidate_experiments_cache()
                # Clean up empty owner dir
                try:
                    if not any(owner_dir.iterdir()):
                        owner_dir.rmdir()
                except OSError:
                    # A concurrent upload repopulated the dir — harmless.
                    pass
                return True
    return False


def experiment_bag_files(dataset_id: str, owner: str | None = None) -> list[Path]:  # noqa: PLR0911
    """Return every bag file of an experiment folder, in shard order.

    A rosbag2 recording split across multiple ``.db3`` shards (``bag_0.db3``,
    ``bag_1.db3``, ...) is returned in full so callers can scan all messages
    instead of silently reading only the first shard.

    Args:
        dataset_id: ID of the dataset (folder name).
        owner: Owner username. If None, search all owners (legacy).

    Returns:
        List of bag files (.db3/.mcap/.bag), empty if the dataset does not
        exist or contains no bag file.
    """
    if not dataset_id or dataset_id in {".", ".."}:
        return []
    candidate = Path(dataset_id)
    if candidate.name != dataset_id:
        return []
    _migrate_legacy_datasets()
    if owner is not None:
        folder = _owner_dir(owner) / dataset_id
        if folder.is_dir():
            return _bag_files(folder)
        if owner == "admin":
            legacy = DATA_DIR / dataset_id
            if legacy.is_dir() and _is_dataset_folder(legacy):
                return _bag_files(legacy)
        return []
    # Search all owners + legacy
    if DATA_DIR.exists():
        # Check legacy flat first
        legacy = DATA_DIR / dataset_id
        if legacy.is_dir() and _is_dataset_folder(legacy):
            return _bag_files(legacy)
        for owner_dir in DATA_DIR.iterdir():
            if not owner_dir.is_dir():
                continue
            if _is_dataset_folder(owner_dir):
                continue  # skip legacy dataset folders
            folder = owner_dir / dataset_id
            if folder.is_dir():
                return _bag_files(folder)
    return []


def experiment_bag_path(dataset_id: str, owner: str | None = None) -> Path | None:
    """Return the path of the first bag file of an experiment folder.

    Args:
        dataset_id: ID of the dataset (folder name).
        owner: Owner username.

    Returns:
        Path to the first bag file (.db3/.mcap/.bag), or None if the dataset
        does not exist or contains no bag file.
    """
    files = experiment_bag_files(dataset_id, owner)
    return files[0] if files else None
