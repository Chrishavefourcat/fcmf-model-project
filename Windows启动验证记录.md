# Windows 自动准备 Python 验证记录

验证日期：2026-11-13（Asia/Shanghai）。

本次在 Windows 10 x64（10.0.19045）、系统 Windows PowerShell 5.1 上，验证 `start.bat` 在没有可发现 Python 时自动准备运行环境的流程。测试采用临时源码副本、独立的当前用户缓存路径及不含 Python 的 PATH；这是已有 Windows 主机上的隔离测试，未重装操作系统。项目路径包含中文和空格。

## 已通过的检查

- 找不到可用 Python 时，从 python.org 下载完整 Python 3.14.10 x64 运行时，固定 SHA256 校验通过后才解压、执行。
- 使用短临时目录解压，兼容 Windows PowerShell 5.1 的路径限制；运行时放入当前用户缓存，未安装系统 Python、改动 PATH 或申请管理员权限。
- 首次 `start.ps1 -CheckOnly` 创建 `.venv`，安装 SQLAlchemy 2.0.57、openpyxl 3.1.5 及间接依赖，完成导入和版本校验。
- 再次检查时，禁用 Python 包源并将网络代理设为不可用地址，仍能复用已安装环境，不重新下载或安装。
- 实际执行 `start.bat -NoBrowser -Port 0`，批处理调用 PowerShell、虚拟环境及 Python 服务的完整进程链可用；首页、全部 6 个 CSS/JS 资源、模型列表、模型详情、主体查询及真实模型评分接口均可访问。
- HTTP 检查前后模型数据库 SHA256 一致，测试没有修改模型数据；测试服务已停止。
- Python 3.14.10 下原有 79 项测试全部通过，覆盖评分、模型选择、Excel、接口和启动生命周期等。
- 额外 12 项启动检查通过：可用/缺失解释器识别、PATH 发现、禁止下载、校验失败拦截、网络中断重试提示、缓存复用、损坏缓存保留及失败后的临时目录清理。网络中断和损坏下载使用测试替身验证。

## 适用范围

自动下载发生在 Windows 没有可用 Python 3.10+ 时；已有完整合格版本会复用。首次准备需要联网访问 python.org 和所配置的 Python 包源；准备完成后本机日常使用可离线运行。浏览器需由系统或用户提供。

自动下载的 x86 / ARM64 地址和校验值也来自官方清单，但尚未在对应硬件实测。本次未验证 Windows 11 实机、其他 Windows 版本或企业策略限制下的行为，也未进行浏览器人工视觉验收。Linux 启动脚本未增加自动安装系统 Python 的行为，其已有验证范围见 [Linux兼容性验证记录.md](Linux兼容性验证记录.md)。

Python 自动下载固定为经过本次验证的 3.14.10；更新此版本时应同时核对官方 URL、SHA256 并重新验证依赖及启动。

开发环境复查入口：`tools/test_windows_bootstrap.ps1`；该脚本不属于交付运行文件。操作步骤和手动准备方式见 [启动依赖与Agent操作清单.md](启动依赖与Agent操作清单.md)。

来源：[Python 官方完整运行时下载清单](https://www.python.org/ftp/python/index-windows.json)、[Python 官方离线解压说明](https://docs.python.org/3.14/using/windows.html#offline-installs)。
