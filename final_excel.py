"""Seven-sheet rating report, using the current page snapshot throughout."""
import math
from io import BytesIO

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.utils import get_column_letter

from check_excel import literal, text
from excel_styles import style_table
from numeric_precision import decimal_number, excel_number, format_4, numeric_field, write_numeric


SHEETS = ("评级样本", "数据录入", "初步评级", "评级模型", "等级策略", "批量排查", "最终定级")


def value(cell, data, numeric=True, number_format="General"):
    number = None
    if numeric and data not in (None, ""):
        try:
            number = excel_number(data)
        except (TypeError, ValueError):
            pass
    if number is not None and math.isfinite(number):
        write_numeric(cell, data)
    else:
        literal(cell, data)


def headers(ws, groups, depth=2):
    """Each group is (title, subheaders); an empty list is a fixed column."""
    widths = []
    for title, children in groups:
        start = len(widths) + 1
        if children:
            end = start + len(children) - 1
            ws.merge_cells(start_row=1, start_column=start, end_row=1, end_column=end)
            for offset, child in enumerate(children):
                literal(ws.cell(depth, start + offset), child)
                widths.append({"排查类别": 12, "排查类型": 12, "排查说明": 50, "排查备注": 25, "备注": 25}.get(child, 18))
        else:
            end = start
            if depth > 1:
                ws.merge_cells(start_row=1, start_column=start, end_row=depth, end_column=start)
            widths.append(38 if "名称" in title else 22 if "代码" in title else 16)
        literal(ws.cell(1, start), title)
    for col, width in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(col)].width = width
    return depth + 1


def style(ws, header_rows=2, freeze="D3", **options):
    style_table(ws, header_rows, freeze, **options)


def validate(store, page, indicators):
    if not isinstance(page, dict) or not isinstance(page.get("rows"), list) or not page["rows"]:
        raise ValueError("当前页面没有可导出的最终定级数据")
    companies = {row["company_id"] for row in store.companies}
    fields = {field["field_id"] for field in store.check_fields()}
    normal = {ind["indicator_id"] for ind in indicators if store.fields.get(ind["field_id"], {}).get("field_type") != "排查项"}
    seen = set()
    for row in page["rows"]:
        if not isinstance(row, dict) or row.get("company_id") not in companies or row["company_id"] in seen:
            raise ValueError("页面主体无效或重复，请刷新后重试")
        seen.add(row["company_id"])
        if not all(isinstance(row.get(key), dict) for key in ("source_values", "indicator_values", "indicators", "checks")):
            raise ValueError("页面导出数据不完整")
        if not all(isinstance(row["indicators"].get(iid), dict) and
                   {"raw_value", "score", "weighted"} <= row["indicators"][iid].keys() for iid in normal):
            raise ValueError("页面指标数据不完整")
        if not all(isinstance(row["checks"].get(fid), dict) and
                   {"value", "score"} <= row["checks"][fid].keys() for fid in fields):
            raise ValueError("页面排查数据不完整")
        if not {"base_score", "check_score", "final_score", "base_grade", "final_grade"} <= row.keys():
            raise ValueError("页面最终定级数据不完整")
    rules = page.get("grade_rules")
    if not isinstance(rules, dict) or not isinstance(rules.get("grades"), list) or not isinstance(rules.get("boundaries"), list):
        raise ValueError("页面等级规则格式不正确")
    if len(rules["boundaries"]) != (len(rules["grades"]) + 1 if rules["grades"] else 0):
        raise ValueError("页面等级边界不完整")
    for index, boundary in enumerate(rules["boundaries"]):
        if not isinstance(boundary, (int, float)) or not math.isfinite(boundary) or (index and boundary <= rules["boundaries"][index - 1]):
            raise ValueError("页面等级区间不规范")


