"""Data-entry workbook import and export."""

import math
from io import BytesIO

from .scoring import ScoreEngine, resolve_rules
from .values import to_float


def cell_text(value):
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def export_fields_xlsx(store, company_ids, period="", overrides=None, rule_overrides=None, indicator_values=None):
    from openpyxl import Workbook
    from openpyxl.comments import Comment
    from excel_styles import style_table
    from numeric_precision import excel_number, numeric_field

    overrides = overrides or {}
    if indicator_values is not None and (not isinstance(indicator_values, dict) or
            any(not isinstance(row, dict) for row in indicator_values.values())):
        raise ValueError("页面指标值格式不正确，请刷新后重试")
    indicators = resolve_rules(store, rule_overrides)
    columns = []
    for column in store.data_entry_columns(indicators):
        if column["kind"] == "source":
            columns.append(column)
        else:
            columns.append({**column, "metric": "raw", "export_label": (column["label"] or column["indicator_id"]) + "\n指标值"})
    companies = {c["company_id"]: c for c in store.companies}
    wb = Workbook()
    ws = wb.active
    ws.title = "数据录入"

    headers = ["主体ID（请勿修改）", "主体名称（请勿修改）"] + [column.get("export_label") or column["label"] or column["field_id"] for column in columns]
    keys = ["company_id", "company_name"] + [("indicator:" + column["indicator_id"] + (":" + column["metric"] if column["metric"] != "score" else "")) if column["kind"] == "indicator" else column["field_id"] for column in columns]
    ws.append(headers)
    ws.append(keys)
    ws.row_dimensions[2].hidden = True

    for index, cell in enumerate(ws[1]):
        if index >= 2 and columns[index - 2]["kind"] == "indicator":
            column = columns[index - 2]
            cell.comment = Comment(column.get("expression") or column["field_id"] or "", "模型评级系统")
            cell.comment.width, cell.comment.height = 480, 200

    for company_id in company_ids:
        company = companies.get(company_id)
        if not company:
            continue
        row_overrides = overrides.get(company_id, {}) or {}
        calculated = {detail["indicator_id"]: detail
                      for detail in ScoreEngine(store, company_id, period or None, row_overrides, indicators=indicators).score()["details"]}
        values = []
        for column in columns:
            if column["kind"] == "indicator":
                detail = calculated[column["indicator_id"]]
                if indicator_values is not None:
                    value = indicator_values.get(company_id, {}).get(column["indicator_id"], "")
                    numeric = to_float(value)
                    values.append(excel_number(value) if numeric is not None and math.isfinite(numeric) else value)
                else:
                    value = detail["score"]
                    values.append(excel_number(value) if isinstance(value, (int, float)) else value)
            else:
                field_id = column["field_id"]
                values.append(row_overrides.get(field_id, store.field_display_value(company_id, field_id, period)))
        ws.append([company_id, company["company_name"]] + values)
        for cell in ws[ws.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"

    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["B"].width = 34
    for idx in range(3, len(columns) + 3):
        ws.column_dimensions[ws.cell(1, idx).column_letter].width = 26
    style_table(ws, 1, "C3", indicator_columns=[col for col, column in enumerate(columns, 3) if column["kind"] == "indicator"],
                numeric_columns=[col for col, column in enumerate(columns, 3) if column["kind"] == "indicator" or numeric_field(column)])

    info = wb.create_sheet("指标信息")
    info.append(["序号", "指标ID", "指标名称", "指标权重", "指标取值公式", "关联字段"])
    for index, indicator in enumerate(indicators, 1):
        info.append([index, indicator["indicator_id"], indicator["label"], indicator["weight"], indicator["expression"] or "", indicator["field_id"]])
    for row in info:
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    for letter, width in zip("ABCDEF", (8, 30, 44, 16, 100, 30)):
        info.column_dimensions[letter].width = width
    style_table(info, 1, "A2", integer_columns=(1,), centered_columns=(1,))

    bio = BytesIO()
    wb.save(bio)
    wb.close()
    return bio.getvalue()


def import_fields_xlsx(store, data):
    from openpyxl import load_workbook

    wb = load_workbook(BytesIO(data), data_only=True)
    try:
        return parse_fields_workbook(store, wb)
    finally:
        wb.close()


def parse_fields_workbook(store, wb):
    from numeric_precision import input_value
    ws = wb["数据录入"] if "数据录入" in wb.sheetnames else wb.active
    if ws.max_row < 3 or ws.max_column < 3:
        raise ValueError("Excel格式不正确，请使用导出的模板修改后再导入")

    keys = [cell_text(ws.cell(2, col).value).strip() for col in range(1, ws.max_column + 1)]
    if keys[0] != "company_id":
        raise ValueError("Excel缺少主体ID标识，请使用导出的模板修改后再导入")

    valid_field_ids = set(store.fields)
    indicator_columns = {}
    for indicator in store.indicators:
        indicator_id = indicator["indicator_id"]
        # Current exports contain :raw; older templates may also have an
        # unqualified score column. Never import the old weighted-score column.
        for key in (f"indicator:{indicator_id}", f"indicator:{indicator_id}:raw"):
            if key in keys:
                indicator_columns[indicator_id] = keys.index(key) + 1
                break
    overrides = {}
    indicator_values = {}
    for row in range(3, ws.max_row + 1):
        company_id = cell_text(ws.cell(row, 1).value).strip()
        if not company_id:
            continue
        values = {}
        for col in range(3, ws.max_column + 1):
            field_id = keys[col - 1]
            if field_id in valid_field_ids:
                values[field_id] = cell_text(input_value(ws.cell(row, col)))
        if values:
            overrides[company_id] = values
        if indicator_columns:
            indicator_values[company_id] = {
                indicator_id: cell_text(ws.cell(row, col).value)
                for indicator_id, col in indicator_columns.items()
            }

    return {"ok": True, "rows": len(set(overrides) | set(indicator_values)),
            "overrides": overrides, "indicator_values": indicator_values}
