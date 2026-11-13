"""Default API grades must match the intervals displayed by the rule editor."""
from types import SimpleNamespace
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen

import app
from database import ConnectionConfig, DatabaseBackend
from test_model_selection import create_model


class GradeMatchingTests(unittest.TestCase):
    def engine(self, rows):
        store = SimpleNamespace(grades=rows, base_year=2025)
        return app.ScoreEngine(store, "company", indicators=[])

    def test_default_rules_enforce_lower_upper_and_shared_boundaries(self):
        rows = [
            {"status": "打分映射", "grade": "R2", "threshold": 20, "inclusive": 1},
            {"status": "打分映射", "grade": "R1", "threshold": 10, "inclusive": "1"},
            {"status": "打分映射", "grade": "excluded", "threshold": 5, "inclusive": 0},
            {"status": "人工定位", "grade": "other", "threshold": None, "inclusive": 1},
            {"status": "打分映射", "grade": "出库", "threshold": 150, "inclusive": None},
        ]
        engine = self.engine(rows)
        for score, expected in [(9, "等级匹配异常"), (10, "R1"), (19.9999, "R1"),
                                (20, "R2"), (150, "R2"), (99999, "R2"),
                                (100000, "等级匹配异常"), (float("nan"), "等级匹配异常")]:
            with self.subTest(score=score):
                self.assertEqual(engine.grade(score), expected)
        self.assertEqual(rows[0]["grade"], "R2")  # Sorting must not mutate model data.

    def test_null_threshold_uses_minimum_sentinel_and_empty_rules_do_not_match(self):
        engine = self.engine([{"status": "打分映射", "grade": "R0", "threshold": None, "inclusive": 1}])
        self.assertEqual(engine.grade(-99999), "R0")
        self.assertEqual(engine.grade(-100000), "等级匹配异常")
        self.assertEqual(self.engine([]).grade(10), "等级匹配异常")


class GradeReloadTests(unittest.TestCase):
    def test_model_reload_and_fresh_server_read_external_database_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "grade_reload.db"
            create_model(path, "Initial", 10)

            @contextmanager
            def service():
                server = app.ApplicationServer(("127.0.0.1", 0), backend=DatabaseBackend(ConnectionConfig(directory)))
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                def read_model(endpoint="/api/model"):
                    request = Request(f"http://127.0.0.1:{server.server_port}{endpoint}?database=grade_reload",
                                      headers={"X-Data-Source": server.source_id})
                    with urlopen(request, timeout=10) as response:
                        self.assertEqual(response.headers["Cache-Control"], "no-store")
                        return json.load(response)
                try:
                    yield read_model
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join(timeout=5)

            with service() as read_model:
                self.assertEqual(read_model()["grades"][0]["threshold"], 0)
                self.assertEqual(read_model("/api/grades")["grades"][0]["threshold"], 0)
                with closing(sqlite3.connect(path)) as connection, connection:
                    connection.execute("UPDATE grade SET grade='Updated', threshold=75 WHERE status='打分映射'")
                refreshed = read_model("/api/grades")
                self.assertEqual(Path(refreshed["database_path"]), path)
                current = refreshed["grades"][0]
                self.assertEqual((current["grade"], current["threshold"]), ("Updated", 75))
                self.assertEqual(read_model()["grades"][0]["threshold"], 75)
            with service() as read_model:
                current = read_model()["grades"][0]
                self.assertEqual((current["grade"], current["threshold"]), ("Updated", 75))


if __name__ == "__main__":
    unittest.main()