def export_final_xlsx(store, page, indicators):
    validate(store, page, indicators)
    wb = Workbook()
    wb.remove(wb.active)
    sheets = {name: wb.create_sheet(name) for name in SHEETS}
    rows = page["rows"]
    normal = [ind for ind in indicators if store.fields.get(ind["field_id"], {}).get("field_type") != "排查项"]
    checks = store.check_fields()
    columns = store.data_entry_columns(indicators)
    period = text(page.get("period"))
    model_name = store.model["model_name"]

    ws = sheets["评级样本"]
    ws.append(["对象类型", "评级模型", "数据日期"])
    ws.append(["主体", model_name, period])
    literal(ws["B2"], model_name)
    ws.append([])
    ws.append(["序号", "主体名称", "原定级"])
    for index, row in enumerate(rows, 1):
        for col, data in enumerate((index, row.get("company_name"), row.get("original_grade")), 1):
            value(ws.cell(index + 4, col), data, numeric=col == 1)
    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 44
    ws.column_dimensions["C"].width = 22
    style(ws, (1, 4), "B5", integer_columns=(1,), centered_columns=(1,), blank_rows=(3,))

    ws = sheets["数据录入"]
    headers(ws, [("主体代码", []), ("主体名称", [])] +
            [(column["label"], ["指标值"] if column["kind"] == "indicator" else []) for column in columns])
    for r, row in enumerate(rows, 3):
        literal(ws.cell(r, 1), row["company_id"])
        literal(ws.cell(r, 2), row.get("company_name"))
        for col, column in enumerate(columns, 3):
            is_indicator = column["kind"] == "indicator"
            data = row["indicator_values"].get(column["indicator_id"], "") if is_indicator else row["source_values"].get(column["field_id"], "")
            value(ws.cell(r, col), data, numeric=is_indicator or numeric_field(column))
    style(ws, 2, "C3", indicator_columns=[col for col, column in enumerate(columns, 3) if column["kind"] == "indicator"])
    for col, column in enumerate(columns, 3):
        if column["kind"] == "indicator":
            ws.cell(1, col).comment = Comment(column.get("expression") or column.get("field_id") or "", "模型评级系统")

    ws = sheets["初步评级"]
    headers(ws, [(title, []) for title in ("序号", "主体名称", "初评得分", "初评等级")] +
            [(ind["label"], ["指标值", "赋分", "得分"]) for ind in normal], 3)
    for i, ind in enumerate(normal):
        start = 5 + 3 * i
        ws.merge_cells(start_row=2, start_column=start, end_row=2, end_column=start + 2)
        literal(ws.cell(2, start), f"权重：{format_4(decimal_number(ind['weight']) * 100)}%")
    for r, row in enumerate(rows, 4):
        for c, data in enumerate((r - 3, row.get("company_name"), row["base_score"], row["base_grade"]), 1):
            value(ws.cell(r, c), data, numeric=c in (1, 3))
        for i, ind in enumerate(normal):
            detail = row["indicators"][ind["indicator_id"]]
            for offset, key in enumerate(("raw_value", "score", "weighted")):
                value(ws.cell(r, 5 + 3 * i + offset), detail[key])
    style(ws, 3, "C4", integer_columns=(1,), centered_columns=(1,))

    ws = sheets["评级模型"]
    headers(ws, [(title, []) for title in ("序号", "指标类别", "指标名称", "指标权重", "指标取值公式", "关联字段", "最低分", "最高分")], 1)
    for r, ind in enumerate(indicators, 2):
        field = store.fields.get(ind["field_id"], {})
        data = (r - 1, field.get("field_type"), ind["label"], ind["weight"], ind["expression"], ind["field_id"], ind["score_min"], ind["score_max"])
        for c, item in enumerate(data, 1):
            value(ws.cell(r, c), item, numeric=c in (1, 4, 7, 8))
    ws.column_dimensions["E"].width = 90
    ws.column_dimensions["F"].width = 32
    style(ws, 1, "D2", integer_columns=(1,), centered_columns=(1,))

    ws = sheets["等级策略"]
    headers(ws, [(title, []) for title in ("数据日期", "策略名称", "评级", "左边界值包含方式", "左边界值", "右边界值", "右边界值包含方式")], 1)
    rules = page["grade_rules"]
    for i, grade in enumerate(rules["grades"]):
        data = (period, model_name + "等级策略", grade, "闭区间", rules["boundaries"][i], rules["boundaries"][i + 1], "闭区间" if i == len(rules["grades"]) - 1 else "开区间")
        for c, item in enumerate(data, 1):
            value(ws.cell(i + 2, c), item, numeric=c in (5, 6))
    ws.column_dimensions["B"].width = 44
    style(ws, 1, "D2")

    ws = sheets["批量排查"]
    headers(ws, [("主体代码", []), ("主体名称", [])] + [(field["label"], ["指标值", "得分"]) for field in checks])
    for r, row in enumerate(rows, 3):
        literal(ws.cell(r, 1), row["company_id"])
        literal(ws.cell(r, 2), row.get("company_name"))
        for i, field in enumerate(checks):
            check = row["checks"][field["field_id"]]
            value(ws.cell(r, 3 + 2 * i), check["value"], numeric=numeric_field(field))
            value(ws.cell(r, 4 + 2 * i), check["score"])
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 30
    style(ws, 2, "C3")

    ws = sheets["最终定级"]
    groups = [(title, []) for title in ("打分排名", "主体名称", "债券代码")]
    groups += [("指标：" + ind["label"], ["指标值", "得分"]) for ind in normal]
    groups += [("初评得分", []), ("初评等级", [])]
    groups += [("排查项：" + field["label"], ["指标值", "得分"]) for field in checks]
    groups += [(title, []) for title in ("排查得分", "最终得分", "最终定级", "在库定级", "历史定级", "调整方向", "入库状态", "评级结论")]
    headers(ws, groups)
    for r, row in enumerate(rows, 3):
        data = [(r - 2, True), (row.get("company_name"), False), (row.get("bond_id"), False)]
        for ind in normal:
            detail = row["indicators"][ind["indicator_id"]]
            data += [(detail["raw_value"], True), (detail["weighted"], True)]
        data += [(row["base_score"], True), (row["base_grade"], False)]
        for field in checks:
            check = row["checks"][field["field_id"]]
            data += [(check["value"], numeric_field(field)), (check["score"], True)]
        check_column = len(data) + 1
        data += [(row["check_score"], True), (row["final_score"], True), (row["final_grade"], False),
                 (row.get("original_grade"), False), ("", False), ("", False), ("", False), (row.get("conclusion", ""), False)]
        for c, (item, numeric) in enumerate(data, 1):
            value(ws.cell(r, c), item, numeric, "0.0000" if c == check_column else "General")
    style(ws, 2, "D3", integer_columns=(1,), centered_columns=(1,))
    wb.active = wb.sheetnames.index("最终定级")
    output = BytesIO()
    wb.save(output)
    wb.close()
    return output.getvalue()
