"""Model discovery, cached data and SQLite table operations."""

from datetime import datetime
from threading import RLock

from sqlalchemy import String, and_, cast, false, func, literal_column, or_, select, tuple_

from database import DEFAULT_BACKEND
from .scoring import TOKEN_RE, ScoreEngine
from .settings import DB_NAME
from .values import to_float


def sql_ident(value) -> str:
    text = str(value)
    if text not in {"company", "field", "field_value", "grade", "indicator", "model"}:
        raise ValueError("不允许访问该表")
    return "`" + text.replace("`", "``") + "`"

def model_databases(backend=DEFAULT_BACKEND):
    return backend.databases()


def model_metadata(database, backend=DEFAULT_BACKEND):
    rows = backend.rows(
        "SELECT model_id,model_name,base_year,update_time FROM model "
        "ORDER BY update_time DESC,model_id DESC LIMIT 1", database
    )
    if not rows:
        raise ValueError(f"模型数据库 {database} 的 model 表没有数据")
    row = rows[0]
    path = backend.sqlite_files()[database]
    return {
        "database": database,
        "file_name": path.name,
        "database_path": str(path),
        "model_id": row[0],
        "model_name": row[1] or database,
        "base_year": int(to_float(row[2]) or 2025),
        "update_time": row[3] or "",
    }


def list_models(backend=DEFAULT_BACKEND):
    models = []
    for database, path in backend.sqlite_files().items():
        if not backend.rows("SELECT 1 FROM model LIMIT 1", database):
            raise ValueError(f"模型数据库 {database} 的 model 表没有数据")
        models.append({"database": database, "file_name": path.name, "database_path": str(path)})
    return sorted(models, key=lambda model: (model["file_name"].casefold(), model["file_name"]))


