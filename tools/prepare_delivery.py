"""Copy runtime source, assets and documentation, with optional example models."""

import argparse
import os
from pathlib import Path
import shutil
import stat
import sys


ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = (
    "app.py", "check_excel.py", "database.py", "download_names.py",
    "excel_styles.py", "final_excel.py", "numeric_precision.py",
    "start.bat", "start.ps1", "python-bootstrap.ps1", "start.sh", "requirements.txt", "README.md",
    "使用说明.txt", "启动依赖与Agent操作清单.md", "Linux兼容性验证记录.md", "Windows启动验证记录.md",
)
SOURCE_TYPES = {
    "rating": {".py", ".ps1", ".cs"},
    "static": {".html", ".css", ".js", ".svg", ".png", ".jpg", ".ico", ".woff", ".woff2"},
}
IGNORED_DIRECTORIES = {"__pycache__", "node_modules", ".venv"}


def is_link(path):
    attributes = path.lstat()
    return stat.S_ISLNK(attributes.st_mode) or bool(
        getattr(attributes, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def source_files(include_models=False):
    for name in ROOT_FILES:
        path = ROOT / name
        if not path.is_file() or is_link(path):
            raise ValueError(f"Required source file is missing or is a link: {path}")
        yield path
    source_types = {**SOURCE_TYPES, **({"models": {".db"}} if include_models else {})}
    for directory, extensions in source_types.items():
        parent = ROOT / directory
        if not parent.is_dir() or is_link(parent):
            raise ValueError(f"Required directory is missing or is a link: {parent}")
        for current, directories, files in os.walk(parent, followlinks=False):
            directories[:] = sorted(name for name in directories if name not in IGNORED_DIRECTORIES)
            for name in directories:
                if is_link(Path(current) / name):
                    raise ValueError(f"Directory links cannot be delivered: {Path(current) / name}")
            for name in sorted(files):
                path = Path(current) / name
                if path.suffix.lower() in extensions:
                    if is_link(path):
                        raise ValueError(f"File links cannot be delivered: {path}")
                    yield path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "交付源码", help="New output directory; existing directories are never overwritten")
    parser.add_argument("--include-models", action="store_true", help="Include optional example models/*.db; users select their own data source by default")
    options = parser.parse_args()
    if sys.version_info < (3, 10):
        parser.error("Python 3.10+ is required")
    destination = options.output.resolve()
    if destination.exists():
        parser.error(f"Output already exists. Choose a new --output directory: {destination}")
    sources = list(source_files(include_models=options.include_models))
    destination.mkdir(parents=True)
    total = 0
    for source in sources:
        target = destination / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        total += source.stat().st_size
    print(f"Delivery: {destination}")
    print(f"Files: {len(sources)}; size: {total / 1024 / 1024:.2f} MiB")


if __name__ == "__main__":
    main()
