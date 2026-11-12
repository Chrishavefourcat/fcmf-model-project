# 模型评级系统：启动依赖与 Agent 操作清单

把本文件连同项目源码交给接收方的 agent。请 agent 在接收方电脑检查环境、安装缺少的依赖并启动应用；依赖在目标电脑准备，不随源码分发。

## 必要环境

| 项目 | 要求 | 准备方式 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11；推荐 64 位 | 本清单和双击启动脚本面向 Windows |
| Python | CPython 3.10 或更高的 Python 3 稳定版；推荐 64 位 Python 3.12 | 从 https://www.python.org/downloads/windows/ 安装完整发行版，包含 pip、venv；已有合格版本可复用 |
| pip、venv | 与所选 Python 配套 | 通常由完整 Python 安装程序提供，不使用 embeddable 精简包作为日常启动环境 |
| 浏览器 | Edge、Chrome、Firefox 等现代浏览器 | 已有浏览器可复用，无需专门安装开发工具 |
| Windows PowerShell | 5.1 或更高，能调用 powershell.exe | Windows 通常已自带；用于启动脚本和本机文件选择窗口 |
| Python 库 | SQLAlchemy==2.0.57、openpyxl==3.1.5 | 在本项目虚拟环境内执行 pip install -r requirements.txt |
| 模型文件 | 至少一个本应用格式的 SQLite .db 文件 | 默认使用随附 models/，也可通过启动参数或页面选择已有模型文件 |

SQLAlchemy 选用兼容 Python 3.10 的 2.0 系列。不要自行升级为要求更高 Python 版本的 2.1 系列。pip 会自动安装这些库需要的间接依赖，无需逐个手工下载。

本应用的页面是随源码提供的 HTML、CSS、JavaScript，由 Python 服务直接提供。运行无需安装 Node.js、npm、pnpm、Java、SQLite 服务端、MySQL、Qt 或 Codex。SQLite 由 Python 标准库提供；Excel 导入导出由 openpyxl 完成，运行不依赖 Microsoft Office。系统文件选择窗口使用 Windows 自带组件。

依赖首次下载需要网络及安装源访问权限；准备完成后，日常本机评级、模型读取和 Excel 导入导出可以离线运行。项目目录及所选模型文件应有相应读写权限。

## 可直接交给 Agent 的执行要求

请在当前源码目录完成以下操作：

1. 检查源码目录含 app.py、start.ps1、requirements.txt、rating/、static/、models/。不要从开发者电脑复制 Python、.venv、node_modules 或测试工具。
2. 探测已有 Python 的实际版本及路径，例如 py -3 --version、python --version。要求实际执行结果为 Python >= 3.10，不能仅根据文件夹名称判断。如果不存在合格版本，从 Python 官方下载适合本机的完整发行版并安装；推荐 Python 3.12。不要降级或覆盖用户已有的其他 Python。
3. 验证所选解释器能够 import sqlite3、venv、ensurepip，并记录解释器绝对路径。如果浏览器缺失，安装用户认可的现代浏览器。
4. 使用下面的 -CheckOnly 命令在项目内创建 .venv、按 requirements.txt 安装并校验依赖。-Python 替换为第 2 步确认的真实绝对路径。不要把 Python 库安装到系统全局环境。
5. 如果接收的目录已有 .venv，先检查是否来自当前电脑且能运行。来源不明、路径失效、版本过低或需要切换解释器时，先将 .venv 改名保留，再重新创建。-Python 只在首次创建 .venv 时生效。
6. 环境检查通过后，执行启动命令，保持服务进程运行，向用户提供终端打印的完整“页面地址”。地址可能包含会话参数，不能省略这些参数。
7. 用该地址访问页面，确认能加载首页、静态资源和模型列表。仅启动验收不修改模型数据库；不要用已有业务数据做破坏性验证。

安装和检查环境（示例路径必须替换为真实路径）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Python "C:\实际Python目录\python.exe" -CheckOnly
```

普通启动：双击 start.bat。由 agent 在终端启动时，建议直接使用 PowerShell 脚本，以便捕获日志和退出码：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -NoBrowser
```

默认端口为 8765，仅监听 127.0.0.1。若端口被占用，使用 -Port 0 自动分配端口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -NoBrowser -Port 0
```

指定自己的模型文件或文件夹：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Models "C:\模型数据\模型A.db" -NoBrowser
```

模型文件夹中当前层级的 .db 文件会出现在模型列表中。数据库需包含 model、company、field、field_value、indicator、grade 六张表；这是应用数据结构要求，不需要额外下载数据库服务。

## 手动准备方式

不使用启动脚本时，在源码目录执行。python 应替换为已确认的 Python >= 3.10 解释器：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py --no-browser
```

## 常见问题

- 提示找不到 Python：安装完整 Python 并通过 -Python 指定其真实路径；Windows 应用执行别名不等于已安装 Python。
- 提示旧环境不可用：保留并改名旧 .venv，再用目标电脑的 Python 重建。
- 安装依赖失败：检查网络、代理或配置好的安装源，不随意改动 requirements.txt 的版本。离线场景可由 agent 在匹配目标操作系统、Python 版本和架构的联网环境准备 wheel 安装源。
- 已安装库却仍重新安装：脚本会核对项目依赖清单、实际导入结果及固定版本，修复缺失或不匹配的依赖。
- 页面打不开：使用终端输出的完整地址；服务必须仍在运行。端口冲突时改用 -Port 0。
- 使用结束：在服务所在终端按 Ctrl+C。关闭浏览器标签页不会停止服务。

## 源码交付范围

交付源码仅需：根目录运行用 Python 文件、start.bat、start.ps1、requirements.txt、rating/、static/、所需的 models/*.db，以及本清单和使用说明。

不应交付：.venv、Python 或 Node 运行时、node_modules、backups、downloads、tests、__pycache__、*.pyc、开发测试截图和历史构建产物。开发目录的 tools/prepare_delivery.py 可以生成只含必要内容的交付目录；交付目录内不含该开发工具。

依赖参考：[SQLAlchemy 2.0](https://docs.sqlalchemy.org/en/20/intro.html)、[SQLAlchemy 2.0.57](https://pypi.org/project/SQLAlchemy/2.0.57/)、[openpyxl 3.1.5](https://pypi.org/project/openpyxl/3.1.5/)。
