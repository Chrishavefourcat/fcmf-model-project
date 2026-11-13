"""Local HTTP API, session protection and static browser page delivery."""

import json
import secrets
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from urllib.parse import parse_qs, quote, urlparse

from database import ConnectionConfig, DatabaseBackend
from check_excel import export_checks_xlsx, import_checks_xlsx
from download_names import timestamped_filename
from final_excel import export_final_xlsx

from .field_excel import export_fields_xlsx, import_fields_xlsx
from .model_store import TABLE_LABELS, get_store, list_models, table_data, table_delete, table_insert, table_update
from .native_picker import NativeSourcePicker
from .scoring import ScoreEngine, resolve_rules, scoring_preview
from .settings import DB_NAME, STATIC


def json_response(handler, payload, status=200):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def xlsx_response(handler, data, filename):
    created_at = datetime.now()
    filename = timestamped_filename(filename, created_at)
    fallback = timestamped_filename("fields.xlsx", created_at)
    handler.send_response(200)
    handler.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    handler.send_header("Content-Disposition", f"attachment; filename={fallback}; filename*=UTF-8''{quote(filename)}")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

class ApplicationServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, backend=None, private=False):
        self.backend = backend or DatabaseBackend(ConnectionConfig())
        self.source_lock = RLock()
        self.source_id = secrets.token_urlsafe(16)
        self.session_token = secrets.token_urlsafe(32) if private else ""
        super().__init__(address, Handler)
        self.cookie_name = f"model_session_{self.server_port}"
        self.source_picker = NativeSourcePicker()

    @property
    def browser_url(self):
        url = f"http://127.0.0.1:{self.server_port}/"
        return url + "?session=" + self.session_token if self.session_token else url

    def source_info(self):
        directory = self.backend.config.directory
        return {"directory": directory, "source_id": self.source_id,
                "source_kind": "file" if directory and Path(directory).is_file() else "directory"}

    def replace_source(self, directory):
        if not isinstance(directory, str) or not directory.strip():
            raise ValueError("请输入 SQLite 模型文件夹或单个 .db 文件的路径")
        candidate = DatabaseBackend(ConnectionConfig(str(Path(directory.strip()).expanduser().resolve())))
        try:
            models = list_models(candidate)
        except Exception:
            candidate.close()
            raise
        with self.source_lock:
            previous = self.backend
            self.backend = candidate
            self.source_id = secrets.token_urlsafe(16)
            previous.close()
            return {**self.source_info(), "models": models, "default_database": DB_NAME}

    def server_close(self):
        if hasattr(self, "source_picker"):
            self.source_picker.close()
        super().server_close()
        self.backend.close()


