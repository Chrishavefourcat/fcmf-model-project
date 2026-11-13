"""Expression parsing, score calculation and request-local rule validation."""

import math
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, localcontext

from .values import to_float


@dataclass
class Match:
    ok: bool
    index: int | None = None


class FormulaError(Exception):
    pass


TOKEN_RE = re.compile(
    r'\s*(>=|<=|!=|==|[()+\-*/,{}=<>]|"(?:[^"\\]|\\.)*"|\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fff]+)'
)


class Formula:
    def __init__(self, text, engine, strict=False):
        self.text = (text or "").strip()
        self.engine = engine
        self.strict = strict
        if strict:
            end = 0
            for match in TOKEN_RE.finditer(self.text):
                if self.text[end:match.start()].strip():
                    raise FormulaError("表达式包含不支持的字符")
                end = match.end()
            if self.text[end:].strip():
                raise FormulaError("表达式包含不支持的字符")
        self.tokens = [m.group(1) for m in TOKEN_RE.finditer(self.text)]
        self.pos = 0

    def parse(self):
        if not self.text:
            return None
        value = self.expr()
        if self.strict and self.peek() is not None:
            raise FormulaError(f"多余的内容：{self.peek()}")
        return value

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self, token=None):
        got = self.peek()
        if token is not None and got != token:
            raise FormulaError(f"expected {token}, got {got}")
        self.pos += 1
        return got

    def expr(self):
        return self.compare()

    def compare(self):
        left = self.add()
        while self.peek() in ("=", "==", "!=", ">", "<", ">=", "<=", "in"):
            op = self.take()
            right = self.add()
            left = self.apply_compare(left, op, right)
        return left

    def add(self):
        left = self.mul()
        while self.peek() in ("+", "-"):
            op = self.take()
            right = self.mul()
            left = self.apply_math(left, op, right)
        return left

    def mul(self):
        left = self.unary()
        while self.peek() in ("*", "/"):
            op = self.take()
            right = self.unary()
            left = self.apply_math(left, op, right)
        return left

    def unary(self):
        if self.peek() == "-":
            self.take("-")
            val = self.unary()
            num = to_float(val)
            return -num if num is not None else None
        return self.primary()

    def primary(self):
        tok = self.peek()
        if tok is None:
            if self.strict:
                raise FormulaError("表达式不完整")
            return None
        if tok == "(":
            self.take("(")
            vals = [self.expr()]
            while self.peek() == ",":
                self.take(",")
                vals.append(self.expr())
            self.take(")")
            return vals if len(vals) > 1 else vals[0]
        if tok == "{":
            return self.array("}")
        if tok.startswith('"'):
            self.take()
            return tok[1:-1].replace(r"\"", '"').replace(r"\\", "\\")
        if re.fullmatch(r"\d+(?:\.\d+)?", tok):
            self.take()
            return float(tok) if "." in tok else int(tok)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", tok):
            self.take()
            return tok
        ident = self.take()
        if self.strict and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fff]+", ident):
            raise FormulaError(f"无效的内容：{ident}")
        low = ident.lower()
        if low == "null":
            return None
        if self.peek() == "(":
            args = self.call_args()
            return self.engine.call(ident, args)
        return self.engine.field_value(ident)

    def array(self, end):
        self.take("{")
        vals = []
        while self.peek() and self.peek() != end:
            vals.append(self.expr())
            if self.strict and self.peek() not in (",", end):
                raise FormulaError("数组元素之间缺少逗号")
            if self.peek() == ",":
                self.take(",")
        self.take(end)
        return vals

    def call_args(self):
        self.take("(")
        args = []
        while self.peek() and self.peek() != ")":
            if self.peek() == "else":
                args.append("else")
                self.take()
            else:
                args.append(self.expr())
            if self.strict and self.peek() not in (",", ")"):
                raise FormulaError("函数参数之间缺少逗号")
            if self.peek() == ",":
                self.take(",")
        self.take(")")
        return args

    def apply_math(self, left, op, right):
        a, b = to_float(left), to_float(right)
        if a is None or b is None:
            return None
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return None if b == 0 else a / b
        return None

    def apply_compare(self, left, op, right):
        if op == "in" and isinstance(right, list):
            return Match(left in right)
        if isinstance(right, list):
            for i, item in enumerate(right):
                if self._cmp(left, op, item):
                    return Match(True, i)
            return Match(False)
        return Match(self._cmp(left, op, right))

    def _cmp(self, left, op, right):
        if op == "=" and isinstance(right, list):
            return left in right
        if isinstance(right, str) and ";" in right:
            choices = [x.strip() for x in right.split(";")]
            return str(left) in choices
        a, b = to_float(left), to_float(right)
        if a is not None and b is not None and op in (">", "<", ">=", "<=", "=", "==", "!="):
            return {
                ">": a > b,
                "<": a < b,
                ">=": a >= b,
                "<=": a <= b,
                "=": a == b,
                "==": a == b,
                "!=": a != b,
            }[op]
        return {
            "=": str(left) == str(right),
            "==": str(left) == str(right),
            "!=": str(left) != str(right),
            ">": str(left) > str(right),
            "<": str(left) < str(right),
            ">=": str(left) >= str(right),
            "<=": str(left) <= str(right),
        }[op]


