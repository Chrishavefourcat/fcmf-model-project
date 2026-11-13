"""Shared paths and environment defaults for source-based startup."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
DB_NAME = os.environ.get("DB_NAME", "")
