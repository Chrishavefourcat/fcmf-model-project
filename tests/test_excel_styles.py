"""All export routes share the reference style and preserve round-trip inputs."""
import copy
import io
import unittest

from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell

import app
import test_data_entry as fixtures
from check_excel import META_SHEET, export_checks_xlsx, import_checks_xlsx
from final_excel import SHEETS, export_final_xlsx
import test_final_excel as final_fixtures


class ExportStyleTests(unittest.TestCase):
    setUp = fixtures.DataEntryTests.setUp
    tearDown = fixtures.DataEntryTests.tearDown
    snapshot = final_fixtures.FinalExportTests.snapshot

    def book(self, data):
        book = load_workbook(io.BytesIO(data))
        self.addCleanup(book.close)
        return book

    def assert_style(self, sheet, headers):
        for row in sheet:
            for cell in row:
                if isinstance(cell, MergedCell) or sheet.row_dimensions[cell.row].hidden or (sheet.title == "评级样本" and cell.row == 3):
                    continue
                self.assertEqual(cell.font.name, "宋体", cell.coordinate)
                self.assertEqual(cell.font.sz, 11)
                for edge in ("left", "right", "top", "bottom"):
                    self.assertEqual(getattr(cell.border, edge).style, "thin", cell.coordinate)
                    self.assertEqual(getattr(cell.border, edge).color.rgb, "00000000", cell.coordinate)
                if cell.row in headers:
                    self.assertFalse(cell.font.bold)
                    self.assertEqual(cell.font.color.rgb, "00000000")
                    self.assertIn(cell.fill.fgColor.rgb, ("00C0C0C0", "00B9DCF7"))
                    self.assertEqual(cell.alignment.horizontal, "center")

    def test_data_entry_styles_keep_indicator_colors_comments_and_import_keys(self):
        data = app.export_fields_xlsx(self.store, ["shared"], "2025-12-31", {"shared": {"metric": "0", "input_b": "4"}})
        book = self.book(data)
        for sheet in book:
            self.assert_style(sheet, {1})
        sheet = book["数据录入"]
        self.assertTrue(sheet.row_dimensions[2].hidden)
        self.assertEqual(sheet["C1"].fill.fgColor.rgb, "00C0C0C0")
        self.assertEqual(sheet["E1"].fill.fgColor.rgb, "00B9DCF7")
        self.assertEqual(sheet["E3"].fill.fgColor.rgb, "00E8F3FF")
        self.assertEqual(sheet["E3"].number_format, "0.0000")
        self.assertEqual(sheet["E1"].comment.text, "metric + input_b + metric")
        imported = app.import_fields_xlsx(self.store, data)
        self.assertEqual(imported["overrides"]["shared"]["metric"], "0")
        self.assertEqual(imported["indicator_values"]["shared"]["A"], "4")

    def test_check_styles_preserve_hidden_metadata_and_all_input_values(self):
        data = export_checks_xlsx(self.store, ["shared"], "2025-12-31", {"shared": {"check_raw": "1.2345"}}, {"shared": {"check_raw": "页面备注"}})
        book = self.book(data)
        sheet = book["批量排查"]
        self.assert_style(sheet, {1, 2})
        self.assertEqual(sheet["C1"].fill.fgColor.rgb, "00C0C0C0")
        self.assertIsNone(sheet["C3"].fill.patternType)
        self.assertEqual(sheet["C3"].value, 1.2345)
        self.assertEqual(sheet["C3"].number_format, "0.0000")
        self.assertEqual(sheet["D3"].value, 1.2345)
        self.assertEqual(book[META_SHEET].sheet_state, "veryHidden")
        imported = import_checks_xlsx(self.store, data, "2025-12-31")
        self.assertEqual(imported["overrides"]["shared"]["check_raw"], "1.2345")
        self.assertEqual(imported["scores"]["shared"]["check_raw"], "1.2345")
        self.assertFalse(imported["score_overrides"]["shared"]["check_raw"])

    def test_final_seven_sheets_match_styles_keep_snapshot_precision_and_error_color(self):
        page = self.snapshot()
        original = copy.deepcopy(page)
        book = self.book(export_final_xlsx(self.store, page, self.store.indicators))
        self.assertEqual(page, original)
        self.assertEqual(book.sheetnames, list(SHEETS))
        for sheet in book:
            headers = {1, 4} if sheet.title == "评级样本" else {1, 2, 3} if sheet.title == "初步评级" else {1} if sheet.title in ("评级模型", "等级策略") else {1, 2}
            self.assert_style(sheet, headers)
        self.assertEqual(book["数据录入"]["E1"].fill.fgColor.rgb, "00B9DCF7")
        self.assertEqual(book["数据录入"]["E1"].comment.text, "metric + input_b + metric")
        self.assertEqual(book["初步评级"]["D4"].font.color.rgb, "00D92D20")
        final = book["最终定级"]
        self.assertEqual(final["A3"].number_format, "0")
        column = next(cell.column for cell in final[1] if cell.value == "排查得分")
        self.assertEqual(final.cell(3, column).number_format, "0.0000")
        self.assertEqual(final.cell(3, column).value, 3.2346)
        self.assertEqual(final["C3"].value, "00123.IB")
        self.assertEqual(final["B3"].data_type, "s")
        standalone = self.book(export_checks_xlsx(self.store, ["shared"], "2025-12-31"))["批量排查"]
        combined = book["批量排查"]
        for column in "ABCD":
            self.assertEqual(combined.column_dimensions[column].width, standalone.column_dimensions[column].width)
        self.assertEqual(combined["C3"].alignment.horizontal, standalone["C3"].alignment.horizontal)


if __name__ == "__main__":
    unittest.main()
