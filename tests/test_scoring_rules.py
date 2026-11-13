"""Page-local scoring rules must not alter shared model definitions or files."""
import io
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from openpyxl import load_workbook

import test_data_entry as fixtures
import app


class ScoringRuleTests(unittest.TestCase):
    setUp = fixtures.DataEntryTests.setUp
    tearDown = fixtures.DataEntryTests.tearDown

    def test_rules_recompute_scores_and_grade_without_mutating_original_model(self):
        self.store.grades = [{"status": "打分映射", "grade": "Low", "threshold": 0, "inclusive": 1},
                             {"status": "打分映射", "grade": "High", "threshold": 55, "inclusive": 1}]
        original = [dict(indicator) for indicator in self.store.indicators]
        before = app.ScoreEngine(self.store, "shared", "2025-12-31").score()
        rules = {"A": {"expression": "metric * 2", "weight": 0.25}}
        preview = app.scoring_preview(self.store, ["shared"], "2025-12-31", rules=rules)
        score = preview["results"]["shared"]
        self.assertEqual((before["total_score"], before["grade"]), (58, "High"))
        self.assertEqual((score["total_score"], score["grade"]), (52, "Low"))
        self.assertEqual((score["details"][0]["score"], score["details"][0]["weighted_score"]), (20, 5))
        self.assertEqual(self.store.indicators, original)
        self.assertEqual(app.ScoreEngine(self.store, "shared", "2025-12-31").score()["total_score"], 58)

    def test_rule_new_dependencies_are_reflected_in_data_entry_layout(self):
        preview = app.scoring_preview(self.store, ["shared"], "2025-12-31", rules={"A": {"expression": "unused + metric"}})
        columns = preview["field_matrix"]["columns"]
        self.assertEqual([column["field_id"] for column in columns[:2]], ["unused", "metric"])
        self.assertEqual(columns[2]["indicator_id"], "A")
        self.assertNotIn("unused", [f["field_id"] for f in self.store.scoring_fields()])

    def test_export_uses_page_rules_and_contains_values_and_metadata(self):
        rules = {"A": {"expression": "metric * 2", "weight": 0.25}}
        wb = load_workbook(io.BytesIO(app.export_fields_xlsx(self.store, ["shared"], "2025-12-31", rule_overrides=rules)))
        self.addCleanup(wb.close)
        ws = wb["数据录入"]
        values = {ws.cell(2, col).value: ws.cell(3, col).value for col in range(1, ws.max_column + 1)}
        self.assertEqual(values["indicator:A:raw"], 20)
        self.assertEqual(ws.cell(1, list(values).index("indicator:A:raw") + 1).comment.text, "metric * 2")
        self.assertNotIn("indicator:A", values)
        self.assertNotIn("indicator:A:weighted", values)
        self.assertEqual(wb["指标信息"]["D2"].value, 0.25)
        self.assertEqual(wb["指标信息"]["E2"].value, "metric * 2")
        wb.active = 1
        out = io.BytesIO()
        wb.save(out)
        imported = app.import_fields_xlsx(self.store, out.getvalue())["overrides"]["shared"]
        self.assertNotIn("indicator:A", imported)
        self.assertIn("metric", imported)

    def test_invalid_or_readonly_rule_edits_are_rejected(self):
        invalid = [{"unknown": {"weight": 1}}, {"A": {"label": "renamed"}}, {"A": {"field_id": "input_b"}},
                   {"A": {"weight": ""}}, {"A": {"weight": -1}}, {"A": {"weight": "NaN"}},
                   {"A": {"weight": "Infinity"}}]
        for expression in ["metric +", "unknown_field + 1", "unknown_function(metric)", "metric 2", "sum(metric input_b)",
                           "linear(metric)", "metric + )", "metric;1", "case(metric>2,1,else)"]:
            invalid.append({"A": {"expression": expression}})
        for rules in invalid:
            with self.subTest(rules=rules), self.assertRaises(ValueError):
                app.resolve_rules(self.store, rules)

    def test_http_rules_are_request_local_and_validation_does_not_change_scores(self):
        server = app.ApplicationServer(("127.0.0.1", 0), backend=self.store.backend)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def post(path, payload):
                req = Request(f"http://127.0.0.1:{server.server_port}{path}?database=entry", data=json.dumps(payload).encode(),
                              headers={"X-Data-Source": server.source_id})
                with urlopen(req, timeout=10) as response:
                    return json.load(response)
            result = post("/api/rules-preview", {"company_ids": ["shared"], "period": "2025-12-31", "rules": {"A": {"expression": "metric * 2", "weight": 0.25}}})
            self.assertEqual(result["results"]["shared"]["total_score"], 52)
            normal = post("/api/score-preview", {"company_id": "shared", "period": "2025-12-31"})
            self.assertEqual(normal["total_score"], 58)
            with self.assertRaises(HTTPError) as error:
                post("/api/rules-preview", {"rules": {"A": {"expression": "metric +"}}})
            self.assertEqual(error.exception.code, 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
