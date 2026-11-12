"""Source launcher and compatibility imports for existing rating integrations."""

import sys

if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10+ is required. See the startup dependency checklist.")

from database import DEFAULT_BACKEND, ConnectionConfig, DatabaseBackend
from check_excel import export_checks_xlsx, import_checks_xlsx
from final_excel import export_final_xlsx
from rating.field_excel import cell_text, export_fields_xlsx, import_fields_xlsx, parse_fields_workbook
from rating.launcher import main
from rating.model_store import (
    STORES, TABLE_LABELS, DataStore, get_store, list_models, model_databases,
    model_metadata, single_row_statement, sql_ident, table_columns, table_data,
    table_delete, table_insert, table_update,
)
from rating.scoring import (
    TOKEN_RE, Formula, FormulaError, Match, RuleValidationEngine, ScoreEngine,
    resolve_rules, scoring_preview,
)
from rating.server import ApplicationServer, Handler, json_response, xlsx_response
from rating.settings import DB_NAME, ROOT, STATIC
from rating.values import latest_period, to_float


if __name__ == "__main__":
    raise SystemExit(main())