def check_decimal(value):
    """Convert decimal text without importing a binary floating-point residue."""
    if value is None or value == "":
        return None
    try:
        number = Decimal(str(value).replace(",", ""))
        return number if number.is_finite() else None
    except (InvalidOperation, ValueError):
        return None


class CheckFormula(Formula):
    """Decimal arithmetic is limited to the editable check-page score."""
    def primary(self):
        token = self.peek()
        if token is not None and re.fullmatch(r"\d+(?:\.\d+)?", token):
            self.take()
            return Decimal(token)
        return super().primary()

    def unary(self):
        if self.peek() == "-":
            self.take("-")
            value = check_decimal(self.unary())
            return -value if value is not None else None
        return self.primary()

    def apply_math(self, left, op, right):
        a, b = check_decimal(left), check_decimal(right)
        if a is None or b is None:
            return None
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        return a / b if op == "/" and b != 0 else None


class ScoreEngine:
    def __init__(self, store, company_id, default_period=None, overrides=None, rule_overrides=None, indicators=None):
        self.store = store
        self.company_id = company_id
        self.default_period = default_period
        self.overrides = overrides or {}
        self.indicators = indicators if indicators is not None else resolve_rules(store, rule_overrides)
        self.base_year = self.period_year(default_period) or store.base_year
        self.cache = {}
        self.trace = {}

    def period_year(self, period):
        if not period:
            return None
        match = re.match(r"(\d{4})", str(period))
        return int(match.group(1)) if match else None

    def field_value(self, field_id, period=None):
        if field_id == "Y":
            return self.base_year
        key = (field_id, period or "")
        if key in self.cache:
            return self.cache[key]
        normalized_period = self.normalize_period(period) if period else None
        use_override = field_id in self.overrides and (not normalized_period or not self.default_period or normalized_period == self.default_period)
        field = self.store.fields.get(field_id, {})
        # An unchanged empty input must retain the model's original missing-value
        # and field-formula behavior after an Excel round trip.
        if use_override and self.overrides[field_id] in (None, "") \
                and self.store.field_display_value(self.company_id, field_id, normalized_period or self.default_period or "") in (None, ""):
            use_override = False
        if use_override:
            value = self.overrides[field_id] if self.overrides[field_id] not in (None, "") else None
            source_period = self.default_period or ""
        else:
            raw = self.store.values.get(self.company_id, {}).get(field_id, {})
            value = None
            source_period = period
            if period:
                value = raw.get(period)
            else:
                if self.default_period and self.default_period in raw:
                    value = raw[self.default_period]
                    source_period = self.default_period
                elif "" in raw and not (self.default_period and field.get("field_type") == "排查项"):
                    value = raw[""]
                    source_period = ""
        if value in ("", None) and self.store.fields.get(field_id, {}).get("field_type") == "排查项":
            value = self.store.fields[field_id].get("default_value")
            if value in (None, ""):
                value = 0
        if value in ("", None):
            expr = self.store.fields.get(field_id, {}).get("expression")
            if expr and not expr.lower().startswith("fin("):
                value = self.eval(expr)
        converted = to_float(value)
        value = converted if converted is not None else value
        self.cache[key] = value
        self.trace[field_id] = {"value": value, "period": source_period or ""}
        return value

    def eval(self, expr):
        try:
            return Formula(expr, self).parse()
        except Exception:
            return None

    def call(self, name, args):
        lname = name.lower()
        if name in self.store.fields:
            period = self.normalize_period(args[0]) if args else None
            return self.field_value(name, period)
        if lname == "case":
            return self.fn_case(args)
        if lname == "linear":
            return self.fn_linear(args)
        if lname in ("sum", "sum0"):
            nums = [to_float(a) for a in args]
            return sum(n for n in nums if n is not None)
        if lname == "mean":
            nums = [to_float(a) for a in args if to_float(a) is not None]
            return sum(nums) / len(nums) if nums else None
        if lname == "safe_divide":
            a, b = (to_float(args[0]) if len(args) > 0 else None), (to_float(args[1]) if len(args) > 1 else None)
            fallback = args[2] if len(args) > 2 else None
            return fallback if a is None or b in (None, 0) else a / b
        if lname == "max":
            nums = [to_float(a) for a in args if to_float(a) is not None]
            return max(nums) if nums else None
        if lname == "min":
            nums = [to_float(a) for a in args if to_float(a) is not None]
            return min(nums) if nums else None
        if lname == "round":
            val = to_float(args[0]) if args else None
            nd = int(to_float(args[1]) or 0) if len(args) > 1 else 0
            return round(val, nd) if val is not None else None
        if lname == "fin":
            return None
        return None

    def normalize_period(self, value):
        if value is None:
            return None
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        text = str(value)
        if re.fullmatch(r"\d{4}", text):
            return f"{text}-12-31"
        return text

    def fn_case(self, args):
        i = 0
        while i < len(args):
            if args[i] == "else":
                return args[i + 1] if i + 1 < len(args) else None
            cond = args[i]
            result = args[i + 1] if i + 1 < len(args) else None
            if isinstance(cond, Match) and cond.ok:
                if isinstance(result, list) and cond.index is not None and cond.index < len(result):
                    return result[cond.index]
                return result
            if cond is True or (isinstance(cond, (int, float)) and cond):
                return result
            i += 2
        return None

    def fn_linear(self, args):
        x = to_float(args[0]) if args else None
        xs = args[1] if len(args) > 1 else None
        ys = args[2] if len(args) > 2 else None
        if x is None or not isinstance(xs, list) or not isinstance(ys, list) or len(xs) < 2 or len(ys) < 2:
            return None
        x1, x2, y1, y2 = map(float, (xs[0], xs[1], ys[0], ys[1]))
        if x2 == x1:
            return None
        val = y1 + (x - x1) * (y2 - y1) / (x2 - x1)
        lo = to_float(args[3]) if len(args) > 3 else min(y1, y2)
        hi = to_float(args[4]) if len(args) > 4 else max(y1, y2)
        if lo is not None:
            val = max(lo, val)
        if hi is not None:
            val = min(hi, val)
        return val

    def check_score(self, field):
        """Keep formula precision; check-page scores do not apply indicator weights."""
        expression = (field.get("expression") or "").strip()
        if expression:
            if not hasattr(self, "_check_engine"):
                self._check_engine = CheckScoreEngine(self.store, self.company_id, self.default_period,
                                                      self.overrides, indicators=self.indicators)
            raw = self._check_engine.eval(expression)
        else:
            raw = self.field_value(field["field_id"])
        value = to_float(raw)
        return value if value is not None and math.isfinite(value) else None

    def score(self):
        details = []
        total = 0.0
        for ind in self.indicators:
            raw = self.field_value(ind["field_id"])
            score = self.eval(ind["expression"]) if ind["expression"] else raw
            rounding = int(to_float(ind["rounding"]) or 2)
            score_num = to_float(score)
            weighted = None
            if score_num is not None:
                score_num = round(score_num, rounding)
                weighted = score_num if ind["weight"] == 0 else round(score_num * ind["weight"], 4)
                total += weighted
            details.append({
                **ind,
                "field_type": self.store.fields.get(ind["field_id"], {}).get("field_type"),
                "raw_value": raw,
                  "input_value": self.store.field_input_value(self.company_id, ind["field_id"], self.default_period or "", self.overrides),
                  "value_type": self.store.fields.get(ind["field_id"], {}).get("value_type", ""),
                "score": score_num if score_num is not None else score,
                "weighted_score": weighted,
                "source_period": self.trace.get(ind["field_id"], {}).get("period", ""),
            })
        total = round(total, 4)
        return {"total_score": total, "grade": self.grade(total), "details": details, "period_end": self.default_period or "",
                "original_grade": self.store.field_display_value(self.company_id, "original_grade", self.default_period or ""),
                "check_fields": self.store.check_data(self.company_id, self.default_period or "", self.overrides, engine=self)}

    def grade(self, score):
        if score is None:
            return "待补"
        # The database rules use the same lower bounds as the page's rule editor.
        rows = sorted(
            ((-99999 if row["threshold"] in (None, "") else row["threshold"], row["grade"])
             for row in self.store.grades
             if row["status"] == "打分映射" and str(row.get("inclusive")) == "1"),
            key=lambda row: row[0],
        )
        for index, (left, grade) in enumerate(rows):
            last = index == len(rows) - 1
            right = 99999 if last else rows[index + 1][0]
            if left <= score and (score < right or (last and score == right)):
                return grade
        return "等级匹配异常"


