"""SQLite model files and portable database operations."""

import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from threading import RLock

from sqlalchemy import MetaData, Table, create_engine
from sqlalchemy.pool import NullPool


@dataclass(frozen=True)
class ConnectionConfig:
    directory: str = ""

    def validate(self):
        if self.directory:
            path = Path(self.directory)
            if path.is_dir() or (path.is_file() and path.suffix.lower() == ".db"):
                return
        raise ValueError("请选择存放 SQLite 模型文件的文件夹或单个 .db 文件")


def text_value(value):
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


class DatabaseBackend:
    def __init__(self, config):
        self.config = config
        self.stores = {}
        self.lock = RLock()
        self._engines = {}
        self._tables = {}

    def sqlite_files(self):
        self.config.validate()
        source = Path(self.config.directory)
        if source.is_file():
            return {source.stem: source.resolve()}
        files = {}
        for path in sorted(source.iterdir()):
            if path.is_file() and path.suffix.lower() == ".db":
                if path.stem in files:
                    raise ValueError(f"文件夹中有多个名为 {path.stem} 的模型，请避免重名")
                files[path.stem] = path.resolve()
        return files

    def engine(self, database=None):
        self.config.validate()
        with self.lock:
            if database not in self._engines:
                path = self.sqlite_files().get(database)
                if path is None:
                    raise ValueError("所选 SQLite 模型文件不存在")
                uri = path.as_uri() + "?mode=rw"
                engine = create_engine(
                    "sqlite+pysqlite://",
                    creator=lambda uri=uri: sqlite3.connect(uri, uri=True, check_same_thread=False, timeout=15),
                    poolclass=NullPool,
                )
                self._engines[database] = engine
            return self._engines[database]

    def rows(self, sql, database=None):
        connection = self.engine(database).raw_connection()
        try:
            cursor = connection.cursor()
            try:
                cursor.execute(sql)
                rows = []
                while True:
                    if cursor.description:
                        rows.extend([[text_value(value) for value in row] for row in cursor.fetchall()])
                    if not hasattr(cursor, "nextset") or not cursor.nextset():
                        break
                connection.commit()
                return rows
            finally:
                cursor.close()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def databases(self):
        return list(self.sqlite_files())

    def table(self, database, name):
        with self.lock:
            key = (database, name)
            if key not in self._tables:
                self._tables[key] = Table(name, MetaData(), autoload_with=self.engine(database))
            return self._tables[key]

    def columns(self, database, name):
        table = self.table(database, name)
        return [{"name": col.name, "type": str(col.type), "nullable": "YES" if col.nullable else "NO",
                 "key": "PRI" if col.primary_key else ""} for col in table.columns]

    def execute(self, database, *statements):
        with self.engine(database).begin() as connection:
            for statement in statements:
                connection.execute(statement)

    def select(self, database, statement):
        with self.engine(database).connect() as connection:
            return [{key: text_value(value) for key, value in row.items()}
                    for row in connection.execute(statement).mappings()]

    def close(self):
        with self.lock:
            for engine in self._engines.values():
                engine.dispose()
            self._engines.clear()
            self._tables.clear()
            self.stores.clear()


DEFAULT_BACKEND = DatabaseBackend(ConnectionConfig(directory=os.environ.get("MODEL_DIRECTORY", "")))
