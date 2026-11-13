"""Source startup defaults, browser opening, error reporting and shutdown."""

import io
import os
import socket
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from rating import launcher


class LauncherTests(unittest.TestCase):
    def test_defaults_do_not_depend_on_working_directory(self):
        with patch.dict(os.environ, {}, clear=True):
            options = launcher.argument_parser().parse_args([])
        self.assertEqual(options.models, "")
        self.assertEqual(options.port, 8765)

    def test_default_start_waits_for_source_without_creating_models(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True), \
                patch.object(launcher, "PROJECT_ROOT", Path(directory)), \
                patch("rating.server.ApplicationServer") as server_type, \
                patch.object(launcher.ConnectionConfig, "validate") as validate:
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(launcher.main(["--no-browser", "--port", "0"]), 0)
            self.assertEqual(server_type.call_args.kwargs["backend"].config.directory, "")
            validate.assert_not_called()
            self.assertFalse(Path(directory, "models").exists())
            self.assertIn("未选择，请在页面点击", output.getvalue())
            server_type.return_value.server_close.assert_called_once()

    def test_command_line_overrides_environment(self):
        with patch.dict(os.environ, {"MODEL_DIRECTORY": "env-models", "PORT": "9000"}):
            parser = launcher.argument_parser()
            defaults = parser.parse_args([])
            options = parser.parse_args(["--models", "cli-models", "--port", "0", "--no-browser"])
        self.assertEqual((defaults.models, defaults.port), ("env-models", 9000))
        self.assertEqual((options.models, options.port, options.no_browser), ("cli-models", 0, True))
        for invalid in ("-1", "65536", "abc"):
            with self.subTest(port=invalid), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parser.parse_args(["--port", invalid])

    def test_browser_start_and_keyboard_interrupt_close_the_service(self):
        with patch("rating.server.ApplicationServer") as server_type, patch.object(launcher.webbrowser, "open") as browser:
            server = server_type.return_value
            server.serve_forever.side_effect = KeyboardInterrupt
            server.browser_url = "http://127.0.0.1:9000/?session=test"
            with redirect_stdout(io.StringIO()):
                result = launcher.main(["--models", str(launcher.PROJECT_ROOT), "--port", "9000"])
            self.assertEqual(result, 0)
            self.assertTrue(server_type.call_args.kwargs["private"])
            browser.assert_called_once_with(server.browser_url, new=2)
            server.server_close.assert_called_once()

    def test_no_browser_and_browser_failure_allow_manual_access(self):
        with patch("rating.server.ApplicationServer") as server_type, patch.object(launcher.webbrowser, "open") as browser:
            server = server_type.return_value
            with redirect_stdout(io.StringIO()):
                self.assertEqual(launcher.main(["--models", str(launcher.PROJECT_ROOT), "--no-browser"]), 0)
            browser.assert_not_called()
            server.server_close.assert_called_once()
            server.reset_mock()
            browser.side_effect = launcher.webbrowser.Error("browser unavailable")
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(launcher.main(["--models", str(launcher.PROJECT_ROOT)]), 0)
            self.assertIn("请复制上面的页面地址", output.getvalue())
            server.serve_forever.assert_called_once()
            server.server_close.assert_called_once()

    def test_unavailable_directory_and_occupied_port_have_clear_errors(self):
        with patch.object(launcher.ConnectionConfig, "validate", side_effect=ValueError("无效模型目录")):
            with redirect_stderr(io.StringIO()) as output:
                self.assertEqual(launcher.main(["--models", "missing-models", "--no-browser"]), 1)
            self.assertIn("无效模型目录", output.getvalue())
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            with redirect_stderr(io.StringIO()) as output:
                self.assertEqual(launcher.main(["--models", str(launcher.PROJECT_ROOT), "--port", str(occupied.getsockname()[1]), "--no-browser"]), 1)
            self.assertIn("--port 0", output.getvalue())


if __name__ == "__main__":
    unittest.main()
