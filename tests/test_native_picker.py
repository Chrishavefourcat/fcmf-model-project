"""Native chooser cancellation, lifecycle and private HTTP integration."""

import json
import sys
import threading
import unittest
from http.cookiejar import CookieJar
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

from rating.native_picker import NativeSourcePicker
from rating.server import ApplicationServer


class NativePickerTests(unittest.TestCase):
    def test_selection_preserves_unicode_paths_as_arguments(self):
        picker = NativeSourcePicker()
        selected = 'E:\\模型 文件 #\\单个.DB'
        process = MagicMock(returncode=0)
        process.communicate.return_value = (json.dumps({"path": selected}), "")
        with patch.object(sys, "platform", "win32"), patch("rating.native_picker.subprocess.Popen", return_value=process) as spawn:
            self.assertEqual(picker.choose("file", selected), {"path": selected, "kind": "file"})
        command = spawn.call_args.args[0]
        self.assertEqual(command[-4:], ["-Kind", "file", "-InitialPath", selected])
        self.assertNotIn("shell", spawn.call_args.kwargs)
        self.assertIn("-STA", command)
        picker.close()

    def test_cancel_errors_and_invalid_arguments_release_chooser(self):
        picker = NativeSourcePicker()
        process = MagicMock(returncode=0)
        with patch.object(sys, "platform", "win32"), patch("rating.native_picker.subprocess.Popen", return_value=process) as spawn:
            for kind, path in [("bad", ""), ("file", None)]:
                with self.assertRaises(ValueError):
                    picker.choose(kind, path)
            spawn.assert_not_called()
            process.communicate.return_value = ('{"cancelled":true}', "")
            self.assertEqual(picker.choose("directory"), {"cancelled": True})
            for output in ["", "not-json", "[]", '{"path":""}']:
                process.communicate.return_value = (output, "")
                with self.assertRaises(ValueError):
                    picker.choose("directory")
            process.returncode = 1
            with self.assertRaises(ValueError):
                picker.choose("file")
            process.returncode = 0
            process.communicate.return_value = ('{"cancelled":true}', "")
            self.assertEqual(picker.choose("file"), {"cancelled": True})
        picker.close()

    def test_running_dialog_is_unique_and_closes_with_server(self):
        picker = NativeSourcePicker()
        entered, released = threading.Event(), threading.Event()
        process = MagicMock(returncode=0)
        process.poll.return_value = None
        process.terminate.side_effect = released.set

        def wait_for_dialog():
            entered.set()
            if not released.wait(3):
                raise RuntimeError("Dialog was not closed")
            return '{"cancelled":true}', ""

        process.communicate.side_effect = wait_for_dialog
        results = []
        with patch.object(sys, "platform", "win32"), patch("rating.native_picker.subprocess.Popen", return_value=process):
            worker = threading.Thread(target=lambda: results.append(picker.choose("directory")))
            worker.start()
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ValueError, "已打开"):
                picker.choose("file")
            picker.close()
            worker.join(3)
            self.assertFalse(worker.is_alive())
            process.terminate.assert_called_once()
            self.assertEqual(results, [{"cancelled": True}])
            with self.assertRaisesRegex(ValueError, "已停止"):
                picker.choose("file")


class BrowseApiTests(unittest.TestCase):
    def test_private_browse_only_returns_a_path_without_switching_data(self):
        server = ApplicationServer(("127.0.0.1", 0), private=True)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"
        chooser = server.source_picker.choose = MagicMock(return_value={"path": "E:/models/test.DB", "kind": "file"})
        original_source = server.source_info()

        def request(payload):
            return Request(base + "/api/data-source/browse", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})

        try:
            with self.assertRaises(HTTPError) as error:
                urlopen(request({"kind": "file"}), timeout=5)
            self.assertEqual(error.exception.code, 401)
            chooser.assert_not_called()
            opener = build_opener(HTTPCookieProcessor(CookieJar()))
            opener.open(server.browser_url, timeout=5).close()
            payload = {"kind": "file", "initial_path": "E:/models"}
            with opener.open(request(payload), timeout=5) as response:
                self.assertEqual(json.load(response), {"path": "E:/models/test.DB", "kind": "file"})
            chooser.assert_called_once_with("file", "E:/models")
            self.assertEqual(server.source_info(), original_source)
            chooser.return_value = {"cancelled": True}
            with opener.open(request({"kind": "directory"}), timeout=5) as response:
                self.assertEqual(json.load(response), {"cancelled": True})
            self.assertEqual(server.source_info(), original_source)
            with self.assertRaises(HTTPError) as error:
                opener.open(request([]), timeout=5)
            self.assertEqual(error.exception.code, 400)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(3)


if __name__ == "__main__":
    unittest.main()
