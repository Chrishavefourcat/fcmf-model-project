"""Fourth-step check sheets, keyed by field_id for round-trip imports."""

import json
from io import BytesIO

from excel_styles import style_table
from numeric_precision import decimal_number, input_value, numeric_field, write_numeric


HEADERS = ("指标值", "得分")
META_SHEET = "_排查导入标识"
STATE_SHEET = "_排查得分快照"


def text(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def literal(cell, value):
    cell.value = text(value)
    cell.data_type = "s"


def write_value(cell, value, numeric=True):
    if not numeric or not write_numeric(cell, value):
        if value not in (None, ""):
            literal(cell, value)


def same_value(left, right, numeric=True):
    """Excel blanks and equivalent numeric representations are unchanged inputs."""
    if left in (None, "") and right in (None, ""):
        return True
    number = decimal_number(left)
    if numeric and number is not None and decimal_number(right) is not None:
        return number == decimal_number(right)
    return text(left) == text(right)


def export_checks_xlsx(store, company_ids, period="", overrides=None, notes=None, page_data=None, rule_overrides=None):
    from openpyxl import Workbook

    fields = store.check_fields()
    if not fields:
        raise ValueError("当前模型没有排查项")
    overrides = overrides or {}
    companies = {company["company_id"]: company for company in store.companies}
    page_rows = None
    if page_data is not None:
        if not isinstance(page_data, dict) or not isinstance(page_data.get("fields"), list) or not isinstance(page_data.get("rows"), list):
            raise ValueError("页面排查数据格式不正确，请刷新后重试")
        known_fields = {field["field_id"]: field for field in fields}
        fields, field_ids = [], set()
        for field in page_data["fields"]:
            if not isinstance(field, dict) or field.get("field_id") not in known_fields or field["field_id"] in field_ids:
                raise ValueError("页面排查项与当前模型不匹配，请刷新后重试")
            field_ids.add(field["field_id"])
            fields.append({**known_fields[field["field_id"]], "label": text(field.get("label"))})
        if not fields:
            raise ValueError("当前页面没有可导出的排查项")
        page_rows = {}
        for row in page_data["rows"]:
            if not isinstance(row, dict) or row.get("company_id") not in companies or row["company_id"] in page_rows:
                raise ValueError("页面主体无效或重复，请刷新后重试")
            checks = row.get("checks")
            if not isinstance(checks, dict) or any(not isinstance(checks.get(fid), dict) or
                    not {"value", "score"} <= checks[fid].keys() for fid in field_ids):
                raise ValueError("页面排查数据不完整，请刷新后重试")
            page_rows[row["company_id"]] = row
        company_ids = list(page_rows)
    wb = Workbook()
    ws = wb.active
    ws.title = "批量排查"
    ws.merge_cells("A1:A2")
    ws.merge_cells("B1:B2")
    literal(ws["A1"], "主体代码")
    literal(ws["B1"], "主体名称")
    meta = wb.create_sheet(META_SHEET)
    meta.append(["check_template", 2])
    meta.append(["period", period])
    meta.append(["value_column", "field_id", "label"])
    meta.sheet_state = "veryHidden"
    state = wb.create_sheet(STATE_SHEET)
    state.append(["company_id", "field_id", "value_json", "score_json", "score_overridden"])
    state.sheet_state = "veryHidden"
    for index, field in enumerate(fields):
        column = 3 + index * 2
        ws.merge_cells(start_row=1, start_column=column, end_row=1, end_column=column + 1)
        literal(ws.cell(1, column), field["label"] or field["field_id"])
        for offset, header in enumerate(HEADERS):
            literal(ws.cell(2, column + offset), header)
            ws.column_dimensions[ws.cell(2, column + offset).column_letter].width = 18
        meta.append([column, field["field_id"], field["label"] or field["field_id"]])

    indicators = None
    if page_rows is None:
        from rating.scoring import resolve_rules
        indicators = resolve_rules(store, rule_overrides)

    seen = set()
    for company_id in company_ids:
        if company_id in seen or company_id not in companies:
            continue
        seen.add(company_id)
        row = ws.max_row + 1
        literal(ws.cell(row, 1), company_id)
        ws.cell(row, 1).number_format = "@"
        literal(ws.cell(row, 2), page_rows[company_id].get("company_name", "") if page_rows is not None else companies[company_id]["company_name"])
        checks = page_rows[company_id]["checks"] if page_rows is not None else {
            check["field_id"]: check for check in store.check_data(company_id, period, overrides.get(company_id, {}), indicators=indicators)
        }
        for index, field in enumerate(fields):
            column, field_id = 3 + index * 2, field["field_id"]
            check = checks[field_id]
            write_value(ws.cell(row, column), check["value"], numeric=numeric_field(field))
            write_value(ws.cell(row, column + 1), check["score"])
            state_row = state.max_row + 1
            for offset, item in enumerate((company_id, field_id, json.dumps(check["value"], ensure_ascii=False, default=str),
                                           json.dumps(check["score"], ensure_ascii=False, default=str)), 1):
                literal(state.cell(state_row, offset), item)
            state.cell(state_row, 5, bool(check.get("score_overridden")))

    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 30
    style_table(ws, 2, "C3")
    bio = BytesIO()
    wb.save(bio)
    wb.close()
    return bio.getvalue()


def import_checks_xlsx(store, data, period=""):
    from openpyxl import load_workbook

    wb = load_workbook(BytesIO(data), data_only=False)
    try:
        ws = wb["批量排查"] if "批量排查" in wb.sheetnames else wb.active
        if ws.max_row < 3 or text(ws["A1"].value).strip() != "主体代码" or text(ws["B1"].value).strip() != "主体名称":
            raise ValueError("Excel格式不正确，请使用第四步导出的排查模板")
        fields = {field["field_id"]: field for field in store.check_fields()}
        metadata = {}
        if META_SHEET in wb.sheetnames:
            meta = wb[META_SHEET]
            if meta["A1"].value != "check_template" or meta["B1"].value not in (1, 2):
                raise ValueError("排查模板标识不正确，请重新导出模板")
            if period and text(meta["B2"].value) != period:
                raise ValueError("Excel数据日期与当前页面不一致，请切换到对应日期或重新导出")
            for column, field_id, label in meta.iter_rows(min_row=4, max_col=3, values_only=True):
                if column is not None:
                    metadata[int(column)] = (text(field_id), text(label))
        states = {}
        if STATE_SHEET in wb.sheetnames:
            for company_id, field_id, value_json, score_json, manual in wb[STATE_SHEET].iter_rows(min_row=2, max_col=5, values_only=True):
                try:
                    states[(text(company_id), text(field_id))] = (json.loads(value_json), json.loads(score_json), bool(manual))
                except (TypeError, ValueError):
                    raise ValueError("排查得分快照损坏，请重新导出模板") from None
        labels = {}
        for field in fields.values():
            # Accept earlier templates whose headings used the indicator label.
            field_labels = {field["label"], field["field_label"], field["field_id"]}
            field_labels.update(indicator["label"] for indicator in store.indicators
                                if indicator["field_id"] == field["field_id"])
            for label in field_labels:
                labels.setdefault(label, []).append(field["field_id"])
        aliases = {"名单内主体债务融资工具余额新增": "parent_dfi_increment", "短期债券接续压力": "parent_dfi_short"}
        groups = []
        for column in range(3, ws.max_column + 1):
            label = text(ws.cell(1, column).value).strip()
            if not label:
                continue
            end = next((col for col in range(column + 1, ws.max_column + 1) if ws.cell(1, col).value is not None), ws.max_column + 1)
            columns = {text(ws.cell(2, col).value).strip(): col for col in range(column, end)}
            modern = "指标值" in columns and "得分" in columns
            if not modern and "排查分" not in columns:
                raise ValueError(f"排查项“{label}”缺少指标值或得分列")
            value_column = columns["指标值"] if modern else columns["排查分"]
            if metadata:
                field_id, expected_label = metadata.get(value_column, (None, None))
                if field_id not in fields or expected_label != label:
                    raise ValueError(f"排查项“{label}”与当前模型不匹配，或模板列顺序已调整")
            else:
                matches = set(labels.get(label, []))
                if label in aliases and aliases[label] in fields:
                    matches.add(aliases[label])
                if len(matches) != 1:
                    raise ValueError(f"排查项“{label}”无法匹配当前模型，请使用本模型导出的模板")
                field_id = matches.pop()
            if any(existing[0] == field_id for existing in groups):
                raise ValueError(f"排查项“{label}”重复，请检查模板")
            groups.append((field_id, columns, modern))
        if not groups:
            raise ValueError("Excel中没有匹配的排查项")
        companies = {company["company_id"] for company in store.companies}
        overrides, scores, score_overrides, notes, seen, skipped = {}, {}, {}, {}, set(), 0
        for row in range(3, ws.max_row + 1):
            company_id = text(ws.cell(row, 1).value).strip()
            if not company_id:
                continue
            if company_id in seen:
                raise ValueError(f"第 {row} 行主体代码重复：{company_id}")
            seen.add(company_id)
            if company_id not in companies:
                skipped += 1
                continue
            values, row_scores, row_manual, row_notes = {}, {}, {}, {}
            for field_id, columns, modern in groups:
                if "排查类别" in columns and text(ws.cell(row, columns["排查类别"]).value).strip() != "得分":
                    raise ValueError(f"第 {row} 行的排查类别必须为“得分”")
                cell = ws.cell(row, columns["指标值"] if modern else columns["排查分"])
                if cell.data_type in {"f", "e"}:
                    raise ValueError(f"第 {row} 行指标值含公式或错误值，请粘贴为数值后导入")
                raw_value = input_value(cell)
                values[field_id] = text(raw_value)
                if modern:
                    score_cell = ws.cell(row, columns["得分"])
                    score = input_value(score_cell)
                    if score_cell.data_type in {"f", "e"} or score not in (None, "") and decimal_number(score) is None:
                        raise ValueError(f"第 {row} 行得分必须为数值或空白，请粘贴为数值后导入")
                    snapshot = states.get((company_id, field_id))
                    manual = score not in (None, "") if snapshot is None else (
                        not same_value(score, snapshot[1]) or bool(snapshot[2]) and
                        same_value(raw_value, snapshot[0], numeric=numeric_field(fields[field_id])))
                    row_scores[field_id] = None if score in (None, "") else text(score)
                    row_manual[field_id] = manual
                else:
                    # Earlier templates used 排查分 as the input, rather than a calculated score.
                    row_manual[field_id] = False
                if "排查备注" in columns:
                    cell = ws.cell(row, columns["排查备注"])
                    if cell.data_type in {"f", "e"}:
                        raise ValueError(f"第 {row} 行排查备注含公式或错误值，请改为文本后导入")
                    row_notes[field_id] = text(cell.value)
            overrides[company_id], scores[company_id], score_overrides[company_id], notes[company_id] = values, row_scores, row_manual, row_notes
        return {"ok": True, "rows": len(overrides), "overrides": overrides, "scores": scores,
                "score_overrides": score_overrides, "notes": notes, "skipped_rows": skipped}
    finally:
        wb.close()
