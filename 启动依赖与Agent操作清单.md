# 模型评级系统：启动依赖与 Agent 操作清单

把本文件连同项目源码交给接收方的 agent。请 agent 在接收方电脑检查环境、安装缺少的依赖并启动应用；依赖在目标电脑准备，不随源码分发。

## 必要环境

| 项目 | 要求 | 准备方式 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11，或满足依赖的 Linux；推荐 x86_64 | Windows 使用 start.bat / start.ps1，Linux 使用 sh start.sh；发行版实测范围以随附验证记录为准 |
| Python | CPython 3.10 或更高的 Python 3 稳定版 | Windows 脚本优先复用已有解释器，没有时自动下载完整 Python 3.14.10；Linux 使用发行版软件源或官方 Python，包含 pip、venv、sqlite3 |
| pip、venv | 与所选 Python 配套 | 通常由完整 Python 安装程序提供，不使用 embeddable 精简包作为日常启动环境 |
| 浏览器 | Edge、Chrome、Firefox 等现代浏览器 | 已有浏览器可复用，无需专门安装开发工具 |
| 启动命令环境 | Windows PowerShell 5.1+，或 Linux 的 POSIX sh | Windows 通常自带 PowerShell；Linux 无需为本应用安装 PowerShell |
| Python 库 | SQLAlchemy==2.0.57、openpyxl==3.1.5 | 在本项目虚拟环境内执行 pip install -r requirements.txt |
| 模型文件 | 打开应用时无需提供；实际评分前需选择本应用格式的 SQLite .db 文件 | 默认进入页面后手动选择客户自己的文件夹或单个 .db；也可通过启动参数显式预选，不依赖 models/ |

SQLAlchemy 选用兼容 Python 3.10 的 2.0 系列。不要自行升级为要求更高 Python 版本的 2.1 系列。pip 会自动安装这些库需要的间接依赖，无需逐个手工下载。

本应用的页面是随源码提供的 HTML、CSS、JavaScript，由 Python 服务直接提供。运行无需安装 Node.js、npm、pnpm、Java、SQLite 服务端、MySQL、Qt 或 Codex。SQLite 由 Python 标准库提供；Excel 导入导出由 openpyxl 完成，运行不依赖 Microsoft Office。系统文件选择窗口使用 Windows 自带组件，仅在 Windows 可用；Linux 直接输入模型路径或使用 --models 参数。

依赖首次下载需要网络及安装源访问权限；准备完成后，日常本机评级、模型读取和 Excel 导入导出可以离线运行。项目目录及所选模型文件应有相应读写权限。

## Windows 自动准备环境

Windows 10 / 11 可以直接解压源码并双击 `start.bat`。脚本依次检查项目 `.venv`、PATH 中的真实解释器及标准 Python 安装注册信息，要求 Python >= 3.10 且包含 sqlite3、venv、ensurepip。Windows Store 应用别名不算已安装的解释器。

找不到可用 Python 时，脚本使用 `python-bootstrap.ps1` 从 `https://www.python.org/` 下载完整 Python 3.14.10 运行时，按脚本内固定 SHA256 校验后解压到 `%LOCALAPPDATA%\ModelRatingSystem\python\3.14.10-<架构>\`，再创建项目内 `.venv`、安装依赖并启动。无需安装 Node、NuGet 或 Python 安装管理器，无需管理员权限，不修改系统 PATH。运行时下载约 32 MB，依赖另外下载；源码压缩包不包含这些内容。

官方运行时格式和手动解压方式见 [Python 官方离线安装说明](https://docs.python.org/3.14/using/windows.html#offline-installs)，下载地址及校验值来自 [Python 官方 Windows 下载清单](https://www.python.org/ftp/python/index-windows.json)。脚本使用完整运行时，不使用缺少常规 pip / venv 支持的 embeddable 包。

首次下载需能访问 `www.python.org`，依赖安装还需访问配置的 Python 包源（默认 PyPI 及其文件下载域名）。断网、代理限制或校验失败时会报错，不继续使用失败的下载；处理网络后再次运行即可。下载临时文件在成功或失败后清理，已准备好的运行时会复用。

自动准备流程已在 Windows x64 上验证。x86、ARM64 按操作系统架构匹配官方包，尚未实机验证；不据此承诺这些架构的完整应用兼容性。Linux 仍按下方专节准备系统 Python，`start.bat` 不用于 Linux。

只检查并准备环境、不启动页面：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -CheckOnly
```

如需由 agent 手动准备 Python、禁止脚本自动下载，可加 `-NoAutoPython`；如已知道解释器路径，可使用 `-Python`。这两个参数都不会阻止按 requirements.txt 安装缺少的 Python 库。浏览器缺失时仍需自行准备浏览器。

## 可直接交给 Agent 的执行要求

请在当前源码目录完成以下操作：

