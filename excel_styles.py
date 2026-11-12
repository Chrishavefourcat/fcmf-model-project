"""Shared export styling based on the supplied final-rating workbook."""
import math
import unicodedata

from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from numeric_precision import write_numeric


HEADER_COLOR = "C0C0C0"
INDICATOR_HEADER_COLOR = "B9DCF7"
INDICATOR_BODY_COLOR = "E8F3FF"
NUMBER_FORMAT = "0.0000"


def text_width(value):
    return sum(2 if unicodedata.east_asian_width(char) in "WF" else 1 for char in value)


def style_table(ws, header_rows=2, freeze="C3", *, indicator_columns=(), integer_columns=(),
                centered_columns=(), blank_rows=(), numeric_columns=()):
    """Format visible numeric outputs; preserve identifiers and calculation state."""
    header_rows = set(range(1, header_rows + 1)) if isinstance(header_rows, int) else set(header_rows)
    indicator_columns, integer_columns = set(indicator_columns), set(integer_columns)
    centered_columns, blank_rows = set(centered_columns), set(blank_rows)
    numeric_columns = set(numeric_columns)
    side = Side(style="thin", color="000000")
    border = Border(left=side, right=side, top=side, bottom=side)
    header_fill = PatternFill("solid", fgColor=HEADER_COLOR)
    indicator_header = PatternFill("solid", fgColor=INDICATOR_HEADER_COLOR)
    indicator_body = PatternFill("solid", fgColor=INDICATOR_BODY_COLOR)
    white = PatternFill()
    normal_font = Font(name="宋体", size=11, color="000000")
    error_font = Font(name="宋体", size=11, color="D92D20", bold=True)
    widths = {col: ws.column_dimensions[get_column_letter(col)].width or 13
              for col in range(1, ws.max_column + 1)}
    merged = {area.start_cell.coordinate: area for area in ws.merged_cells.ranges}
    for row in ws:
        row_number = row[0].row
        if row_number in blank_rows or ws.row_dimensions[row_number].hidden:
            continue
        header = row_number in header_rows
        height = 27
        for cell in row:
            indicator = cell.column in indicator_columns
            if not header and cell.column not in integer_columns and (cell.data_type == "n" or cell.column in numeric_columns):
                write_numeric(cell, cell.value)
            numeric = cell.data_type == "n" and cell.value is not None
            cell.font = error_font if cell.value == "等级匹配异常" else normal_font
            cell.fill = (indicator_header if indicator else header_fill) if header else (indicator_body if indicator else white)
            cell.border = border
            cell.alignment = Alignment(horizontal="center" if header or cell.column in centered_columns else
                                       "right" if numeric else "left", vertical="center", wrap_text=True)
            if not header and numeric:
                if cell.column in integer_columns:
                    cell.number_format = "0"
                else:
                    cell.number_format = NUMBER_FORMAT
            if cell.value is None:
                continue
            area = merged.get(cell.coordinate)
            width = sum(widths[col] for col in range(area.min_col, area.max_col + 1)) if area else widths[cell.column]
            lines = sum(max(1, math.ceil(text_width(line) / max(6, width - 2)))
                        for line in str(cell.value).split("\n"))
            span = area.max_row - area.min_row + 1 if area else 1
            height = max(height, (lines * 16 + 6) / span)
        ws.row_dimensions[row_number].height = min(409, height)
    ws.freeze_panes = freeze
    ws.sheet_view.showGridLines = False
    ws.print_title_rows = f"1:{max(header_rows)}"
    ws.print_options.horizontalCentered = True
    ws.print_area = f"A1:{ws.cell(ws.max_row, ws.max_column).coordinate}"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
