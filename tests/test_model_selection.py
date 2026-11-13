"""SQLite file discovery, source switching, persistence and HTTP integration."""
import io
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from database import ConnectionConfig, DatabaseBackend


def create_model(path, label, value):
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.executescript("""
            CREATE TABLE company (company_id TEXT PRIMARY KEY,company_name TEXT,bond_id TEXT,remark TEXT,update_time TEXT);
            CREATE TABLE field (field_id TEXT PRIMARY KEY,label TEXT,field_type TEXT,value_type TEXT,unit TEXT,expression TEXT,default_value TEXT);
            CREATE TABLE field_value (company_id TEXT,field_id TEXT,period_end TEXT,field_value TEXT,update_time TEXT,skip_expression INTEGER,remark TEXT);
            CREATE TABLE indicator (indicator_id TEXT PRIMARY KEY,label TEXT,field_id TEXT,weight REAL,expression TEXT,score_min REAL,score_max REAL,rounding INTEGER,remark TEXT,update_time TEXT);
            CREATE TABLE grade (status TEXT,grade TEXT,threshold REAL,inclusive INTEGER,remark TEXT);
            CREATE TABLE model (model_id TEXT,model_name TEXT,base_year INTEGER,update_time TEXT);
        """)
        connection.execute("INSERT INTO company VALUES (?,?,?,?,?)", ("shared", f"Company {label}", "bond", None, None))
        connection.execute("INSERT INTO field VALUES (?,?,?,?,?,?,?)", ("metric", "Metric", "打分项", "number", "", "", ""))
        connection.execute("INSERT INTO field_value VALUES (?,?,?,?,?,?,?)", ("shared", "metric", "2025-12-31", str(value), "", 0, ""))
        connection.execute("INSERT INTO indicator VALUES (?,?,?,?,?,?,?,?,?,?)", ("score", "Score", "metric", 1, "", 0, 100, 2, "", ""))
        connection.execute("INSERT INTO grade VALUES (?,?,?,?,?)", ("打分映射", label, 0, 1, ""))
        connection.executemany("INSERT INTO model VALUES (?,?,?,?)", [("latest", f"Model {label}", 2025, "2026-10-15"), ("older", "Old model", 2024, "2020-01-01")])


class ModelSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name) / "模型 文件 #"
        cls.directory.mkdir()
        create_model(cls.directory / "a_model.db", "A", 12)
        create_model(cls.directory / "b_model.db", "B", 77)
        create_model(cls.directory / "plain.db", "Plain", 99)
        create_model(cls.directory / "ignored.sqlite", "Ignored", 99)
        (cls.directory / "folder.db").mkdir()
        cls.backend = DatabaseBackend(ConnectionConfig(str(cls.directory)))
        cls.server = app.ApplicationServer(("127.0.0.1", 0), backend=cls.backend)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.stop_server)

    @classmethod
    def stop_server(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, path, database=None, payload=None, raw=None, source_id=None):
        if database is not None:
            path += ("&" if "?" in path else "?") + urlencode({"database": database})
        data = json.dumps(payload).encode() if payload is not None else raw
        headers = {"Content-Type": "application/json", "X-Data-Source": self.server.source_id if source_id is None else source_id}
        with urlopen(Request(self.base + path, data=data, headers=headers), timeout=20) as response:
            body = response.read()
            return json.loads(body) if "application/json" in response.headers.get("Content-Type", "") else body

    def test_discovery_latest_record_and_new_file_without_restart(self):
        selected = self.request("/api/model", "a_model")
        self.assertTrue(all("inclusive" in row for row in selected["grades"]))
        self.assertEqual(selected["model_name"], "Model A")
        with patch.object(self.server.backend, "rows", wraps=self.server.backend.rows) as queries:
            models = self.request("/api/models")["models"]
        self.assertTrue(queries.call_count)
        self.assertTrue(all("model_name" not in call.args[0].lower() for call in queries.call_args_list))
        self.assertEqual({model["database"] for model in models}, {"a_model", "b_model", "plain"})
        self.assertEqual(next(model for model in models if model["database"] == "a_model")["file_name"], "a_model.db")
        self.assertTrue(all("model_name" not in model for model in models))
        path = self.directory / "任意名称.DB"
        try:
            create_model(path, "New", 22)
            self.assertIn("任意名称", [model["database"] for model in self.request("/api/models")["models"]])
        finally:
            path.unlink()

    def test_select_all_companies_includes_matches_beyond_preview_limit(self):
        path = self.directory / "bulk.db"
        create_model(path, "Bulk", 10)
        try:
            with closing(sqlite3.connect(path)) as connection, connection:
                connection.executemany(
                    "INSERT INTO company VALUES (?,?,?,?,?)",
                    [(f"bulk-{i:03d}", f"Bulk Company {i:03d}", f"BOND-{i:03d}", None, None) for i in range(125)],
                )
            self.assertEqual(len(self.request("/api/companies", "bulk")), 80)
            companies = self.request("/api/companies?all=1", "bulk")
            self.assertEqual(len(companies), 126)
            self.assertEqual(len({company["company_id"] for company in companies}), 126)
            matches = self.request("/api/companies?all=1&q=BOND-124", "bulk")
            self.assertEqual([company["company_id"] for company in matches], ["bulk-124"])
        finally:
            path.unlink(missing_ok=True)

    def test_same_model_names_keep_file_identity_and_data_separate(self):
        paths = [self.directory / "同名 模型 A.db", self.directory / "同名 模型 B.DB"]
        try:
            for path, value in zip(paths, [17, 93]):
                create_model(path, "Same", value)
            models = {model["database"]: model for model in self.request("/api/models")["models"]}
            for path, value in zip(paths, [17, 93]):
                metadata = models[path.stem]
                self.assertNotIn("model_name", metadata)
                self.assertEqual(metadata["file_name"], path.name)
                self.assertEqual(metadata["database_path"], str(path.resolve()))
                selected = self.request("/api/model", path.stem)
                self.assertEqual(selected["database_path"], metadata["database_path"])
                score = self.request("/api/score?company_id=shared&period=2025-12-31", path.stem)
                self.assertEqual(score["total_score"], value)
            with closing(sqlite3.connect(paths[0])) as connection, connection:
                connection.execute("UPDATE model SET model_name='Renamed model' WHERE model_id='latest'")
            refreshed = {model["database"]: model for model in self.request("/api/models")["models"]}
            self.assertEqual(refreshed[paths[0].stem]["file_name"], paths[0].name)
            self.assertEqual(refreshed[paths[1].stem]["file_name"], paths[1].name)
            self.assertEqual(self.request("/api/model", paths[0].stem)["model_name"], "Renamed model")
        finally:
            for path in paths:
                path.unlink(missing_ok=True)

    def test_invalid_names_and_missing_files_never_create_databases(self):
        for database in ["ignored", "missing_model", "", "../a_model", "bad' OR 1=1_model"]:
            with self.assertRaises(HTTPError) as error:
                self.request("/api/companies", database)
            self.assertEqual(error.exception.code, 400)
        self.assertFalse((self.directory / "missing_model.db").exists())

    def test_parallel_models_keep_values_and_grades_isolated(self):
        def check(index):
            database, label, value = [("a_model", "A", 12), ("b_model", "B", 77), ("plain", "Plain", 99)][index % 3]
            self.assertEqual(self.request("/api/companies", database)[0]["company_name"], f"Company {label}")
            score = self.request("/api/score?company_id=shared&period=2025-12-31", database)
            self.assertEqual((score["total_score"], score["grade"]), (value, label))
            preview = self.request("/api/score-preview", database, {"company_id": "shared", "period": "2025-12-31", "overrides": {"metric": 33}})
            self.assertEqual((preview["total_score"], preview["grade"]), (33, label))
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(check, range(12)))

    def test_writes_nulls_export_and_import_use_selected_file(self):
        from openpyxl import load_workbook
        try:
            self.request("/api/value", "a_model", {"company_id": "shared", "field_id": "metric", "value": "34", "period": "2025-12-31"})
            self.request("/api/indicator", "a_model", {"indicator_id": "score", "weight": 0.5})
            self.assertEqual(self.request("/api/score?company_id=shared&period=2025-12-31", "a_model")["total_score"], 17)
            self.assertEqual(self.request("/api/score?company_id=shared&period=2025-12-31", "b_model")["total_score"], 77)
            original = self.request("/api/table?name=company", "a_model")["rows"][0]
            self.request("/api/table/update", "a_model", {"table": "company", "original": original, "row": {"company_name": "Edited A"}})
            self.assertEqual(self.request("/api/companies", "a_model")[0]["company_name"], "Edited A")
            self.assertEqual(self.request("/api/companies", "b_model")[0]["company_name"], "Company B")
            self.request("/api/table/insert", "a_model", {"table": "company", "row": {"company_id": "temporary", "company_name": "Temporary"}})
            self.assertEqual(self.request("/api/companies?q=temporary", "b_model"), [])
            self.request("/api/table/delete", "a_model", {"table": "company", "original": {"company_id": "temporary"}})
            self.assertEqual(self.request("/api/companies?q=temporary", "a_model"), [])
            exported = self.request("/api/export-fields", "a_model", {"company_ids": ["shared"], "period": "2025-12-31"})
            sheet = load_workbook(io.BytesIO(exported)).active
            self.assertEqual((sheet.cell(3, 2).value, sheet.cell(3, 3).value), ("Edited A", 34))
            imported = self.request("/api/import-fields", "a_model", raw=exported)
            self.assertEqual(imported["overrides"]["shared"]["metric"], "34")
        finally:
            with closing(sqlite3.connect(self.directory / "a_model.db")) as connection, connection:
                connection.executescript("UPDATE company SET company_name='Company A' WHERE company_id='shared'; UPDATE field_value SET field_value='12'; UPDATE indicator SET weight=1;")
            self.request("/api/reload", "a_model")

    def test_folder_switch_empty_and_stale_request(self):
        original_id = self.server.source_id
        other = Path(self.temporary.name) / "other"
        other.mkdir(exist_ok=True)
        create_model(other / "a_model.db", "Other", 44)
        try:
            selected = self.request("/api/data-source/select", payload={"directory": str(other)})
            self.assertEqual(selected["source_kind"], "directory")
            self.assertNotEqual(selected["source_id"], original_id)
            self.assertEqual([model["database"] for model in selected["models"]], ["a_model"])
            self.assertEqual([model["database"] for model in self.request("/api/models")["models"]], ["a_model"])
            self.assertEqual(self.request("/api/companies", "a_model")[0]["company_name"], "Company Other")
            with self.assertRaises(HTTPError) as missing:
                self.request("/api/companies", "b_model")
            self.assertEqual(missing.exception.code, 400)
            for payload in [None, {"company_id": "shared", "field_id": "metric", "value": "99"}]:
                with self.assertRaises(HTTPError) as error:
                    self.request("/api/value" if payload else "/api/companies", "a_model", payload, source_id=original_id)
                self.assertEqual(error.exception.code, 409)
            empty = other / "empty"
            empty.mkdir()
            self.assertEqual(self.request("/api/data-source/select", payload={"directory": str(empty)})["models"], [])
        finally:
            self.server.replace_source(str(self.directory))

    def test_single_file_source_reads_exports_and_writes_only_selected_db(self):
        from openpyxl import load_workbook

        directory = Path(self.temporary.name) / "单文件 数据源 #"
        directory.mkdir()
        selected_path = directory / "独立 模型.DB"
        sibling_path = directory / "同目录另一个模型.db"
        create_model(selected_path, "Selected", 26)
        create_model(sibling_path, "Sibling", 88)
        sibling_bytes = sibling_path.read_bytes()
        previous_id = self.server.source_id
        try:
            selected = self.request("/api/data-source/select", payload={"directory": str(selected_path)})
            self.assertEqual(selected["directory"], str(selected_path.resolve()))
            self.assertEqual(selected["source_kind"], "file")
            self.assertNotEqual(selected["source_id"], previous_id)
            self.assertEqual([model["database"] for model in selected["models"]], [selected_path.stem])
            self.assertEqual(selected["models"][0]["database_path"], str(selected_path.resolve()))
            self.assertEqual(self.request("/api/model", selected_path.stem)["model_name"], "Model Selected")
            self.assertEqual(self.request("/api/score?company_id=shared&period=2025-12-31", selected_path.stem)["total_score"], 26)
            for path, payload in [("/api/companies", None), ("/api/value", {"company_id": "shared", "field_id": "metric", "value": "99"})]:
                with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                    self.request(path, sibling_path.stem, payload)
                self.assertEqual(error.exception.code, 400)
            for path, payload in [("/api/companies", None), ("/api/value", {"company_id": "shared", "field_id": "metric", "value": "99"})]:
                with self.subTest(stale_path=path), self.assertRaises(HTTPError) as error:
                    self.request(path, selected_path.stem, payload, source_id=previous_id)
                self.assertEqual(error.exception.code, 409)
            self.request("/api/value", selected_path.stem, {"company_id": "shared", "field_id": "metric", "value": "37", "period": "2025-12-31"})
            exported = self.request("/api/export-fields", selected_path.stem, {"company_ids": ["shared"], "period": "2025-12-31"})
            sheet = load_workbook(io.BytesIO(exported)).active
            self.assertEqual((sheet.cell(3, 2).value, sheet.cell(3, 3).value), ("Company Selected", 37))
            self.assertEqual(self.request("/api/import-fields", selected_path.stem, raw=exported)["overrides"]["shared"]["metric"], "37")
            self.request("/api/reload", selected_path.stem)
            refreshed = self.request("/api/models")
            self.assertEqual(refreshed["source_kind"], "file")
            self.assertEqual(refreshed["directory"], str(selected_path.resolve()))
            self.assertEqual([model["database"] for model in refreshed["models"]], [selected_path.stem])
            self.assertEqual(self.request("/api/data-source")["source_kind"], "file")
            with closing(sqlite3.connect(selected_path)) as connection:
                self.assertEqual(connection.execute("SELECT field_value FROM field_value").fetchone()[0], "37")
            self.assertEqual(sibling_path.read_bytes(), sibling_bytes)
        finally:
            self.server.replace_source(str(self.directory))

    def test_blank_nonstring_and_missing_folder_keep_current_source(self):
        previous_id = self.server.source_id
        for payload in [{}, {"directory": ""}, {"directory": " \t\n "},
                        {"directory": None}, {"directory": 123}, {"directory": []},
                        {"directory": str(self.directory / "missing")},
                        {"directory": str(self.directory / "missing.db")},
                        {"directory": str(self.directory / "ignored.sqlite")}, []]:
            with self.subTest(payload=payload):
                with self.assertRaises(HTTPError) as error:
                    self.request("/api/data-source/select", payload=payload)
                self.assertEqual(error.exception.code, 400)
                self.assertEqual(self.server.source_id, previous_id)
                self.assertEqual(self.server.backend.config.directory, str(self.directory))
        self.assertEqual(self.request("/api/companies", "a_model")[0]["company_name"], "Company A")
        self.assertFalse((self.directory / "missing.db").exists())

    def test_invalid_file_selection_keeps_previous_single_file_source(self):
        selected_path = self.directory / "a_model.db"
        broken_path = Path(self.temporary.name) / "broken.db"
        broken_path.write_text("not a database", encoding="utf-8")
        try:
            self.server.replace_source(str(selected_path))
            previous_id = self.server.source_id
            for invalid_path in [self.directory / "missing.db", self.directory / "ignored.sqlite", broken_path]:
                with self.subTest(path=invalid_path), self.assertRaises(HTTPError):
                    self.request("/api/data-source/select", payload={"directory": str(invalid_path)})
                source = self.request("/api/data-source")
                self.assertEqual(source["source_id"], previous_id)
                self.assertEqual(source["directory"], str(selected_path.resolve()))
                self.assertEqual(source["source_kind"], "file")
                self.assertEqual([model["database"] for model in self.request("/api/models")["models"]], ["a_model"])
            self.assertFalse((self.directory / "missing.db").exists())
        finally:
            self.server.replace_source(str(self.directory))

    def test_failed_upsert_rolls_back_deleted_value(self):
        with closing(sqlite3.connect(self.directory / "a_model.db")) as connection, connection:
            connection.execute("CREATE TRIGGER fail_insert BEFORE INSERT ON field_value WHEN NEW.field_value='boom' BEGIN SELECT RAISE(ABORT,'test failure'); END")
        try:
            with self.assertRaises(HTTPError):
                self.request("/api/value", "a_model", {"company_id": "shared", "field_id": "metric", "value": "boom", "period": "2025-12-31"})
            with closing(sqlite3.connect(self.directory / "a_model.db")) as connection, connection:
                self.assertEqual(connection.execute("SELECT field_value FROM field_value").fetchone()[0], "12")
        finally:
            with closing(sqlite3.connect(self.directory / "a_model.db")) as connection, connection:
                connection.execute("DROP TRIGGER fail_insert")

    def test_invalid_source_keeps_previous_folder(self):
        previous_id = self.server.source_id
        with tempfile.TemporaryDirectory() as invalid:
            Path(invalid, "broken_model.db").write_text("not a database", encoding="utf-8")
            with self.assertRaises(HTTPError):
                self.request("/api/data-source/select", payload={"directory": invalid})
        self.assertEqual(self.server.source_id, previous_id)
        self.assertEqual(self.server.backend.config.directory, str(self.directory))
        self.assertEqual(self.request("/api/companies", "a_model")[0]["company_name"], "Company A")

    def test_duplicate_rows_without_primary_key_update_only_one(self):
        try:
            for _ in range(2):
                self.request("/api/table/insert", "a_model", {"table": "grade", "row": {"status": "test", "grade": "duplicate", "threshold": 88}})
            self.request("/api/table/update", "a_model", {"table": "grade", "original": {"grade": "duplicate"}, "row": {"grade": "changed"}})
            rows = self.request("/api/table?name=grade", "a_model")["rows"]
            self.assertEqual(sum(row["grade"] == "duplicate" for row in rows), 1)
            self.assertEqual(sum(row["grade"] == "changed" for row in rows), 1)
        finally:
            with closing(sqlite3.connect(self.directory / "a_model.db")) as connection, connection:
                connection.execute("DELETE FROM grade WHERE status='test'")
            self.request("/api/reload", "a_model")

    def test_private_browser_session_requires_bootstrap(self):
        server = app.ApplicationServer(("127.0.0.1", 0), private=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(HTTPError) as error:
                urlopen(f"http://127.0.0.1:{server.server_port}/api/models")
            self.assertEqual(error.exception.code, 401)
            with self.assertRaises(HTTPError) as error:
                request = Request(f"http://127.0.0.1:{server.server_port}/api/data-source/select",
                                  data=json.dumps({"directory": str(self.directory / "a_model.db")}).encode(),
                                  headers={"Content-Type": "application/json"})
                urlopen(request)
            self.assertEqual(error.exception.code, 401)
            self.assertEqual(server.backend.config.directory, "")
            opener = build_opener(HTTPCookieProcessor(CookieJar()))
            self.assertEqual(opener.open(server.browser_url).status, 200)
            self.assertEqual(json.load(opener.open(f"http://127.0.0.1:{server.server_port}/api/models"))["models"], [])
            request = Request(f"http://127.0.0.1:{server.server_port}/api/data-source/select",
                              data=json.dumps({"directory": str(self.directory / "a_model.db")}).encode(),
                              headers={"Content-Type": "application/json"})
            selected = json.load(opener.open(request))
            self.assertEqual(selected["source_kind"], "file")
            self.assertEqual([model["database"] for model in selected["models"]], ["a_model"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