class DataStore:
    def __init__(self, database=DB_NAME, backend=DEFAULT_BACKEND):
        self.database = database
        self.backend = backend
        self.lock = RLock()
        self.reload()

    def rows(self, sql):
        return self.backend.rows(sql, self.database)

    def execute(self, *statements):
        return self.backend.execute(self.database, *statements)

    def reload(self):
        self.model = model_metadata(self.database, self.backend)
        self.companies = [
            {"company_id": r[0], "company_name": r[1], "bond_id": r[2]}
            for r in self.rows("SELECT company_id, company_name, bond_id FROM company ORDER BY company_name")
        ]
        field_table = self.backend.table(self.database, "field")
        field_remark = "remark" if "remark" in field_table.c else "NULL"
        self.fields = {
            r[0]: {
                "field_id": r[0],
                "label": r[1],
                "field_type": r[2],
                "value_type": r[3],
                "unit": r[4],
                "expression": r[5] if len(r) > 5 else "",
                "default_value": r[6] if len(r) > 6 else "",
                "remark": r[7] or "",
            }
            for r in self.rows(f"SELECT field_id,label,field_type,value_type,unit,expression,default_value,{field_remark} FROM field ORDER BY field_id")
        }
        self.indicators = [
            {
                "indicator_id": r[0],
                "label": r[1],
                "field_id": r[2],
                "weight": to_float(r[3]) or 0,
                "expression": r[4],
                "score_min": to_float(r[5]),
                "score_max": to_float(r[6]),
                "rounding": r[7],
                "remark": r[8],
            }
            for r in self.rows("SELECT indicator_id,label,field_id,weight,expression,score_min,score_max,rounding,remark FROM indicator ORDER BY indicator_id")
        ]
        self.reload_grades()
        self.base_year = self.model["base_year"]
        self.values = {}
        self.value_remarks = {}
        value_table = self.backend.table(self.database, "field_value")
        value_remark = "remark" if "remark" in value_table.c else "NULL"
        for company_id, field_id, period, value, remark in self.rows(f"SELECT company_id,field_id,period_end,field_value,{value_remark} FROM field_value"):
            self.values.setdefault(company_id, {}).setdefault(field_id, {})[period or ""] = value
            self.value_remarks.setdefault(company_id, {}).setdefault(field_id, {})[period or ""] = remark or ""

    def reload_grades(self):
        self.grades = [
            {"status": r[0], "grade": r[1], "threshold": to_float(r[2]), "inclusive": r[3], "remark": r[4] if len(r) > 4 else ""}
            for r in self.rows("SELECT status,grade,threshold,inclusive,remark FROM grade ORDER BY threshold IS NULL, threshold")
        ]

    def search_companies(self, q="", limit=80):
        q = q.strip().lower()
        rows = self.companies
        if q:
            rows = [
                c for c in rows
                if q in c["company_name"].lower() or q in c["company_id"].lower() or q in (c["bond_id"] or "").lower()
            ]
        return rows if limit is None else rows[:limit]

    def scoring_fields(self, indicators=None):
        return [column for column in self.data_entry_columns(indicators) if column["kind"] == "source"]

    def data_entry_columns(self, indicators=None):
        """Place each input once, immediately before its first consuming indicator."""
        columns, seen = [], set()
        for indicator in self.indicators if indicators is None else indicators:
            expression = indicator.get("expression") or indicator.get("field_id") or ""
            for match in TOKEN_RE.finditer(expression):
                field_id = match.group(1)
                if field_id != "Y" and field_id in self.fields and field_id not in seen:
                    columns.append({**self.fields[field_id], "kind": "source"})
                    seen.add(field_id)
            columns.append({**indicator, "kind": "indicator"})
        return columns

    def check_fields(self, indicators=None):
        order = ["external_lending", "credit_spread", "total_fin_cf_net_2y", "ibd_growth",
                 "implied_rating", "debt_negative_score", "private_relief", "financial_stability",
                 "tax_arrears_score", "parent_dfi_increment", "parent_dfi_short", "others_score"]
        fields = []
        available = sorted(self.indicators if indicators is None else indicators,
                           key=lambda indicator: indicator["indicator_id"])
        for field in self.fields.values():
            if field.get("field_type") != "排查项":
                continue
            matches = [indicator for indicator in available if indicator["field_id"] == field["field_id"]]
            indicator_id = matches[0]["indicator_id"] if matches else None
            order_id = indicator_id or field["field_id"]
            fields.append({**field, "field_label": field["label"],
                           "label": field["label"],
                           "indicator_id": indicator_id,
                           "indicator_ids": [indicator["indicator_id"] for indicator in matches],
                           "expression": (matches[0].get("expression") or "") if matches else "",
                           "_order": order.index(order_id) if order_id in order else len(order)})
        return [{key: value for key, value in field.items() if key != "_order"}
                for field in sorted(fields, key=lambda item: (item["_order"], item["field_id"]))]

    def check_value(self, company_id, field_id, period="", overrides=None):
        values = overrides or {}
        value = values[field_id] if field_id in values else self.field_display_value(company_id, field_id, period)
        if value in (None, ""):
            value = self.fields[field_id].get("default_value")
        return 0 if value in (None, "") else value

    def check_note(self, company_id, field_id, period=""):
        notes = self.value_remarks.get(company_id, {}).get(field_id, {})
        return notes.get(period or "", "")

    def field_input_value(self, company_id, field_id, period="", overrides=None):
        """Keep missing editable inputs separate from calculation defaults."""
        values = overrides or {}
        value = values[field_id] if field_id in values else self.field_display_value(company_id, field_id, period)
        return "" if value is None else value

    def check_data(self, company_id, period="", overrides=None, *, indicators=None, engine=None):
        """Return editable inputs and unweighted formula scores for the check page.

        Reuse a request's engine (and its temporary rules) when provided. Standalone
        exports can provide resolved indicators without invoking a full score run.
        """
        if engine is None:
            engine = ScoreEngine(self, company_id, period or None, overrides, indicators=indicators)
        elif overrides is None:
            overrides = engine.overrides
        fields = self.check_fields(engine.indicators)
        return [{**field, "value": self.field_input_value(company_id, field["field_id"], period, overrides),
                 "score": engine.check_score(field),
                 "note": self.check_note(company_id, field["field_id"], period)} for field in fields]

    def field_display_value(self, company_id, field_id, period=""):
        raw = self.values.get(company_id, {}).get(field_id, {})
        if period and period in raw:
            return raw[period]
        if "" in raw and not (period and self.fields.get(field_id, {}).get("field_type") == "排查项"):
            return raw[""]
        return ""

    def field_matrix(self, company_ids, period="", indicators=None, results=None):
        companies = [c for c in self.companies if c["company_id"] in company_ids]
        fields = self.scoring_fields(indicators)
        return {
            "fields": fields,
            "field_labels": {field_id: field["label"] or field_id for field_id, field in self.fields.items()},
            "columns": self.data_entry_columns(indicators),
            "rows": [
                {
                    "company": company,
                    "values": {
                        field["field_id"]: self.field_display_value(company["company_id"], field["field_id"], period)
                        for field in fields
                    },
                    "indicator_values": {detail["indicator_id"]: detail["score"]
                                         for detail in (results[company["company_id"]] if results is not None else
                                                        ScoreEngine(self, company["company_id"], period or None, indicators=indicators).score())["details"]},
                }
                for company in companies
            ],
        }

    def upsert_field_value(self, company_id, field_id, value, period=""):
        period = period or ""
        table = self.backend.table(self.database, "field_value")
        self.execute(
            table.delete().where(table.c.company_id == company_id, table.c.field_id == field_id,
                                 func.coalesce(table.c.period_end, "") == period),
            table.insert().values(company_id=company_id, field_id=field_id, period_end=period,
                                  field_value=value, update_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                                  skip_expression=0, remark="应用修改"),
        )
        self.values.setdefault(company_id, {}).setdefault(field_id, {})[period] = value

    def update_indicator(self, indicator_id, weight=None, expression=None):
        values = {}
        if weight is not None:
            values["weight"] = float(weight)
        if expression is not None:
            values["expression"] = expression
        if not values:
            return
        values["update_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        table = self.backend.table(self.database, "indicator")
        self.execute(table.update().where(table.c.indicator_id == indicator_id).values(**values))
        self.reload()


STORES = DEFAULT_BACKEND.stores


def get_store(database, backend=DEFAULT_BACKEND):
    if database not in model_databases(backend):
        raise ValueError("所选模型数据库不存在或无法访问")
    with backend.lock:
        if database not in backend.stores:
            backend.stores[database] = DataStore(database, backend)
        return backend.stores[database]


TABLE_LABELS = {
    "company": "主体库",
    "field": "数字字段库",
    "field_value": "数据库",
    "indicator": "指标库",
    "model": "模型设置",
    "grade": "等级策略",
}


def table_columns(store, table):
    sql_ident(table)
    return store.backend.columns(store.database, table)


def table_data(store, table, q="", limit=100):
    columns = table_columns(store, table)
    relation = store.backend.table(store.database, table)
    statement = select(relation)
    if q:
        statement = statement.where(or_(*(cast(col, String).like(f"%{q}%") for col in relation.columns)))
    rows = store.backend.select(store.database, statement.limit(max(1, min(int(limit), 500))))
    return {
        "table": table,
        "label": TABLE_LABELS.get(table, table),
        "columns": columns,
        "rows": rows,
    }


def table_insert(store, table, row):
    sql_ident(table)
    cols = [k for k, v in row.items() if v is not None and v != ""]
    if not cols:
        raise ValueError("没有可新增的数据")
    relation = store.backend.table(store.database, table)
    store.execute(relation.insert().values(**{col: row[col] for col in cols}))
    store.reload()


def single_row_statement(store, relation, original, statement):
    predicates = [or_(relation.c[key].is_(None), relation.c[key] == "") if value in (None, "")
                  else relation.c[key] == value for key, value in original.items()]
    predicate = and_(*predicates) if predicates else false()
    keys = list(relation.primary_key.columns)
    if keys:
        predicate = tuple_(*keys).in_(select(*keys).where(predicate).limit(1))
    else:
        rowid = literal_column("rowid")
        predicate = rowid.in_(select(rowid).select_from(relation).where(predicate).limit(1))
    return statement.where(predicate)


def table_update(store, table, original, row):
    sql_ident(table)
    cols = [k for k in row.keys()]
    if not cols:
        raise ValueError("没有可保存的数据")
    relation = store.backend.table(store.database, table)
    store.execute(single_row_statement(store, relation, original, relation.update().values(**row)))
    store.reload()


def table_delete(store, table, original):
    sql_ident(table)
    relation = store.backend.table(store.database, table)
    store.execute(single_row_statement(store, relation, original, relation.delete()))
    store.reload()
