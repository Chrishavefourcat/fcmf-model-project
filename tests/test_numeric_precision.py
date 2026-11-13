"""Display ROUND_UP must not change live calculations or untouched imports."""
import copy
import io
import unittest

from openpyxl import load_workbook

import app
import test_data_entry as fixtures
import test_final_excel as final_fixtures
from check_excel import export_checks_xlsx, import_checks_xlsx
from final_excel import export_final_xlsx
from numeric_precision import format_4, numeric_field


class DecimalDisplayTests(unittest.TestCase):
    def test_round_up_vectors_and_identifier_context(self):
        for value, expected in [(1, "1.0000"), (0, "0.0000"), ("-0", "0.0000"),
                                ("1.23451", "1.2346"), ("-1.23451", "-1.2346"),
                                ("1.23450", "1.2345"), ("0.0000001", "0.0001"),
                                ("-0.00001", "-0.0001"), ("1,234.56789", "1234.5679"),
                                ("1.23451e2", "123.4510"), ("AA+", "AA+"), (None, "")]:
            with self.subTest(value=value):
                self.assertEqual(format_4(value), expected)
        for field in ({"value_type": "文本"}, {"field_id": "company_code"}, {"label": "债券代码"}, {"field_id": "report_year"}):
            self.assertFalse(numeric_field(field))
        self.assertTrue(numeric_field({"field_id": "revenue", "value_type": "number"}))


class ExportPrecisionTests(unittest.TestCase):
    setUp = fixtures.DataEntryTests.setUp
    tearDown = fixtures.DataEntryTests.tearDown
    snapshot = final_fixtures.FinalExportTests.snapshot

    def book(self, data):
        book = load_workbook(io.BytesIO(data))
        self.addCleanup(book.close)
        return book

    def test_source_display_and_unchanged_import_preserve_original_precision(self):
        overrides = {"metric": "1.23451"}
        before = app.ScoreEngine(self.store, "shared", "2025-12-31", overrides).score()
        data = app.export_fields_xlsx(self.store, ["shared"], "2025-12-31", {"shared": overrides})
        book = self.book(data)
        self.assertEqual(book["数据录入"]["C3"].value, 1.2346)
        self.assertEqual(book["数据录入"]["C3"].number_format, "0.0000")
        imported = app.import_fields_xlsx(self.store, data)["overrides"]["shared"]
        self.assertEqual(imported["metric"], "1.23451")
        after = app.ScoreEngine(self.store, "shared", "2025-12-31", imported).score()
        self.assertEqual(after["total_score"], before["total_score"])
        book["数据录入"]["C3"] = 1.3
        edited = io.BytesIO()
        book.save(edited)
        self.assertEqual(app.import_fields_xlsx(self.store, edited.getvalue())["overrides"]["shared"]["metric"], "1.3")

    def test_check_display_and_unchanged_import_preserve_negative_precision(self):
        data = export_checks_xlsx(self.store, ["shared"], "2025-12-31", {"shared": {"check_raw": "-1.23451"}})
        book = self.book(data)
        self.assertEqual(book["批量排查"]["C3"].value, -1.2346)
        self.assertEqual(book["批量排查"]["C3"].number_format, "0.0000")
        imported = import_checks_xlsx(self.store, data, "2025-12-31")
        self.assertEqual(imported["overrides"]["shared"]["check_raw"], "-1.23451")
        self.assertEqual(imported["scores"]["shared"]["check_raw"], "-1.23451")
        self.assertFalse(imported["score_overrides"]["shared"]["check_raw"])
        book["批量排查"]["C3"] = -2.34567
        edited = io.BytesIO()
        book.save(edited)
        self.assertEqual(import_checks_xlsx(self.store, edited.getvalue(), "2025-12-31")["overrides"]["shared"]["check_raw"], "-2.34567")

    def test_final_report_rounds_values_but_never_mutates_page_or_grade_rules(self):
        page = self.snapshot()
        row = page["rows"][0]
        row.update(base_score="12.34561", final_score="-1.23451")
        row["source_values"]["metric"] = "1.23451"
        row["indicator_values"]["A"] = "7.00001"
        page["grade_rules"]["boundaries"] = [-1.23451, 10.23451]
        original = copy.deepcopy(page)
        book = self.book(export_final_xlsx(self.store, page, self.store.indicators))
        self.assertEqual(page, original)
        self.assertEqual(book["数据录入"]["C3"].value, 1.2346)
        self.assertEqual(book["数据录入"]["E3"].value, 7.0001)
        self.assertEqual(book["初步评级"]["C4"].value, 12.3457)
        self.assertEqual(book["等级策略"]["E2"].value, -1.2346)
        self.assertEqual(book["等级策略"]["F2"].value, 10.2346)
        self.assertEqual(book["最终定级"]["C3"].value, "00123.IB")
        for sheet in book:
            first_data = 5 if sheet.title == "评级样本" else 4 if sheet.title == "初步评级" else 2 if sheet.title in ("评级模型", "等级策略") else 3
            for row in sheet.iter_rows(min_row=first_data):
                for cell in row:
                    if cell.data_type == "n" and cell.value is not None and cell.column != 1:
                        self.assertEqual(cell.number_format, "0.0000", (sheet.title, cell.coordinate))
