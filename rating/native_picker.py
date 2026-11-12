"""Small Windows system dialogs without an embedded browser or GUI dependency."""

import json
import subprocess
import sys
from pathlib import Path
from threading import Lock


class NativeSourcePicker:
    def __init__(self):
        self._lock = Lock()
        self._process = None
        self._closed = False

    def choose(self, kind, initial_path=""):
        if kind not in ("directory", "file"):
            raise ValueError("请选择文件夹或 DB 文件")
        if not isinstance(initial_path, str):
            raise ValueError("初始路径必须是文本")
        if sys.platform != "win32":
            raise ValueError("当前系统不支持此选择窗口，请直接输入文件夹或 DB 文件路径")
        command = [
            "powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
            "-File", str(Path(__file__).with_name("source_picker.ps1")),
            "-Kind", kind,
        ]
        if initial_path.strip():
            command.extend(["-InitialPath", initial_path.strip()])
        with self._lock:
            if self._closed:
                raise ValueError("服务已停止，请重新启动程序")
            if self._process is not None:
                raise ValueError("选择窗口已打开，请先完成或取消当前选择")
            try:
                process = subprocess.Popen(
                    command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    encoding="utf-8-sig", errors="replace",
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except OSError as error:
                raise ValueError("无法打开系统选择窗口，请直接输入路径") from error
            self._process = process
        try:
            output, _ = process.communicate()
            if process.returncode:
                raise ValueError("系统选择窗口未能完成，请重试或直接输入路径")
            try:
                result = json.loads(output)
            except (TypeError, ValueError) as error:
                raise ValueError("无法读取系统选择结果，请重试") from error
            if not isinstance(result, dict):
                raise ValueError("系统选择结果无效，请重试")
            if result.get("cancelled") is True:
                return {"cancelled": True}
            path = result.get("path")
            if not isinstance(path, str) or not path.strip():
                raise ValueError("系统选择结果无效，请重试")
            return {"path": path, "kind": kind}
        finally:
            with self._lock:
                if self._process is process:
                    self._process = None

    def close(self):
        with self._lock:
            self._closed = True
            process = self._process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
