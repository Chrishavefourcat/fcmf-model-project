#!/bin/sh
# Prepare and run the source application on Linux/macOS with Python 3.10+.
set -eu

task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_root"
task_venv_python="$task_root/.venv/bin/python"
task_check_only=false
if [ "${1:-}" = '--check-only' ]; then
    task_check_only=true
    shift
fi

task_supported_python() {
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

if [ ! -x "$task_venv_python" ]; then
    if [ -e "$task_root/.venv" ]; then
        echo 'The existing .venv is not usable on this system. Move it aside and rerun.' >&2
        exit 1
    fi
    task_interpreter=${PYTHON:-}
    if [ -n "$task_interpreter" ]; then
        if ! task_supported_python "$task_interpreter"; then
            echo 'The specified PYTHON cannot run or is older than 3.10.' >&2
            exit 1
        fi
    else
        for task_candidate in python3 python; do
            if command -v "$task_candidate" >/dev/null 2>&1 && task_supported_python "$task_candidate"; then
                task_interpreter=$task_candidate
                break
            fi
        done
    fi
    if [ -z "$task_interpreter" ]; then
        echo 'Python 3.10+ was not found. Install Python with pip and venv; see the startup dependency checklist.' >&2
        exit 1
    fi
    if ! "$task_interpreter" -m venv "$task_root/.venv"; then
        echo 'Cannot create .venv. On Debian/Ubuntu install the matching python3-venv package.' >&2
        exit 1
    fi
fi

if ! task_supported_python "$task_venv_python"; then
    echo 'The existing .venv requires a working Python 3.10+. Move it aside and recreate it.' >&2
    exit 1
fi

task_requirement_file="$task_root/requirements.txt"
task_marker_file="$task_root/.venv/requirements.sha256"
task_requirement_hash=$("$task_venv_python" -c 'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest().upper())' "$task_requirement_file")
task_installed_hash=''
if [ -f "$task_marker_file" ]; then
    task_installed_hash=$(tr -d '\r\n' < "$task_marker_file")
fi

task_dependencies_ready() {
    "$task_venv_python" - "$task_requirement_file" <<'PY'
import sys
try:
    import sqlite3, sqlalchemy, openpyxl
    from importlib.metadata import version
    from pathlib import Path
    for line in Path(sys.argv[1]).read_text(encoding='utf-8-sig').splitlines():
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        name, expected = line.split('==', 1)
        if version(name.strip()) != expected.strip():
            raise ValueError('Dependency version mismatch')
except Exception:
    sys.exit(1)
PY
}

if [ "$task_installed_hash" != "$task_requirement_hash" ] || ! task_dependencies_ready; then
    if ! "$task_venv_python" -m pip --version >/dev/null 2>&1; then
        "$task_venv_python" -m ensurepip --upgrade
    fi
    "$task_venv_python" -m pip install -r "$task_requirement_file"
    if ! task_dependencies_ready; then
        echo 'Dependency verification failed. See requirements.txt and the startup dependency checklist.' >&2
        exit 1
    fi
    printf '%s\n' "$task_requirement_hash" > "$task_marker_file"
fi

"$task_venv_python" -c "import sys, sqlalchemy, openpyxl; print('Python ' + sys.version.split()[0]); print('SQLAlchemy ' + sqlalchemy.__version__ + ', openpyxl ' + openpyxl.__version__)"
if [ "$task_check_only" = true ]; then
    echo 'Environment ready. Run sh start.sh to launch the application.'
    exit 0
fi
exec "$task_venv_python" -X utf8 "$task_root/app.py" "$@"