class Handler(BaseHTTPRequestHandler):
    def authorized(self, parsed):
        if not self.server.session_token:
            return True
        query = parse_qs(parsed.query)
        token = query.get("session", [""])[0]
        if self.command == "GET" and parsed.path == "/" and secrets.compare_digest(token, self.server.session_token):
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", f"{self.server.cookie_name}={token}; HttpOnly; SameSite=Strict; Path=/")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        entry = cookie.get(self.server.cookie_name)
        if entry is not None and secrets.compare_digest(entry.value, self.server.session_token):
            return True
        json_response(self, {"error": "请使用启动命令提供的页面地址打开评分页面"}, 401)
        return False

    def current_source(self):
        return self.headers.get("X-Data-Source", "") == self.server.source_id

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(body or "{}")

    def read_bytes(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if not self.authorized(parsed):
                return
            if parsed.path == "/api/data-source":
                with self.server.source_lock:
                    return json_response(self, self.server.source_info())
            if parsed.path == "/api/models":
                with self.server.source_lock:
                    models = list_models(self.server.backend) if self.server.backend.config.directory else []
                    return json_response(self, {**self.server.source_info(), "models": models, "default_database": DB_NAME})
            if parsed.path.startswith("/api/"):
                qs = parse_qs(parsed.query, keep_blank_values=True)
                with self.server.source_lock:
                    if not self.current_source():
                        return json_response(self, {"error": "数据源已切换，请刷新页面后操作"}, 409)
                    store = get_store(qs.get("database", [DB_NAME])[0], self.server.backend)
                    with store.lock:
                        return self.handle_GET(parsed, store)
            return self.handle_GET(parsed, None)
        except ValueError as exc:
            json_response(self, {"error": str(exc)}, 400)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def handle_GET(self, parsed, store):
        try:
            if parsed.path == "/api/grades":
                store.reload_grades()
                return json_response(self, {"grades": store.grades,
                                     "database_path": str(store.backend.sqlite_files()[store.database])})
            if parsed.path == "/api/model":
                store.reload()
                return json_response(self, {**store.model, "grades": store.grades})
            if parsed.path == "/api/companies":
                qs = parse_qs(parsed.query)
                limit = None if qs.get("all", [""])[0] == "1" else 80
                return json_response(self, store.search_companies(qs.get("q", [""])[0], limit=limit))
            if parsed.path == "/api/score":
                qs = parse_qs(parsed.query)
                company_id = qs.get("company_id", [""])[0]
                period = qs.get("period", [""])[0]
                company = next((c for c in store.companies if c["company_id"] == company_id), None)
                if not company:
                    return json_response(self, {"error": "company not found"}, 404)
                result = ScoreEngine(store, company_id, period or None).score()
                return json_response(self, {"company": company, **result})
            if parsed.path == "/api/field-matrix":
                qs = parse_qs(parsed.query)
                ids = [x for x in qs.get("company_ids", [""])[0].split(",") if x]
                period = qs.get("period", [""])[0]
                return json_response(self, store.field_matrix(ids, period))
            if parsed.path == "/api/reload":
                store.reload()
                return json_response(self, {"ok": True})
            if parsed.path == "/api/tables":
                return json_response(self, [
                    {"name": name, "label": label}
                    for name, label in TABLE_LABELS.items()
                ])
            if parsed.path == "/api/table":
                qs = parse_qs(parsed.query)
                table = qs.get("name", [""])[0]
                q = qs.get("q", [""])[0]
                limit = int(qs.get("limit", ["100"])[0])
                return json_response(self, table_data(store, table, q, limit))
            path = STATIC / ("index.html" if parsed.path in ("", "/") else parsed.path.lstrip("/"))
            if not path.resolve().is_relative_to(STATIC.resolve()) or not path.exists():
                self.send_error(404)
                return
            mime = "text/html; charset=utf-8" if path.suffix == ".html" else "text/css; charset=utf-8" if path.suffix == ".css" else "application/javascript; charset=utf-8"
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if not self.authorized(parsed):
                return
            if parsed.path == "/api/data-source/browse":
                payload = self.read_json()
                if not isinstance(payload, dict):
                    raise ValueError("选择参数必须是对象")
                return json_response(self, self.server.source_picker.choose(
                    payload.get("kind"), payload.get("initial_path", "")))
            if parsed.path == "/api/data-source/select":
                payload = self.read_json()
                directory = payload.get("directory") if isinstance(payload, dict) else None
                return json_response(self, self.server.replace_source(directory))
            qs = parse_qs(parsed.query, keep_blank_values=True)
            with self.server.source_lock:
                if not self.current_source():
                    return json_response(self, {"error": "数据源已切换，请刷新页面后操作"}, 409)
                store = get_store(qs.get("database", [DB_NAME])[0], self.server.backend)
                with store.lock:
                    return self.handle_POST(parsed, store)
        except ValueError as exc:
            json_response(self, {"error": str(exc)}, 400)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def handle_POST(self, parsed, store):
        try:
            if parsed.path == "/api/import-fields":
                return json_response(self, import_fields_xlsx(store, self.read_bytes()))
            if parsed.path == "/api/import-checks":
                qs = parse_qs(parsed.query)
                return json_response(self, import_checks_xlsx(store, self.read_bytes(), qs.get("period", [""])[0]))
            payload = self.read_json()
            if parsed.path == "/api/export-final":
                page_data = payload.get("page_data")
                data = export_final_xlsx(store, page_data, resolve_rules(store, payload.get("rules", {})))
                period = page_data.get("period", "")
                return xlsx_response(self, data, f"模型评级计算最终定级_{period or '当前期间'}.xlsx")
            if parsed.path == "/api/rules-preview":
                return json_response(self, scoring_preview(store, payload.get("company_ids", []) or [],
                                     payload.get("period", "") or "", payload.get("overrides", {}) or {}, payload.get("rules", {})))
            if parsed.path == "/api/export-checks":
                period = payload.get("period", "") or ""
                data = export_checks_xlsx(store, payload.get("company_ids", []) or [], period,
                                          payload.get("overrides", {}) or {}, payload.get("notes", {}) or {},
                                          page_data=payload.get("page_data"), rule_overrides=payload.get("rules", {}))
                return xlsx_response(self, data, f"批量排查_{period or '当前期间'}.xlsx")
            if parsed.path == "/api/export-fields":
                company_ids = payload.get("company_ids", []) or []
                period = payload.get("period", "") or ""
                data = export_fields_xlsx(store, company_ids, period, payload.get("overrides", {}) or {}, payload.get("rules", {}),
                                          indicator_values=payload.get("indicator_values"))
                filename = f"模型数据录入_{period or '当前期间'}.xlsx"
                return xlsx_response(self, data, filename)
            if parsed.path == "/api/score-preview":
                company_id = payload.get("company_id", "")
                period = payload.get("period", "") or ""
                overrides = payload.get("overrides", {}) or {}
                company = next((c for c in store.companies if c["company_id"] == company_id), None)
                if not company:
                    return json_response(self, {"error": "company not found"}, 404)
                result = ScoreEngine(store, company_id, period or None, overrides, rule_overrides=payload.get("rules", {})).score()
                return json_response(self, {"company": company, **result})
            if parsed.path == "/api/value":
                company_id = payload.get("company_id", "")
                field_id = payload.get("field_id", "")
                value = payload.get("value", "")
                period = payload.get("period", "") or ""
                if not company_id or not field_id:
                    return json_response(self, {"error": "company_id and field_id are required"}, 400)
                store.upsert_field_value(company_id, field_id, value, period)
                result = ScoreEngine(store, company_id, period or None).score()
                company = next((c for c in store.companies if c["company_id"] == company_id), None)
                return json_response(self, {"ok": True, "company": company, **result})
            if parsed.path == "/api/indicator":
                indicator_id = payload.get("indicator_id", "")
                if not indicator_id:
                    return json_response(self, {"error": "indicator_id is required"}, 400)
                store.update_indicator(
                    indicator_id,
                    weight=payload.get("weight") if "weight" in payload else None,
                    expression=payload.get("expression") if "expression" in payload else None,
                )
                company_id = payload.get("company_id", "")
                if company_id:
                    result = ScoreEngine(store, company_id).score()
                    company = next((c for c in store.companies if c["company_id"] == company_id), None)
                    return json_response(self, {"ok": True, "company": company, **result})
                return json_response(self, {"ok": True})
            if parsed.path == "/api/table/insert":
                table_insert(store, payload.get("table", ""), payload.get("row", {}))
                return json_response(self, {"ok": True})
            if parsed.path == "/api/table/update":
                table_update(store, payload.get("table", ""), payload.get("original", {}), payload.get("row", {}))
                return json_response(self, {"ok": True})
            if parsed.path == "/api/table/delete":
                table_delete(store, payload.get("table", ""), payload.get("original", {}))
                return json_response(self, {"ok": True})
            return json_response(self, {"error": "not found"}, 404)
        except ValueError as exc:
            json_response(self, {"error": str(exc)}, 400)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def log_message(self, fmt, *args):
        return
