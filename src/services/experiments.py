from datetime import UTC, datetime
from pathlib import Path
import re
import shutil
import zipfile

import yaml

EXPERIMENTS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "experiments"

ALLOWED_BAG_EXTENSIONS = {".db3", ".mcap", ".bag"}

ROS2_ROBOT_MAP = {
    "/mobile_base_controller/cmd_vel": "amr-delivery",
    "/scan": "amr-delivery",
    "/imu": "amr-delivery",
}

SITE_MAP = {
    "E1-1": "Fremont-A",
    "E1-2": "Fremont-B",
}


def list_experiments():
    if not EXPERIMENTS_DIR.exists():
        return []
    results = []
    for folder in sorted(EXPERIMENTS_DIR.iterdir()):
        if not folder.is_dir():
            continue
        item = _load_item(folder)
        if item:
            results.append(item)
    return results


def _bag_files(folder: Path) -> list[Path]:
    for ext in (".db3", ".mcap", ".bag"):
        files = sorted(folder.glob(f"*{ext}"))
        if files:
            return files
    return []


def _load_item(folder: Path) -> dict | None:
    metadata_file = folder / "metadata.yaml"
    if not metadata_file.exists():
        return None
    with metadata_file.open() as f:
        meta = yaml.safe_load(f)
    info = meta.get("rosbag2_bagfile_information", {})
    files = _bag_files(folder)
    file_size = files[0].stat().st_size if files else 0
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
    site = SITE_MAP.get(folder.name, "Unknown")
    starting_time = info.get("starting_time", {})
    start_ns = starting_time.get("nanoseconds_since_epoch", 0)
    start_dt = _nanos_to_iso(start_ns)
    file_name = files[0].name if files else ""
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
        "site": site,
        "rosVersion": "ROS 2 Jazzy",
    }


def _nanos_to_iso(nanos: int) -> str:
    sec = nanos / 1_000_000_000
    return datetime.fromtimestamp(sec, tz=UTC).isoformat()


def _sanitize_dataset_id(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r"[^a-zA-Z0-9_-]", "-", stem).strip("-_")
    stem = re.sub(r"-+", "-", stem)
    if not stem:
        stem = "rosbag"
    if not EXPERIMENTS_DIR.exists():
        return stem
    existing = {folder.name for folder in EXPERIMENTS_DIR.iterdir() if folder.is_dir()}
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
        zf.extractall(target)
    metadata = target / "metadata.yaml"
    if metadata.exists():
        return
    nested = [p for p in target.iterdir() if p.is_dir() and (p / "metadata.yaml").exists()]
    if len(nested) == 1:
        for child in nested[0].iterdir():
            shutil.move(str(child), str(target / child.name))
        nested[0].rmdir()


def save_uploaded_rosbag(filename: str, source) -> dict:
    """Persist an uploaded rosbag file (or rosbag2 zip) under data/experiments.

    Args:
        filename: Original upload filename (must end in a supported extension).
        source: Binary file-like object to stream from.

    Returns:
        DatasetItem-shaped dict for the newly stored experiment.

    Raises:
        ValueError: Unsupported extension or unsafe zip content.
    """
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_BAG_EXTENSIONS and suffix != ".zip":
        raise ValueError(f"unsupported file type: {suffix}")

    dataset_id = _sanitize_dataset_id(filename)
    folder = EXPERIMENTS_DIR / dataset_id
    folder.mkdir(parents=True, exist_ok=True)

    try:
        if suffix == ".zip":
            archive = folder / f"{dataset_id}.zip"
            with archive.open("wb") as out:
                shutil.copyfileobj(source, out)
            _extract_zip_safely(archive, folder)
            archive.unlink(missing_ok=True)
            if not (folder / "metadata.yaml").exists():
                bag_files = _bag_files(folder)
                _write_minimal_metadata(folder, bag_files[0].name if bag_files else "rosbag.bag")
        else:
            safe_name = Path(filename).name
            with (folder / safe_name).open("wb") as out:
                shutil.copyfileobj(source, out)
            _write_minimal_metadata(folder, safe_name)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise

    item = _load_item(folder)
    if item is None:
        raise ValueError("uploaded rosbag could not be indexed")
    return item


def delete_experiment(dataset_id: str) -> bool:
    """Remove an experiment folder under data/experiments.

    Returns:
        True if the folder existed and was removed, False otherwise.
    """
    if not dataset_id or dataset_id in {".", ".."}:
        return False
    candidate = Path(dataset_id)
    if candidate.name != dataset_id:
        return False
    folder = EXPERIMENTS_DIR / dataset_id
    if not folder.is_dir():
        return False
    shutil.rmtree(folder)
    return True


def experiment_bag_path(dataset_id: str) -> Path | None:
    """Return the path of the first bag file of an experiment folder.

    Args:
        dataset_id: ID của dataset (tên folder).

    Returns:
        Path tới file bag (.db3/.mcap/.bag) đầu tiên, hoặc None nếu dataset
        không tồn tại hoặc không có file bag.
    """
    if not dataset_id or dataset_id in {".", ".."}:
        return None
    candidate = Path(dataset_id)
    if candidate.name != dataset_id:
        return None
    folder = EXPERIMENTS_DIR / dataset_id
    if not folder.is_dir():
        return None
    files = _bag_files(folder)
    return files[0] if files else None
