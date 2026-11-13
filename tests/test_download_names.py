import io
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock
from urllib.parse import unquote

import app
from download_names import available_download_path, timestamped_filename


class DownloadNameTests(unittest.TestCase):
    def test_timestamp_and_existing_timestamp_are_preserved(self):
        now = datetime(2026, 10, 21, 9, 5, 7)
        self.assertEqual(timestamped_filename("模型数据录入_2025-12-31.xlsx", now),
                         "模型数据录入_2025-12-31_20261021_090507.xlsx")
        self.assertEqual(timestamped_filename("批量排查_20261021_090507.xlsx", now),
                         "批量排查_20261021_090507.xlsx")

    def test_same_second_download_avoids_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            name = "批量排查_20261021_090507.xlsx"
            (Path(directory) / name).write_bytes(b"original")
            (Path(directory) / "批量排查_20261021_090507_2.xlsx").write_bytes(b"second")
            path = available_download_path(directory, name)
            self.assertEqual(path.name, "批量排查_20261021_090507_3.xlsx")
            self.assertEqual((Path(directory) / name).read_bytes(), b"original")

    def test_all_excel_responses_include_timestamped_unicode_and_fallback_names(self):
        for prefix in ("模型数据录入", "批量排查"):
            handler = MagicMock()
            handler.wfile = io.BytesIO()
            app.xlsx_response(handler, b"workbook", prefix + "_2025-12-31.xlsx")
            headers = dict(call.args for call in handler.send_header.call_args_list)
            disposition = unquote(headers["Content-Disposition"])
            self.assertRegex(disposition, r"filename=fields_\d{8}_\d{6}\.xlsx")
            self.assertRegex(disposition, prefix + r"_2025-12-31_\d{8}_\d{6}\.xlsx")
            self.assertEqual(handler.wfile.getvalue(), b"workbook")
