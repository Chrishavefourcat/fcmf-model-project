"""Timestamp every exported filename and avoid existing download destinations."""
import re
from datetime import datetime
from pathlib import Path


def timestamped_filename(filename, now=None):
    path = Path(filename)
    if re.search(r"_\d{8}_\d{6}(?:_\d+)?$", path.stem):
        return path.name
    stamp = (now or datetime.now()).strftime("%Y%m%d_%H%M%S")
    return f"{path.stem}_{stamp}{path.suffix}"


def available_download_path(directory, filename):
    path = Path(directory) / timestamped_filename(filename)
    candidate = path
    number = 2
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}_{number}{path.suffix}")
        number += 1
    return candidate
