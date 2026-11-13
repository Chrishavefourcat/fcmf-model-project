"""Expression-driven inputs, indicator previews and Excel round trips."""
import hashlib
import io
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from openpyxl import Workbook, load_workbook

from test_model_selection import create_model
import app
from database import ConnectionConfig, DatabaseBackend


class DataEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "entry.db"
        create_model(self.path, "Entry", 10)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            fields = [
                ("input_b", "源数据B", "打分项", "number", "", "", ""),
                ("entity_level", "层级", "文本", "文本", "", "", ""),
                ("fallback", "无表达式输入", "打分项", "number", "", "", ""),
                ("computed", "有字段公式的输入", "打分项", "number", "", "metric * 2", ""),
                ("unused", "不应出现的字段", "打分项", "number", "", "", ""),
                ("check_raw", "排查源数据", "排查项", "number", "", "", "3"),
            ]
            connection.executemany("INSERT INTO field VALUES (?,?,?,?,?,?,?)", fields)
            connection.execute("DELETE FROM indicator")
            for iid, fid, expression, weight in [
                ("A", "metric", "metric + input_b + metric", 0.5),
                ("B", "entity_level", 'case(entity_level="unused", metric * 2, else, input_b)', 1),
                ("C", "fallback", "", 1),
                ("D", "unused", "5", 1),
                ("E", "computed", "computed + input_b", 1),
                ("X", "check_raw", "check_raw", 1),
            ]:
                connection.execute("INSERT INTO indicator VALUES (?,?,?,?,?,?,?,?,?,?)", (iid, "指标" + iid, fid, weight, expression, 0, 100, 2, "", ""))
            connection.executemany("INSERT INTO field_value VALUES (?,?,?,?,?,?,?)", [
                ("shared", "input_b", "2025-12-31", "2", "", 0, ""),
                ("shared", "input_b", "2024-12-31", "99", "", 0, ""),
                ("shared", "entity_level", "", "unused", "", 0, ""),
                ("shared", "fallback", "", "0", "", 0, ""),
                ("shared", "check_raw", "2025-12-31", "0", "", 0, ""),
                ("shared", "original_grade", "", "R4+", "", 0, ""),
                ("shared", "original_grade", "2024-12-31", "R5", "", 0, ""),
            ])
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.store = app.DataStore("entry", DatabaseBackend(ConnectionConfig(self.temp.name)))

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), self.digest)

    def test_inputs_follow_expression_order_are_unique_and_ignore_quoted_literals(self):
        columns = self.store.data_entry_columns()
        actual = [column["field_id"] if column["kind"] == "source" else column["indicator_id"] for column in columns]
        self.assertEqual(actual, ["metric", "input_b", "A", "entity_level", "B", "fallback", "C", "D", "computed", "E", "check_raw", "X"])
        self.assertEqual([field["field_id"] for field in self.store.scoring_fields()], ["metric", "input_b", "entity_level", "fallback", "computed", "check_raw"])
        self.assertNotIn("unused", actual)

    def test_matrix_reads_selected_period_and_computes_unweighted_indicators(self):
        row = self.store.field_matrix(["shared"], "2025-12-31")["rows"][0]
        self.assertEqual(row["values"]["input_b"], "2")
        self.assertEqual(row["values"]["computed"], "")
        self.assertEqual(row["values"]["check_raw"], "0")
        self.assertEqual(row["indicator_values"], {"A": 22, "B": 20, "C": 0, "D": 5, "E": 22, "X": 0})
        self.assertEqual(self.store.field_matrix(["shared"], "2024-12-31")["rows"][0]["values"]["input_b"], "99")

    def test_matrix_supplies_model_field_labels_for_formula_display(self):
        matrix = self.store.field_matrix(["shared"], "2025-12-31")
        self.assertEqual(matrix["field_labels"]["input_b"], "源数据B")
        self.assertEqual(matrix["field_labels"]["unused"], "不应出现的字段")
        self.assertNotIn("unused", [field["field_id"] for field in matrix["fields"]])
        self.assertEqual(self.store.indicators[0]["expression"], "metric + input_b + metric")

    def test_original_grade_reads_field_value_instead_of_calculated_grade(self):
        current = app.ScoreEngine(self.store, "shared", "2025-12-31").score()
        self.assertEqual(current["original_grade"], "R4+")
        self.assertNotEqual(current["grade"], current["original_grade"])
        self.assertEqual(app.ScoreEngine(self.store, "shared", "2024-12-31").score()["original_grade"], "R5")
        self.assertEqual(app.ScoreEngine(self.store, "missing", "2025-12-31").score()["original_grade"], "")

    def test_export_always_includes_colored_indicators_after_inputs(self):
        data = app.export_fields_xlsx(self.store, ["shared"], "2025-12-31", {"shared": {"metric": "0", "input_b": "4"}})
        wb = load_workbook(io.BytesIO(data))
        self.addCleanup(wb.close)
        ws = wb.active
        self.assertEqual([cell.value for cell in ws[2]][:8], ["company_id", "company_name", "metric", "input_b", "indicator:A:raw", "entity_level", "indicator:B:raw", "fallback"])
        self.assertEqual(sum(str(cell.value).startswith("indicator:") for cell in ws[2]), 6)
        self.assertTrue(all(str(cell.value).endswith(":raw") for cell in ws[2] if str(cell.value).startswith("indicator:")))
        self.assertFalse(any("赋分" in str(cell.value) or "得分" in str(cell.value) for cell in ws[1]))
        self.assertEqual(ws["C3"].value, 0)
        self.assertEqual(ws["E3"].value, 4)
        self.assertEqual(ws["E1"].comment.text, "metric + input_b + metric")
        self.assertEqual(ws["D3"].value, 4)
        self.assertEqual(wb["指标信息"]["D2"].value, 0.5)
        self.assertEqual(wb["指标信息"]["E2"].value, "metric + input_b + metric")
        self.assertNotEqual(ws["C1"].fill.fgColor.rgb, ws["E1"].fill.fgColor.rgb)
        self.assertNotEqual(ws["C3"].fill.fgColor.rgb, ws["E3"].fill.fgColor.rgb)
        self.assertEqual(ws["E3"].data_type, "n")
        self.assertTrue(ws.row_dimensions[2].hidden)

    def test_import_separates_indicator_edits_from_database_field_overrides(self):
        data = app.export_fields_xlsx(self.store, ["shared"], "2025-12-31")
        wb = load_workbook(io.BytesIO(data))
        ws = wb.active
        ws["C3"] = "3"
        for col, cell in enumerate(ws[2], 1):
            if str(cell.value).startswith("indicator:"):
                ws.cell(3, col, 9999)
        out = io.BytesIO()
        wb.save(out)
        wb.close()
        parsed = app.import_fields_xlsx(self.store, out.getvalue())
        imported = parsed["overrides"]["shared"]
        self.assertEqual(parsed["indicator_values"]["shared"], {iid: "9999" for iid in ("A", "B", "C", "D", "E", "X")})
        self.assertEqual(imported["metric"], "3")
        self.assertNotIn("indicator:A", imported)
        result = app.ScoreEngine(self.store, "shared", "2025-12-31", imported).score()
        values = {detail["indicator_id"]: detail["score"] for detail in result["details"]}
        self.assertEqual(values["A"], 8)
        self.assertEqual(values["E"], 8)
        self.assertEqual(self.store.field_display_value("shared", "metric", "2025-12-31"), "10")

    def test_import_indicator_only_columns_match_ids_and_preserve_zero_blank_and_text(self):
        wb = Workbook()
        ws = wb.active
        ws.append(["公司", "名称", "改名后的表头", "重复标签", "空值", "文本", "忽略得分", "未知指标"])
        ws.append(["company_id", "company_name", "indicator:B:raw", "indicator:A:raw", "indicator:C:raw",
                   "indicator:D:raw", "indicator:A:weighted", "indicator:unknown:raw"])
        ws.append(["shared", "Company Entry", 0, 77.25, None, "text", 999, 88])
        out = io.BytesIO()
        wb.save(out)
        wb.close()
        parsed = app.import_fields_xlsx(self.store, out.getvalue())
        self.assertEqual(parsed["rows"], 1)
        self.assertEqual(parsed["overrides"], {})
        self.assertEqual(parsed["indicator_values"]["shared"], {"A": "77.25", "B": "0", "C": "", "D": "text"})

    def test_legacy_template_uses_score_column_instead_of_raw_or_weighted_values(self):
        wb = Workbook()
        ws = wb.active
        ws.append(["公司", "名称", "原始值", "指标值", "得分"])
        ws.append(["company_id", "company_name", "indicator:A:raw", "indicator:A", "indicator:A:weighted"])
        ws.append(["shared", "Company Entry", 9, 22, 11])
        out = io.BytesIO()
        wb.save(out)
        wb.close()
        self.assertEqual(app.import_fields_xlsx(self.store, out.getvalue())["indicator_values"]["shared"], {"A": "22"})

    def test_export_matches_page_indicator_values_and_keeps_effective_formula_comments(self):
        rules = {"A": {"expression": "metric * 3", "weight": 0.25}}
        data = app.export_fields_xlsx(self.store, ["shared"], "2025-12-31", rule_overrides=rules,
                                     indicator_values={"shared": {"A": "12.3457", "B": "", "C": "0", "D": "text"}})
        wb = load_workbook(io.BytesIO(data))
        self.addCleanup(wb.close)
        ws = wb["数据录入"]
        cols = {cell.value: col for col, cell in enumerate(ws[2], 1)}
        self.assertEqual(ws.cell(3, cols["indicator:A:raw"]).value, 12.3457)
        self.assertIsNone(ws.cell(3, cols["indicator:B:raw"]).value)
        self.assertEqual(ws.cell(3, cols["indicator:C:raw"]).value, 0)
        self.assertEqual(ws.cell(3, cols["indicator:D:raw"]).value, "text")
        self.assertEqual(ws.cell(1, cols["indicator:A:raw"]).comment.text, "metric * 3")
        for key, col in cols.items():
            if str(key).startswith("indicator:"):
                self.assertIsNotNone(ws.cell(1, col).comment)

    def test_unchanged_export_import_preserves_formula_inputs_and_zero(self):
        self.store.fields["missing_input"] = {"field_id": "missing_input", "label": "缺失源数据", "field_type": "打分项", "expression": "", "default_value": ""}
        self.store.indicators.append({**self.store.indicators[0], "indicator_id": "missing", "field_id": "missing_input", "expression": "case(missing_input(2025)>200,4,else,0)"})
        before = app.ScoreEngine(self.store, "shared", "2025-12-31").score()
        exported = app.export_fields_xlsx(self.store, ["shared"], "2025-12-31")
        values = app.import_fields_xlsx(self.store, exported)["overrides"]["shared"]
        after = app.ScoreEngine(self.store, "shared", "2025-12-31", values).score()
        self.assertEqual(after["total_score"], before["total_score"])
        self.assertEqual([(d["raw_value"], d["score"], d["weighted_score"]) for d in after["details"]],
                         [(d["raw_value"], d["score"], d["weighted_score"]) for d in before["details"]])


if __name__ == "__main__":
    unittest.main()