class CheckScoreEngine(ScoreEngine):
    """Keep normal field/date rules while avoiding binary noise in check formulas."""
    def field_value(self, field_id, period=None):
        raw = super().field_value(field_id, period)
        value = check_decimal(raw)
        return value if value is not None else raw

    def eval(self, expr):
        try:
            with localcontext() as context:
                context.prec = 50
                return CheckFormula(expr, self).parse()
        except Exception:
            return None

    def normalize_period(self, value):
        if isinstance(value, Decimal) and value == value.to_integral_value():
            value = int(value)
        return super().normalize_period(value)

    def fn_case(self, args):
        args = list(args)
        for index in range(0, len(args), 2):
            if isinstance(args[index], Decimal):
                args[index] = bool(args[index])
        return super().fn_case(args)

    def call(self, name, args):
        lname = name.lower()
        if name in self.store.fields or lname in ("case", "fin"):
            return super().call(name, args)
        nums = [check_decimal(value) for value in args]
        present = [value for value in nums if value is not None]
        if lname in ("sum", "sum0", "mean"):
            total = sum(present, Decimal(0))
            return (total / len(present) if present else None) if lname == "mean" else total
        if lname in ("min", "max"):
            return (min(present) if lname == "min" else max(present)) if present else None
        if lname == "safe_divide":
            a, b = (nums[0] if nums else None), (nums[1] if len(nums) > 1 else None)
            fallback = args[2] if len(args) > 2 else None
            return fallback if a is None or b in (None, 0) else a / b
        if lname == "round":
            value = nums[0] if nums else None
            places = int(nums[1] or 0) if len(nums) > 1 else 0
            return round(value, places) if value is not None else None
        if lname == "linear":
            x = nums[0] if nums else None
            xs, ys = (args[1] if len(args) > 1 else None), (args[2] if len(args) > 2 else None)
            if x is None or not isinstance(xs, list) or not isinstance(ys, list) or min(len(xs), len(ys)) < 2:
                return None
            x1, x2, y1, y2 = map(check_decimal, (xs[0], xs[1], ys[0], ys[1]))
            if None in (x1, x2, y1, y2) or x1 == x2:
                return None
            value = y1 + (x - x1) * (y2 - y1) / (x2 - x1)
            lo, hi = nums[3] if len(nums) > 3 else min(y1, y2), nums[4] if len(nums) > 4 else max(y1, y2)
            if lo is not None:
                value = max(lo, value)
            return min(hi, value) if hi is not None else value
        return None


