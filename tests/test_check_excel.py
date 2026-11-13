"""Fourth-step templates and previews never write back to the model file."""
import hashlib
import io
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from openpyxl import load_workbook

from test_model_selection import create_model
import app
from check_excel import META_SHEET, STATE_SHEET, export_checks_xlsx, import_checks_xlsx
from database import ConnectionConfig, DatabaseBackend


class CheckExcelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "checks.db"
        create_model(self.path, "Checks", 10)
        fields = [
            ("credit_spread", "信用利差字段", "数值", "", "7", "字段说明"),
            ("external_lending", "借款字段", "数值", "", "2.5", ""),
            ("implied_rating", "评级字段", "文本", "", None, "=这是一段文字"),
            ("empty_check", "空值", "数值", "", None, ""),
            ("computed_check", "公式项", "数值", "metric + 2", None, ""),
            ("undated_check", "未标日期", "数值", "", None, ""),
            ("unbound_check", "未绑定指标的排查字段", "数值", "", "3", ""),
        ]
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("ALTER TABLE field ADD COLUMN remark TEXT")
            for fid, label, value_type, expression, default, remark in fields:
                conn.execute("INSERT INTO field VALUES (?,?,?,?,?,?,?,?)", (fid, label, "排查项", value_type, "", expression, default, remark))
                if fid != "unbound_check":
                    conn.execute("INSERT INTO indicator VALUES (?,?,?,?,?,?,?,?,?,?)", (fid, label + "大项", fid, 1, "", 0, 100, 2, "指标说明", ""))
            conn.executemany("INSERT INTO field_value VALUES (?,?,?,?,?,?,?)", [
                ("shared", "credit_spread", "2025-12-31", "0", "", 0, "该主体备注"),
                ("shared", "credit_spread", "2024-12-31", "88", "", 0, "去年备注"),
                ("shared", "external_lending", "2025-12-31", "", "", 0, ""),
                ("shared", "implied_rating", "2025-12-31", "AA+", "", 0, ""),
                ("shared", "empty_check", "2026-08-07", "999", "", 0, "未来备注"),
                ("shared", "undated_check", "", "4", "", 0, "未标日期备注"),
            ])
            conn.execute("INSERT INTO company VALUES (?,?,?,?,?)", ("001234567890123456789", "=主体名称", "", "", ""))
            conn.execute("UPDATE indicator SET expression='case(external_lending>{0.3,0.2}, {3,2}, else, 0)', weight=0.1, score_max=1 WHERE field_id='external_lending'")
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.backend = DatabaseBackend(ConnectionConfig(self.temp.name))
        self.store = app.DataStore("checks", self.backend)

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), self.digest)

    def exported(self, ids=None, **kwargs):
        return export_checks_xlsx(self.store, ids or ["shared"], "2025-12-31", **kwargs)

    def workbook(self, **kwargs):
        wb = load_workbook(io.BytesIO(self.exported(**kwargs)))
        self.addCleanup(wb.close)
        return wb

    def columns(self, wb):
        return {fid: col for col, fid, label in wb[META_SHEET].iter_rows(min_row=4, max_col=3, values_only=True)}

    def edited(self, edit):
        wb = self.workbook()
        edit(wb, self.columns(wb))
        out = io.BytesIO()
        wb.save(out)
        return out.getvalue()

    def test_values_defaults_zero_dates_and_only_check_fields(self):
        wb = self.workbook()
        ws, cols = wb.active, self.columns(wb)
        self.assertEqual(len(cols), 7)
        self.assertNotIn("metric", cols)
        self.assertEqual(next(field for field in self.store.check_fields() if field["field_id"] == "credit_spread")["label"], "信用利差字段")
        self.assertEqual(ws.cell(1, cols["credit_spread"]).value, "信用利差字段")
        expected = {"credit_spread": 0, "external_lending": None, "implied_rating": "AA+", "empty_check": None,
                    "computed_check": None, "undated_check": None, "unbound_check": None}
        for fid, value in expected.items():
            self.assertEqual(ws.cell(3, cols[fid]).value, value, fid)
            self.assertEqual(ws.cell(2, cols[fid]).value, "指标值")
            self.assertEqual(ws.cell(2, cols[fid] + 1).value, "得分")
        self.assertEqual(ws.cell(3, cols["external_lending"] + 1).value, 3)
        self.assertEqual(ws.cell(3, cols["unbound_check"] + 1).value, 3)
        self.assertIsNone(ws.cell(3, cols["implied_rating"] + 1).value)
        self.assertEqual(ws.max_column, 16)
        self.assertEqual(ws["A1"].value, "主体代码")
        self.assertEqual(ws["B1"].value, "主体名称")
        self.assertNotIn("排查范围", [cell.value for cell in ws[2]])
        self.assertIn("C1:D1", {str(r) for r in ws.merged_cells.ranges})
        self.assertEqual(ws.freeze_panes, "C3")
        self.assertEqual(wb[META_SHEET].sheet_state, "veryHidden")
        self.assertEqual(wb[STATE_SHEET].sheet_state, "veryHidden")
        self.assertEqual(ws.max_row, 3)

    def test_checks_match_selected_period_without_undated_fallback(self):
        current = {f["field_id"]: f for f in self.store.check_data("shared", "2025-12-31")}
        previous = {f["field_id"]: f for f in self.store.check_data("shared", "2024-12-31")}
        missing = {f["field_id"]: f for f in self.store.check_data("shared", "2023-12-31")}
        self.assertEqual((current["credit_spread"]["value"], current["credit_spread"]["note"]), ("0", "该主体备注"))
        self.assertEqual((previous["credit_spread"]["value"], previous["credit_spread"]["note"]), ("88", "去年备注"))
        self.assertEqual(missing["credit_spread"]["value"], "")
        self.assertEqual(missing["credit_spread"]["score"], 7)
        self.assertEqual((current["undated_check"]["value"], current["undated_check"]["note"]), ("", ""))
        preview = app.ScoreEngine(self.store, "shared", "2024-12-31", {"credit_spread": "12"}).score()
        self.assertEqual(preview["period_end"], "2024-12-31")
        self.assertEqual(next(f["value"] for f in preview["check_fields"] if f["field_id"] == "credit_spread"), "12")
        self.assertEqual(self.store.check_value("shared", "credit_spread", "2024-12-31"), "88")

    def test_page_snapshot_exports_only_visible_rows_and_values_with_full_borders(self):
        page = {
            "fields": [{"field_id": "external_lending", "label": "借款字段"},
                       {"field_id": "credit_spread", "label": "信用利差字段"}],
            "rows": [{"company_id": "001234567890123456789", "company_name": "页面主体名称",
                      "checks": {"external_lending": {"value": "12.5", "score": "7.12341", "score_overridden": True,
                                                      "remark": "页面说明", "note": "=页面备注"},
                                 "credit_spread": {"value": "", "score": None}}}],
        }
        # Extra IDs and stale database/default values must not expand or replace the page snapshot.
        wb = self.workbook(ids=["shared", "001234567890123456789"], page_data=page,
                           overrides={"001234567890123456789": {"external_lending": "99"}})
        ws, cols = wb.active, self.columns(wb)
        self.assertEqual((ws.max_row, ws.max_column), (3, 6))
        self.assertEqual((ws["A3"].value, ws["B3"].value), ("001234567890123456789", "页面主体名称"))
        self.assertEqual(ws.cell(3, cols["external_lending"]).value, 12.5)
        self.assertIsNone(ws.cell(3, cols["credit_spread"]).value)
        self.assertEqual(ws.cell(3, cols["external_lending"] + 1).value, 7.1235)
        imported = import_checks_xlsx(self.store, self.exported(page_data=page), "2025-12-31")
        self.assertEqual(imported["scores"]["001234567890123456789"]["external_lending"], "7.12341")
        self.assertTrue(imported["score_overrides"]["001234567890123456789"]["external_lending"])
        self.assertEqual(imported["overrides"]["001234567890123456789"]["credit_spread"], "")
        self.assertIsNone(imported["scores"]["001234567890123456789"]["credit_spread"])
        for cell in ws[3]:
            for edge in ("left", "right", "top", "bottom"):
                self.assertIn(getattr(cell.border, edge).style, ("thin", "medium"))
        self.assertEqual(ws["C1"].value, "借款字段")
        self.assertEqual(ws["C1"].fill.fgColor.rgb, "00C0C0C0")

    def test_page_snapshot_empty_rows_and_invalid_rows_never_export_database_rows(self):
        fields = [{"field_id": "credit_spread", "label": "信用利差字段"}]
        wb = self.workbook(page_data={"fields": fields, "rows": []})
        self.assertEqual(wb.active.max_row, 2)
        for row in ({"company_id": "unknown", "checks": {}},
                    {"company_id": "shared", "checks": {}}):
            with self.subTest(row=row), self.assertRaises(ValueError):
                self.exported(page_data={"fields": fields, "rows": [row]})

    def test_text_ids_and_formula_like_text_are_preserved(self):
        wb = self.workbook(ids=["001234567890123456789", "shared", "shared"])
        self.assertEqual(wb.active.max_row, 4)
        self.assertEqual(wb.active["A3"].value, "001234567890123456789")
        self.assertEqual(wb.active["A3"].data_type, "s")
        self.assertEqual(wb.active["B3"].value, "=主体名称")
        self.assertEqual(wb.active["B3"].data_type, "s")
        cell = wb.active.cell(4, self.columns(wb)["implied_rating"])
        self.assertEqual((cell.value, cell.data_type), ("AA+", "s"))

    def test_round_trip_and_edits_recalculate_with_check_defaults(self):
        before = app.ScoreEngine(self.store, "shared", default_period="2025-12-31").score()
        imported = import_checks_xlsx(self.store, self.exported(), "2025-12-31")
        after = app.ScoreEngine(self.store, "shared", overrides=imported["overrides"]["shared"], default_period="2025-12-31").score()
        self.assertEqual(before["total_score"], after["total_score"])
        self.assertEqual(imported["overrides"]["shared"]["computed_check"], "")
        self.assertFalse(any(imported["score_overrides"]["shared"].values()))
        def edit(wb, cols):
            wb.active.cell(3, cols["credit_spread"], 8)
        imported = import_checks_xlsx(self.store, self.edited(edit), "2025-12-31")
        self.assertEqual(imported["overrides"]["shared"]["credit_spread"], "8")
        self.assertFalse(imported["score_overrides"]["shared"]["credit_spread"])
        self.assertEqual(self.store.fields["credit_spread"]["remark"], "字段说明")
        score = app.ScoreEngine(self.store, "shared", overrides=imported["overrides"]["shared"], default_period="2025-12-31").score()
        self.assertEqual(score["total_score"], before["total_score"] + 8)

    def test_excel_changed_value_recalculates_and_changed_score_is_manual(self):
        def edit(wb, cols):
            wb.active.cell(3, cols["external_lending"], 0.25)
            wb.active.cell(3, cols["credit_spread"] + 1, -1.234567)
        imported = import_checks_xlsx(self.store, self.edited(edit), "2025-12-31")
        self.assertFalse(imported["score_overrides"]["shared"]["external_lending"])
        self.assertTrue(imported["score_overrides"]["shared"]["credit_spread"])
        self.assertEqual(imported["scores"]["shared"]["credit_spread"], "-1.234567")
        checks = {item["field_id"]: item for item in self.store.check_data("shared", "2025-12-31", imported["overrides"]["shared"])}
        self.assertEqual(checks["external_lending"]["score"], 2)

    def test_manual_score_snapshot_survives_unchanged_import_but_value_edits_reset_it(self):
        page = {"fields": [{"field_id": "external_lending", "label": "借款字段"}],
                "rows": [{"company_id": "shared", "checks": {"external_lending": {
                    "value": "0.25", "score": "9.123456", "score_overridden": True}}}]}
        data = self.exported(page_data=page)
        imported = import_checks_xlsx(self.store, data)
        self.assertTrue(imported["score_overrides"]["shared"]["external_lending"])
        self.assertEqual(imported["scores"]["shared"]["external_lending"], "9.123456")
        wb = load_workbook(io.BytesIO(data))
        self.addCleanup(wb.close)
        wb.active["C3"] = 0.35
        out = io.BytesIO()
        wb.save(out)
        imported = import_checks_xlsx(self.store, out.getvalue())
        self.assertFalse(imported["score_overrides"]["shared"]["external_lending"])

    def test_empty_values_zero_scores_and_formula_like_text_are_distinct(self):
        page = {"fields": [{"field_id": "credit_spread", "label": "信用利差字段"},
                           {"field_id": "implied_rating", "label": "评级字段"}],
                "rows": [{"company_id": "shared", "checks": {
                    "credit_spread": {"value": "", "score": 0, "score_overridden": True},
                    "implied_rating": {"value": "=AA+", "score": None}}}]}
        data = self.exported(page_data=page)
        wb = load_workbook(io.BytesIO(data))
        self.addCleanup(wb.close)
        self.assertEqual((wb.active["E3"].value, wb.active["E3"].data_type), ("=AA+", "s"))
        imported = import_checks_xlsx(self.store, data)
        self.assertEqual(imported["overrides"]["shared"], {"credit_spread": "", "implied_rating": "=AA+"})
        self.assertEqual(imported["scores"]["shared"], {"credit_spread": "0", "implied_rating": None})
        self.assertEqual(imported["score_overrides"]["shared"], {"credit_spread": True, "implied_rating": False})

    def test_standalone_exports_apply_effective_indicator_expression(self):
        wb = self.workbook(rule_overrides={"external_lending": {"expression": "external_lending * 2"}})
        self.assertEqual(wb.active.cell(3, self.columns(wb)["external_lending"] + 1).value, 5)

    def test_empty_input_exports_blank_while_score_uses_calculation_default(self):
        wb = self.workbook(overrides={"shared": {"credit_spread": "", "external_lending": "0"}}, notes={"shared": {"credit_spread": "=备注"}})
        cols = self.columns(wb)
        self.assertIsNone(wb.active.cell(3, cols["credit_spread"]).value)
        self.assertEqual(wb.active.cell(3, cols["external_lending"]).value, 0)
        self.assertEqual(wb.active.cell(3, cols["credit_spread"] + 1).value, 7)

    def test_bad_headers_category_formulas_duplicates_and_period_rejected(self):
        mutations = [
            lambda w, c: setattr(w.active.cell(1, c["credit_spread"]), "value", "陌生项"),
            lambda w, c: setattr(w.active.cell(2, c["credit_spread"]), "value", "分值"),
            lambda w, c: setattr(w.active.cell(3, c["credit_spread"]), "value", "=1+1"),
            lambda w, c: setattr(w.active.cell(3, c["credit_spread"] + 1), "value", "=1+1"),
            lambda w, c: setattr(w.active.cell(3, c["credit_spread"] + 1), "value", "AA+"),
            lambda w, c: w.active.append(["shared", "重复"]),
            lambda w, c: setattr(w[META_SHEET]["B4"], "value", "metric"),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                import_checks_xlsx(self.store, self.edited(mutation), "2025-12-31")
        with self.assertRaisesRegex(ValueError, "日期"):
            import_checks_xlsx(self.store, self.exported(), "2024-12-31")

    def test_metadata_free_template_and_unknown_company(self):
        def edit(wb, cols):
            del wb[META_SHEET]
            del wb[STATE_SHEET]
            wb.active.append(["unknown", "其他主体"])
        imported = import_checks_xlsx(self.store, self.edited(edit), "2025-12-31")
        self.assertEqual((imported["rows"], imported["skipped_rows"]), (1, 1))
        self.assertEqual(set(imported["overrides"]["shared"]), set(self.columns(self.workbook())))
        self.assertTrue(imported["score_overrides"]["shared"]["credit_spread"])

    def test_reference_five_column_group_can_be_imported_without_range(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "批量排查"
        ws.append(["主体代码", "主体名称", "信用利差字段大项"])
        ws.merge_cells("C1:G1")
        ws.append([None, None, "排查类别", "排查分", "排查范围", "排查说明", "排查备注"])
        ws.append(["shared", "Company Checks", "得分", 9, "这列不导入", "这列不修改定义", "参考模板备注"])
        out = io.BytesIO()
        wb.save(out)
        wb.close()
        imported = import_checks_xlsx(self.store, out.getvalue(), "2025-12-31")
        self.assertEqual(imported["overrides"]["shared"], {"credit_spread": "9"})
        self.assertEqual(imported["notes"]["shared"], {"credit_spread": "参考模板备注"})
        self.assertFalse(imported["score_overrides"]["shared"]["credit_spread"])
        self.assertEqual(imported["scores"]["shared"], {})

    def test_legacy_three_column_group_treats_old_score_as_indicator_value(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.append(["主体代码", "主体名称", "借款字段"])
        ws.merge_cells("C1:E1")
        ws.append([None, None, "排查分", "排查说明", "排查备注"])
        ws.append(["shared", "Company Checks", 0.25, "旧说明", "旧备注"])
        out = io.BytesIO()
        wb.save(out)
        wb.close()
        imported = import_checks_xlsx(self.store, out.getvalue())
        self.assertEqual(imported["overrides"]["shared"], {"external_lending": "0.25"})
        self.assertEqual(imported["scores"]["shared"], {})
        self.assertFalse(imported["score_overrides"]["shared"]["external_lending"])

    def test_http_export_import_and_source_guards(self):
        server = app.ApplicationServer(("127.0.0.1", 0), backend=self.backend)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(path, body, source=None):
                url = f"http://127.0.0.1:{server.server_port}{path}" + ("&" if "?" in path else "?") + urlencode({"database": "checks"})
                req = Request(url, data=body, headers={"X-Data-Source": server.source_id if source is None else source})
                with urlopen(req, timeout=10) as response:
                    return response.read()
            exported = request("/api/export-checks", json.dumps({"company_ids": ["shared"], "period": "2025-12-31"}).encode())
            imported = json.loads(request("/api/import-checks?period=2025-12-31", exported))
            self.assertEqual(imported["overrides"]["shared"]["credit_spread"], "0")
            page = {"fields": [{"field_id": "credit_spread", "label": "信用利差字段"}],
                    "rows": [{"company_id": "shared", "company_name": "当前页面主体",
                              "checks": {"credit_spread": {"value": "23", "score": "8", "score_overridden": True}}}]}
            exported_page = request("/api/export-checks", json.dumps({"period": "2025-12-31", "page_data": page}).encode())
            page_wb = load_workbook(io.BytesIO(exported_page))
            self.addCleanup(page_wb.close)
            self.assertEqual(page_wb.active.max_row, 3)
            self.assertEqual([page_wb.active.cell(3, col).value for col in range(2, 5)],
                             ["当前页面主体", 23, 8])
            with self.assertRaises(HTTPError) as error:
                request("/api/export-checks", b"{}", "stale-source")
            self.assertEqual(error.exception.code, 409)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
