"""Export a SQLite database as MySQL SQL; unrelated to the web application."""

import argparse
import sqlite3
from pathlib import Path


DEFAULT_DATABASE_NAME = "henan_chengtou_2026_model"


def qi(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def qs(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return "0x" + value.hex()
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    return "'" + text.replace("\\", "\\\\").replace("'", "''").replace("\x00", "") + "'"


def mysql_type(sqlite_type: str, indexed: bool) -> str:
    typ = (sqlite_type or "").upper()
    if "INT" in typ:
        return "BIGINT"
    if any(x in typ for x in ("REAL", "FLOA", "DOUB")):
        return "DOUBLE"
    if "BLOB" in typ:
        return "LONGBLOB"
    if indexed:
        return "VARCHAR(255)"
    return "LONGTEXT"


def export_sql(sqlite_path: Path, output_path: Path, database_name: str) -> None:
    # Read-only mode fails for a missing source instead of creating an empty DB.
    con = sqlite3.connect(sqlite_path.as_uri() + "?mode=ro", uri=True)
    try:
        _write_sql(con, output_path, database_name)
    finally:
        con.close()


def _write_sql(con: sqlite3.Connection, output_path: Path, database_name: str) -> None:
    cur = con.cursor()
    tables = [
        name
        for (name,) in cur.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]

    with output_path.open("w", encoding="utf-8", newline="\n") as out:
        out.write("SET NAMES utf8mb4;\n")
        out.write(f"CREATE DATABASE IF NOT EXISTS {qi(database_name)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\n")
        out.write(f"USE {qi(database_name)};\n")
        out.write("SET FOREIGN_KEY_CHECKS=0;\n\n")

        for table in tables:
            cols = cur.execute(f"PRAGMA table_info({qi(table)})").fetchall()
            indexes = cur.execute(f"PRAGMA index_list({qi(table)})").fetchall()
            pk_cols = [c[1] for c in cols if c[5]]
            indexed_cols = set(pk_cols)
            for _, index_name, unique, *_ in indexes:
                if unique:
                    indexed_cols.update(
                        row[2]
                        for row in cur.execute(f"PRAGMA index_info({qi(index_name)})").fetchall()
                    )

            out.write(f"DROP TABLE IF EXISTS {qi(table)};\n")
            out.write(f"CREATE TABLE {qi(table)} (\n")
            lines = []
            for col in cols:
                _, name, typ, notnull, default, pk = col
                line = f"  {qi(name)} {mysql_type(typ, name in indexed_cols)}"
                if notnull:
                    line += " NOT NULL"
                if default is not None and str(default).upper() != "NULL":
                    line += f" DEFAULT {default}"
                lines.append(line)

            if pk_cols:
                lines.append("  PRIMARY KEY (" + ", ".join(qi(c) for c in pk_cols) + ")")

            for _, index_name, unique, *_ in indexes:
                if not unique:
                    continue
                index_cols = [
                    row[2]
                    for row in cur.execute(f"PRAGMA index_info({qi(index_name)})").fetchall()
                ]
                if index_cols and index_cols != pk_cols:
                    lines.append(
                        f"  UNIQUE KEY {qi(index_name)} ("
                        + ", ".join(qi(c) for c in index_cols)
                        + ")"
                    )

            out.write(",\n".join(lines))
            out.write("\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n")

            col_names = [c[1] for c in cols]
            select_cols = ", ".join(qi(c) for c in col_names)
            rows = cur.execute(f"SELECT {select_cols} FROM {qi(table)}").fetchall()
            if rows:
                out.write(f"INSERT INTO {qi(table)} ({', '.join(qi(c) for c in col_names)}) VALUES\n")
                values = [
                    "  (" + ", ".join(qs(v) for v in row) + ")"
                    for row in rows
                ]
                out.write(",\n".join(values))
                out.write(";\n")
            out.write("\n")

        out.write("SET FOREIGN_KEY_CHECKS=1;\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sqlite_path", type=Path, help="Input SQLite database file")
    parser.add_argument("output_path", type=Path, help="Output MySQL .sql file")
    parser.add_argument("--database-name", default=DEFAULT_DATABASE_NAME,
                        help=f"Target database name (default: {DEFAULT_DATABASE_NAME})")
    args = parser.parse_args()
    sqlite_path, output_path = args.sqlite_path.resolve(), args.output_path.resolve()
    if not sqlite_path.is_file():
        parser.error(f"SQLite input file does not exist: {sqlite_path}")
    if sqlite_path == output_path:
        parser.error("Input database and SQL output must be different files")
    if not args.database_name.strip():
        parser.error("Database name cannot be empty")
    try:
        export_sql(sqlite_path, output_path, args.database_name)
    except (OSError, sqlite3.Error) as exc:
        parser.exit(1, f"Export failed: {exc}\n")
    print(output_path)


if __name__ == "__main__":
    main()