class RuleValidationEngine(ScoreEngine):
    def field_value(self, field_id, period=None):
        if field_id != "Y" and field_id not in self.store.fields:
            raise FormulaError(f"未知字段：{field_id}")
        return self.base_year if field_id == "Y" else 0

    def call(self, name, args):
        if name in self.store.fields:
            if len(args) > 1:
                raise FormulaError(f"字段 {name} 最多接受一个日期参数")
            return 0
        limits = {"case": (2, None), "linear": (3, 5), "safe_divide": (2, 3), "round": (1, 2),
                  "sum": (1, None), "sum0": (1, None), "mean": (1, None), "max": (1, None),
                  "min": (1, None), "fin": (1, None)}
        if name.lower() not in limits:
            raise FormulaError(f"未知函数：{name}")
        low, high = limits[name.lower()]
        if len(args) < low or (high is not None and len(args) > high):
            raise FormulaError(f"函数 {name} 的参数数量不正确")
        if name.lower() == "case" and len(args) % 2:
            raise FormulaError("case 的条件和结果必须成对填写")
        return super().call(name, args)


def resolve_rules(store, rules=None):
    """Validate and clone request-local rules; never change the shared store."""
    if rules is None:
        rules = {}
    if not isinstance(rules, dict):
        raise ValueError("评分规则格式不正确")
    known = {indicator["indicator_id"] for indicator in store.indicators}
    if set(rules) - known:
        raise ValueError("评分规则包含当前模型不存在的指标")
    indicators = []
    for original in store.indicators:
        indicator = dict(original)
        patch = rules.get(indicator["indicator_id"], {})
        if not isinstance(patch, dict) or set(patch) - {"weight", "expression"}:
            raise ValueError("评分规则仅允许修改权重和表达式")
        if "weight" in patch:
            weight = to_float(patch["weight"])
            if weight is None or not math.isfinite(weight) or weight < 0:
                raise ValueError(f"{indicator['label']}：权重必须为非负有限数字")
            indicator["weight"] = weight
        if "expression" in patch:
            expression = patch["expression"]
            if not isinstance(expression, str):
                raise ValueError(f"{indicator['label']}：表达式必须为文本")
            expression = expression.strip()
            try:
                validator = RuleValidationEngine(store, "", indicators=[])
                Formula(expression, validator, strict=True).parse()
            except Exception as error:
                raise ValueError(f"{indicator['label']}：表达式错误（{error}）") from error
            indicator["expression"] = expression
        indicators.append(indicator)
    return indicators


def scoring_preview(store, company_ids, period="", overrides=None, rules=None):
    indicators = resolve_rules(store, rules)
    selected = set(company_ids)
    overrides = overrides or {}
    results = {company["company_id"]: ScoreEngine(store, company["company_id"], period or None,
               overrides.get(company["company_id"], {}), indicators=indicators).score()
               for company in store.companies if company["company_id"] in selected}
    return {"results": results, "field_matrix": store.field_matrix(company_ids, period, indicators, results)}
