"""Final exports must preserve the page's scope, calculations and active rules."""
import copy
import io
import json
import threading
import unittest
from urllib.request import Request, urlopen

from openpyxl import load_workbook

import app
import test_data_entry as fixtures
from final_excel import SHEETS, export_final_xlsx


class FinalExportTests(unittest.TestCase):
    setUp = fixtures.DataEntryTests.setUp
    tearDown = fixtures.DataEntryTests.tearDown

    def snapshot(self):
        result = app.ScoreEngine(self.store, "shared", "2025-12-31").score()
        row = {"company_id": "shared", "company_name": "=Literal Company", "bond_id": "00123.IB",
               "original_grade": "R4+", "base_score": "77.12", "check_score": "3.2346", "final_score": "80.35",
               "base_grade": "等级匹配异常", "final_grade": "Custom", "conclusion": "page conclusion",
               "source_values": {"metric": "321", "input_b": "0"},
               "indicator_values": {ind["indicator_id"]: "77.25" for ind in self.store.indicators},
               "indicators": {ind["indicator_id"]: {"raw_value": ind["raw_value"], "score": 77.25, "weighted": 19.3125}
                              for ind in result["details"] if ind["field_type"] != "排查项"},
               "checks": {"check_raw": {"value": "0.25", "score": "3.23451", "score_overridden": True,
                                         "remark": "=literal description", "note": "page note"}}}
        return {"period": "2025-12-31", "grade_rules": {"grades": ["Custom"], "boundaries": [-99999, 99999]}, "rows": [row]}

    def workbook(self, page=None, indicators=None):
        wb = load_workbook(io.BytesIO(export_final_xlsx(self.store, page or self.snapshot(), indicators or self.store.indicators)))
        self.addCleanup(wb.close)
        return wb

    def test_seven_sheets_use_page_values_only_and_preserve_literal_text(self):
        self.store.companies.append({"company_id": "not-selected", "company_name": "Not selected"})
        wb = self.workbook()
        self.assertEqual(wb.sheetnames, list(SHEETS))
        self.assertEqual(wb.active.title, "最终定级")
        self.assertEqual(wb["评级样本"]["C4"].value, "原定级")
        self.assertEqual(wb["评级样本"]["C5"].value, "R4+")
        self.assertEqual(wb["数据录入"]["C3"].value, 321)
        self.assertEqual(wb["数据录入"]["D3"].value, 0)
        self.assertEqual(wb["数据录入"]["E3"].value, 77.25)
        self.assertEqual(wb["数据录入"]["E1"].comment.text, "metric + input_b + metric")
        self.assertEqual(wb["初步评级"]["C4"].value, 77.12)
        ws = wb["最终定级"]
        self.assertEqual(ws.max_row, 3)
        self.assertEqual(ws["B3"].value, "=Literal Company")
        self.assertEqual(ws["B3"].data_type, "s")
        self.assertEqual(ws["C3"].value, "00123.IB")
        self.assertEqual(ws["E3"].value, 19.3125)
        header = {cell.value: cell.column for cell in ws[1] if cell.value}
        self.assertEqual(ws.cell(3, header["排查得分"]).value, 3.2346)
        self.assertEqual(ws.cell(3, header["排查得分"]).number_format, "0.0000")
        self.assertEqual(ws.cell(3, header["最终得分"]).value, 80.35)
        self.assertEqual(ws.cell(3, header["最终定级"]).value, "Custom")
        self.assertEqual(ws.cell(3, header["在库定级"]).value, "R4+")
        for key in ("历史定级", "调整方向", "入库状态"):
            self.assertIsNone(ws.cell(3, header[key]).value)
        self.assertEqual(wb["批量排查"]["D3"].value, 3.2346)
        self.assertEqual(wb["批量排查"]["C3"].value, 0.25)
        self.assertEqual(wb["批量排查"].max_column, 4)
        self.assertEqual([wb["批量排查"].cell(2, col).value for col in (3, 4)], ["指标值", "得分"])
        check_column = header["排查项：排查源数据"]
        self.assertEqual([ws.cell(3, check_column + offset).value for offset in (0, 1)], [0.25, 3.2346])
        for sheet in wb:
            for row in sheet.iter_rows(min_row=sheet.max_row):
                for cell in row:
                    self.assertEqual(cell.border.bottom.style, "thin")

    def test_export_uses_effective_weights_expressions_and_grade_intervals(self):
        indicators = app.resolve_rules(self.store, {"A": {"weight": 0.25, "expression": "metric * 3"}})
        wb = self.workbook(indicators=indicators)
        self.assertEqual(wb["评级模型"]["D2"].value, 0.25)
        self.assertEqual(wb["评级模型"]["E2"].value, "metric * 3")
        self.assertEqual(wb["初步评级"]["E2"].value, "权重：25.0000%")
        self.assertEqual(wb["等级策略"]["C2"].value, "Custom")
        self.assertEqual(wb["等级策略"]["E2"].value, -99999)
        self.assertEqual(wb["等级策略"]["F2"].value, 99999)
        self.assertEqual(wb["等级策略"]["G2"].value, "闭区间")

    def test_invalid_or_incomplete_page_snapshots_are_rejected(self):
        invalid = [None, {}, {"rows": []}]
        original = self.snapshot()
        for change in ("unknown", "duplicate", "indicator", "checks", "bounds"):
            page = copy.deepcopy(original)
            if change == "unknown": page["rows"][0]["company_id"] = "unknown"
            elif change == "duplicate": page["rows"].append(page["rows"][0])
            elif change == "indicator": del page["rows"][0]["indicators"]["A"]
            elif change == "checks": page["rows"][0]["checks"] = {}
            else: page["grade_rules"]["boundaries"] = [20, 10]
            invalid.append(page)
        for page in invalid:
            with self.subTest(page=page), self.assertRaises(ValueError):
                export_final_xlsx(self.store, page, self.store.indicators)

    def test_http_export_preserves_page_snapshot_and_timestamped_filename(self):
        server = app.ApplicationServer(("127.0.0.1", 0), backend=self.store.backend)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            req = Request(f"http://127.0.0.1:{server.server_port}/api/export-final?database=entry",
                          data=json.dumps({"page_data": self.snapshot()}).encode(),
                          headers={"X-Data-Source": server.source_id, "Content-Type": "application/json"})
            with urlopen(req, timeout=10) as response:
                self.assertEqual(response.headers.get_content_type(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                self.assertRegex(response.headers["Content-Disposition"], r"_\d{8}_\d{6}\.xlsx")
                wb = load_workbook(io.BytesIO(response.read()))
                self.addCleanup(wb.close)
                self.assertEqual(wb.sheetnames, list(SHEETS))
                self.assertEqual(wb["最终定级"].max_row, 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
