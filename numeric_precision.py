"""Decimal ROUND_UP at the page/export boundary; calculation inputs stay intact."""
from decimal import Decimal, InvalidOperation, ROUND_UP, localcontext
import re
import math


FOUR_PLACES = Decimal("0.0001")
NUMERIC_TEXT = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")


def decimal_number(value):
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip().replace(",", "")
    if not NUMERIC_TEXT.fullmatch(text):
        return None
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    return number if number.is_finite() and abs(number.adjusted()) <= 1000 else None


def round_up_4(value):
    number = decimal_number(value)
    if number is None:
        return None
    with localcontext() as context:
        context.prec = max(28, len(number.as_tuple().digits), number.adjusted() + 6)
        rounded = number.quantize(FOUR_PLACES, rounding=ROUND_UP)
    return abs(rounded) if rounded == 0 else rounded


def format_4(value):
    rounded = round_up_4(value)
    return format(rounded, ".4f") if rounded is not None else "" if value is None else str(value)


def excel_number(value):
    rounded = round_up_4(value)
    number = float(rounded) if rounded is not None else None
    return number if number is not None and math.isfinite(number) else None


def numeric_field(field):
    return not re.fullmatch(r"文本|日期|日期时间|text|date|datetime", field.get("value_type") or "", re.I) \
        and not re.search(r"(?:_id|_code|_year|_date)$", field.get("field_id", ""), re.I) \
        and not re.search(r"(?:代码|编号)$", field.get("label", ""))


RAW_PREFIX = "原始数值（用于保留计算精度）：\n"


def write_numeric(cell, value):
    """Export the visible value and retain original precision for unchanged imports."""
    from openpyxl.comments import Comment
    number = excel_number(value)
    if number is None:
        return False
    if decimal_number(value) != round_up_4(value):
        cell.comment = Comment(RAW_PREFIX + str(value), "模型评级系统")
    cell.value = number
    cell.number_format = "0.0000"
    return True


def input_value(cell):
    if cell.comment and cell.comment.text.startswith(RAW_PREFIX):
        original = cell.comment.text[len(RAW_PREFIX):]
        if decimal_number(original) is not None and decimal_number(cell.value) == round_up_4(original):
            return original
    return cell.value
