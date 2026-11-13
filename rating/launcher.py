"""Start the local HTTP service and open its page in a browser."""

import argparse
import os
import sys
import webbrowser
from pathlib import Path

from database import ConnectionConfig, DatabaseBackend


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def port_number(value):
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("端口必须是 0 到 65535 之间的整数") from None
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("端口必须是 0 到 65535 之间的整数")
    return port


def argument_parser():
    parser = argparse.ArgumentParser(description="从源码启动模型评级页面")
    parser.add_argument(
        "--models", metavar="PATH",
        default=os.environ.get("MODEL_DIRECTORY", ""),
        help="预选 SQLite 模型文件夹或单个 .db 文件（默认：MODEL_DIRECTORY；未设置时在页面选择）",
    )
    parser.add_argument(
        "--port", type=port_number, default=os.environ.get("PORT") or "8765",
        help="本机服务端口，0 表示自动分配（默认：PORT 或 8765）",
    )
    parser.add_argument("--no-browser", action="store_true", help="只启动服务，不自动打开浏览器")
    return parser


def main(argv=None):
    from .server import ApplicationServer

    options = argument_parser().parse_args(argv)
    config = ConnectionConfig(str(Path(options.models).expanduser().resolve()) if options.models else "")
    backend = None
    try:
        if config.directory:
            config.validate()
        backend = DatabaseBackend(config)
        server = ApplicationServer(("127.0.0.1", options.port), backend=backend, private=True)
    except (OSError, ValueError) as error:
        if backend is not None:
            backend.close()
        print(f"启动失败：{error}", file=sys.stderr)
        if isinstance(error, OSError):
            print("请检查端口是否已占用，或使用 --port 0 自动选择可用端口。", file=sys.stderr)
        return 1

    try:
        print(f"模型数据源：{config.directory or '未选择，请在页面点击“数据源选择”'}", flush=True)
        print(f"页面地址：{server.browser_url}", flush=True)
        print("在此终端按 Ctrl+C 停止服务；关闭浏览器标签页后服务仍继续运行。", flush=True)
        if not options.no_browser:
            try:
                if not webbrowser.open(server.browser_url, new=2):
                    print("浏览器未自动打开，请复制上面的页面地址访问。", flush=True)
            except webbrowser.Error:
                print("浏览器未自动打开，请复制上面的页面地址访问。", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。", flush=True)
    finally:
        server.server_close()
    return 0
