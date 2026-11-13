"""Check inputs and formula scores remain independent and request-local."""

import hashlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from test_model_selection import create_model
import app
from database import ConnectionConfig, DatabaseBackend
from numeric_precision import format_4


class CheckScoringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "checks.db"
        create_model(self.path, "Checks", 10)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("INSERT INTO company VALUES (?,?,?,?,?)", ("other", "Other", "", "", ""))
            connection.executemany("INSERT INTO field VALUES (?,?,?,?,?,?,?)", [
                ("exposure", "对外拆借", "排查项", "number", "", "metric * 500", "0.2"),
                ("title", "评级", "排查项", "文本", "", "", "无"),
                ("direct", "直接分数", "排查项", "number", "", "", "1.23456789"),
                ("unbound", "未绑定项", "排查项", "number", "", "metric * 500", "2.34567891"),
                ("empty", "无默认值", "排查项", "number", "", "", ""),
                ("text", "未绑定文本", "排查项", "文本", "", "", "AA+"),
            ])
            connection.executemany("INSERT INTO indicator VALUES (?,?,?,?,?,?,?,?,?,?)", [
                ("a_risk", "关联指标", "exposure", 0.1,
                 "case(exposure>{0.3,0.2}, {3,2}, else, 0)", 0, 1, 2, "", ""),
                ("b_another", "同字段其它指标", "exposure", 1, "99", 0, 100, 2, "", ""),
                ("c_title", "文字映射", "title", 1, 'case(title="警示", 5, else, 0)', 0, 100, 2, "", ""),
                ("d_direct", "空表达式", "direct", 1, "", 0, 1, 2, "", ""),
            ])
            connection.executemany("INSERT INTO field_value VALUES (?,?,?,?,?,?,?)", [
                ("shared", "exposure", "2025-12-31", "0.4", "", 0, "本期"),
                ("shared", "exposure", "2024-12-31", "0.25", "", 0, "上期"),
                ("shared", "exposure", "", "0.9", "", 0, "未标日期"),
                ("other", "exposure", "2025-12-31", "0.1", "", 0, "其它主体"),
                ("shared", "title", "2025-12-31", "警示", "", 0, ""),
            ])
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.store = app.DataStore("checks", DatabaseBackend(ConnectionConfig(self.temp.name)))

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), self.digest)

    def checks(self, company_id="shared", period="2025-12-31", **kwargs):
        return {field["field_id"]: field for field in self.store.check_data(company_id, period, **kwargs)}

    def test_field_value_and_first_associated_indicator_formula_are_separate(self):
        check = self.checks()["exposure"]
        self.assertEqual((check["value"], check["score"]), ("0.4", 3))
        self.assertEqual(check["indicator_id"], "a_risk")
        self.assertEqual(check["indicator_ids"], ["a_risk", "b_another"])
        self.assertEqual(check["expression"], "case(exposure>{0.3,0.2}, {3,2}, else, 0)")
        self.assertEqual(self.checks(indicators=list(reversed(self.store.indicators)))["exposure"], check)
        # 3 is preserved even though the indicator has weight .1 and maximum 1.
        score = app.ScoreEngine(self.store, "shared", "2025-12-31").score()
        self.assertEqual(next(f for f in score["check_fields"] if f["field_id"] == "exposure"), check)

    def test_input_override_recalculates_formula_and_retains_threshold_boundaries(self):
        for value, expected in [("0.31", 3), ("0.3", 2), ("0.21", 2), ("0.2", 0), ("0", 0)]:
            with self.subTest(value=value):
                check = self.checks(overrides={"exposure": value})["exposure"]
                self.assertEqual((check["value"], check["score"]), (value, expected))
        self.assertEqual(self.checks()["exposure"]["value"], "0.4")

    def test_selected_company_period_defaults_and_zero_remain_isolated(self):
        self.assertEqual(self.checks(period="2024-12-31")["exposure"]["score"], 2)
        self.assertEqual(self.checks(company_id="other")["exposure"]["score"], 0)
        missing = self.checks(period="2023-12-31")["exposure"]
        self.assertEqual((missing["value"], missing["score"], missing["note"]), ("", 0, ""))
        self.assertEqual(self.checks(overrides={"exposure": ""})["exposure"]["value"], "")
        self.assertEqual(self.checks()["empty"]["score"], 0)

    def test_editable_inputs_keep_missing_defaults_and_actual_zero_distinct(self):
        for overrides, expected in [({}, ""), ({"exposure": ""}, ""), ({"exposure": "0"}, "0")]:
            result = app.ScoreEngine(self.store, "shared", "2023-12-31", overrides).score()
            detail = next(item for item in result["details"] if item["field_id"] == "exposure")
            check = next(item for item in result["check_fields"] if item["field_id"] == "exposure")
            self.assertEqual(detail["input_value"], expected)
            self.assertEqual(check["value"], expected)
            self.assertEqual(detail["raw_value"], 0 if overrides.get("exposure") == "0" else 0.2)
            self.assertEqual(check["score"], 0)
        result = app.ScoreEngine(self.store, "shared", "2025-12-31", {"metric": "0"}).score()
        detail = next(item for item in result["details"] if item["field_id"] == "metric")
        self.assertEqual((detail["input_value"], detail["raw_value"]), ("0", 0))
        empty = app.ScoreEngine(self.store, "shared", "2025-12-31", {"metric": ""}).score()
        self.assertEqual(next(item["input_value"] for item in empty["details"] if item["field_id"] == "metric"), "")

    def test_temporary_rules_and_formula_precision_are_used_without_mutating_store(self):
        original = [dict(indicator) for indicator in self.store.indicators]
        rules = {"a_risk": {"expression": "exposure / 7", "weight": 0.5}}
        preview = app.scoring_preview(self.store, ["shared"], "2025-12-31",
                                      {"shared": {"exposure": "1.23456789"}}, rules)
        check = next(f for f in preview["results"]["shared"]["check_fields"] if f["field_id"] == "exposure")
        self.assertEqual((check["expression"], check["value"]), ("exposure / 7", "1.23456789"))
        self.assertEqual(check["score"], 1.23456789 / 7)
        self.assertEqual(self.store.indicators, original)
        resolved = app.resolve_rules(self.store, rules)
        self.assertEqual(self.checks(overrides={"exposure": "1.23456789"}, indicators=resolved)["exposure"], check)

    def test_empty_formula_unbound_fields_and_text_formula_fallbacks(self):
        checks = self.checks()
        self.assertEqual(checks["direct"]["score"], 1.23456789)
        self.assertEqual(checks["unbound"]["score"], 2.34567891)
        self.assertIsNone(checks["unbound"]["indicator_id"])
        self.assertEqual(checks["unbound"]["expression"], "")
        self.assertEqual(checks["title"]["score"], 5)
        self.assertIsNone(checks["text"]["score"])
        self.assertIsNone(self.checks(overrides={"unbound": "Infinity"})["unbound"]["score"])
        resolved = app.resolve_rules(self.store, {"a_risk": {"expression": ""}})
        self.assertEqual(self.checks(indicators=resolved)["exposure"]["score"], 0.4)

    def test_explicit_formula_dates_keep_existing_engine_semantics(self):
        resolved = app.resolve_rules(self.store, {"a_risk": {"expression": "exposure(2024-12-31) + exposure"}})
        check = self.checks(overrides={"exposure": "0.5"}, indicators=resolved)["exposure"]
        self.assertEqual((check["value"], check["score"]), ("0.5", 0.75))
        engine = app.ScoreEngine(self.store, "shared", "2025-12-31", {"exposure": "0.5"}, indicators=resolved)
        self.assertEqual(self.checks(engine=engine)["exposure"], check)

    def test_check_arithmetic_avoids_display_noise_without_changing_normal_formula_engine(self):
        engine = app.ScoreEngine(self.store, "shared", "2025-12-31", {"exposure": "0.1"})
        self.assertEqual(engine.eval("0.1 + 0.2"), 0.30000000000000004)
        for expression, value, display in [
            ("0.1 + 0.2", 0.3, "0.3000"),
            ("exposure + 0.2", 0.3, "0.3000"),
            ("sum(0.1, 0.2)", 0.3, "0.3000"),
            ("sum0(0.1, null, 0.2)", 0.3, "0.3000"),
            ("mean(0.1, 0.2, 0.3)", 0.2, "0.2000"),
            ("-(0.1 + 0.2)", -0.3, "-0.3000"),
            ("0.00007 / 0.7", 0.0001, "0.0001"),
            ("safe_divide(0.00007, 0.7)", 0.0001, "0.0001"),
            ("linear(0.1, {0,1}, {0.1,2.1})", 0.3, "0.3000"),
            ("max(0.1 + 0.2, 0.2)", 0.3, "0.3000"),
            ("case(0.1 + 0.2 = 0.3, 0.3, else, 0)", 0.3, "0.3000"),
            ("case(0.1 + 0.2, 0.3, else, 0)", 0.3, "0.3000"),
        ]:
            with self.subTest(expression=expression):
                score = engine.check_score({"field_id": "exposure", "expression": expression})
                self.assertEqual(score, value)
                self.assertEqual(format_4(score), display)
        self.assertEqual(engine.eval("sum(0.1, 0.2)"), 0.30000000000000004)

    def test_check_decimal_calculation_preserves_real_precision_and_nonterminating_division(self):
        engine = app.ScoreEngine(self.store, "shared", "2025-12-31")
        for expression, expected, display in [
            ("0.3 + 0.000000001", 0.300000001, "0.3001"),
            ("0.1234567891234567 + 0.0000000000000001", 0.1234567891234568, "0.1235"),
            ("1 / 3", 1 / 3, "0.3334"),
            ("safe_divide(1,3)", 1 / 3, "0.3334"),
        ]:
            with self.subTest(expression=expression):
                score = engine.check_score({"field_id": "exposure", "expression": expression})
                self.assertEqual(score, expected)
                self.assertEqual(format_4(score), display)
        self.assertIsNone(engine.check_score({"field_id": "exposure", "expression": "1 / 0"}))


if __name__ == "__main__":
    unittest.main()