1. 确认当前操作系统和处理器架构。检查源码目录含 app.py、start.ps1、python-bootstrap.ps1、start.sh、requirements.txt、rating/、static/。models/ 是可选示例，不要求存在。不要从开发者电脑复制 Python、.venv、node_modules 或测试工具。Windows 按下面的 PowerShell 步骤执行；Linux 按后面的 Linux 专节执行。
2. Windows 优先执行上面的 `-CheckOnly`，由启动脚本检查并自动补齐 Python 和项目依赖。若自动下载受企业网络或系统策略限制，再探测已有 Python 的实际版本及路径，例如 py -3 --version、python --version；必要时从 Python 官方准备完整发行版并用 -Python 指定。不要降级或覆盖用户已有的其他 Python。Linux 使用后面的发行版安装步骤。
3. 验证所选解释器能够 import sqlite3、venv、ensurepip，并记录解释器绝对路径。如果浏览器缺失，安装用户认可的现代浏览器。
4. 如采用手动指定解释器，使用下面的 -CheckOnly 命令在项目内创建 .venv、按 requirements.txt 安装并校验依赖。-Python 替换为第 2 步确认的真实绝对路径。自动准备成功后无需重复手动安装。不要把 Python 库安装到系统全局环境。
5. 如果接收的目录已有 .venv，先检查是否来自当前电脑且能运行。来源不明、路径失效、版本过低或需要切换解释器时，先将 .venv 改名保留，再重新创建。-Python 只在首次创建 .venv 时生效。
6. 环境检查通过后，执行启动命令，保持服务进程运行，向用户提供终端打印的完整“页面地址”。地址可能包含会话参数，不能省略这些参数。
7. 用该地址访问页面，确认能加载首页和静态资源，默认显示“未选择数据源”并提示用户选择路径。没有 models/ 或尚未选择数据库应能正常打开页面。客户提供有效数据库后，再通过“数据源选择”确认模型列表和读取功能；仅启动验收不修改客户数据库，不用已有业务数据做破坏性验证。

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

## Linux 安装与启动

以下命令在项目目录执行，适用于 POSIX sh，不要求 Bash。先通过 `uname -m` 和 `/etc/os-release` 确认处理器架构与发行版，再确认实际 Python 版本为 3.10 或以上。不要把 Windows 的 .venv 复制到 Linux，也不要覆盖用户已有的其他 Python。

Debian/Ubuntu 如缺少必要组件，可通过发行版软件源安装（需要相应安装权限）：

```sh
sudo apt-get update
sudo apt-get install python3 python3-venv python3-pip
python3 --version
python3 -c 'import sqlite3, venv, ensurepip'
```

如果发行版默认 Python 低于 3.10，安装受该发行版支持的较新 Python 及其匹配的 venv 包。其他发行版由 agent 使用对应软件包管理器准备相同组件，不照搬 apt 命令。

首次安装并校验项目依赖：

```sh
sh start.sh --check-only
```

指定解释器仅在创建 .venv 时生效：

```sh
PYTHON=/usr/bin/python3.12 sh start.sh --check-only
```

启动后复制终端输出的完整页面地址到浏览器：

```sh
sh start.sh --no-browser --port 0
```

也可运行 `sh start.sh` 尝试打开系统默认浏览器。指定模型文件或文件夹：

```sh
sh start.sh --models '/home/用户名/模型数据/模型A.db' --no-browser --port 0
```

脚本会创建 .venv/bin/python、安装并验证 requirements.txt，后续复用环境。无需 chmod 就可通过 `sh start.sh` 执行。若文件被编辑器转成 CRLF 换行，应恢复为 LF 换行。启动失败会返回非零退出码，低于 Python 3.10 的解释器会被拒绝。

Linux 文件/文件夹“浏览”弹窗暂不可用，请手动输入本机模型路径；Excel 上传、下载仍通过浏览器完成。无桌面的远程 Linux 仅启动本机服务，不会出现浏览器窗口；如需从另一台电脑访问，应由接收方 agent 配置 SSH 端口转发，服务仍保持只监听 127.0.0.1。

macOS 尚未实测；Linux 的某个发行版通过测试，不代表其他发行版、ARM64 或国产处理器平台均已验证。

本次已验证 Alpine 3.20.10 / Python 3.12.13、Ubuntu 22.04.5 用户空间 / Python 3.10.12；两套环境各通过 79 项测试及启动、模型评分、Excel 接口往返检查。Ubuntu 测试使用 Linux 虚拟机内的 chroot 用户空间。详细范围见 [Linux兼容性验证记录.md](Linux兼容性验证记录.md)。

## 常见问题

- 自动准备 Python 失败：检查 python.org 的网络访问及当前用户缓存目录权限后重试；也可安装完整 Python 并通过 -Python 指定真实路径。Windows 应用执行别名不等于已安装 Python。
- 提示旧环境不可用：保留并改名旧 .venv，再用目标电脑的 Python 重建。
- 安装依赖失败：检查网络、代理或配置好的安装源，不随意改动 requirements.txt 的版本。离线场景可由 agent 在匹配目标操作系统、Python 版本和架构的联网环境准备 wheel 安装源。
- 已安装库却仍重新安装：脚本会核对项目依赖清单、实际导入结果及固定版本，修复缺失或不匹配的依赖。
- 页面打不开：使用终端输出的完整地址；服务必须仍在运行。端口冲突时改用 -Port 0。
- 使用结束：在服务所在终端按 Ctrl+C。关闭浏览器标签页不会停止服务。

## 源码交付范围

交付源码仅需：根目录运行用 Python 文件、start.bat、start.ps1、python-bootstrap.ps1、start.sh、requirements.txt、rating/、static/，以及本清单和使用说明。默认不带 models/ 或任何示例数据库，客户启动后手动选择自己的数据源。若需要附带示例，开发者可在生成交付目录时增加 --include-models。

不应交付：.venv、Python 或 Node 运行时、node_modules、backups、downloads、tests、__pycache__、*.pyc、开发测试截图和历史构建产物。开发目录的 tools/prepare_delivery.py 可以生成只含必要内容的交付目录；交付目录内不含该开发工具。

依赖参考：[SQLAlchemy 2.0](https://docs.sqlalchemy.org/en/20/intro.html)、[SQLAlchemy 2.0.57](https://pypi.org/project/SQLAlchemy/2.0.57/)、[openpyxl 3.1.5](https://pypi.org/project/openpyxl/3.1.5/)。
