# Linux 兼容性验证记录

验证日期：2026-11-12（Asia/Shanghai）。

## 结论与环境

本应用已在真实 Linux 内核上的 x86_64 环境完成安装、启动和核心功能验证。

| 测试环境 | Python | 自动化测试 | 实际启动与接口 |
| --- | --- | --- | --- |
| Alpine Linux 3.20.10，musl | 3.12.13 | 79 项通过，0 失败、0 错误 | 通过 |
| Ubuntu 22.04.5 LTS 用户空间，glibc | 3.10.12 | 79 项通过，0 失败、0 错误 | 通过 |

两套环境均使用 SQLAlchemy 2.0.57、openpyxl 3.1.5，由 pip 在 Linux 内新建的虚拟环境中安装。

测试通过免安装 QEMU 10.2.0 的软件模拟方式进行，运行的是真实 Linux 内核 6.6.134-0-virt。Alpine 为完整启动的临时 Linux 系统；Ubuntu 用户空间通过 chroot 在第二个 Linux 虚拟机内验证，使用该虚拟机的 Linux 内核，未启动完整 Ubuntu 桌面或其默认内核。测试在带中文和空格的项目路径中运行。

## 已验证内容

- `sh start.sh --check-only` 从空环境创建 `.venv` 并安装固定依赖。
- 再次检查环境可复用依赖，不重新调用 pip 安装。
- `sh start.sh --no-browser --port 0` 启动服务并输出完整会话地址。
- 首页和全部 6 个 CSS/JavaScript 页面资源可通过 HTTP 加载。
- 默认模型列表、模型数据读取、主体查询和实际模型评分可用。
- 手动输入 Linux 模型文件路径后，可切换数据源并继续读取、评分。
- 对实际模型中的一个主体，数据录入表、批量排查表均能导出为有效 Excel，再经 HTTP 导入解析。
- 原有 79 项 Python 测试在两套 Linux 用户空间中均通过，覆盖模型选择、数据录入、评分规则、等级规则、数值精度、Excel 导入导出、启动生命周期和接口会话等。
- 无桌面环境下可使用 `--no-browser`，通过终端提供的地址访问；测试服务在验证结束后停止。

验证仅操作传入虚拟机的模型副本。测试工具、Linux 镜像、运行时及安装好的依赖不属于源码交付内容。

## 使用方式

目标电脑先准备 Python 3.10+、pip、venv、sqlite3 和浏览器。具体安装步骤见 [启动依赖与Agent操作清单.md](启动依赖与Agent操作清单.md)。

在解压后的项目目录执行：

```sh
sh start.sh --check-only
sh start.sh
```

无桌面环境或希望手动打开浏览器时：

```sh
sh start.sh --no-browser --port 0
```

指定模型文件：

```sh
sh start.sh --models '/home/用户名/模型数据/模型A.db' --no-browser --port 0
```

## 验证范围与限制

- 当前原生“浏览文件夹 / DB 文件”弹窗仅适用于 Windows。Linux 会提示手动输入路径；本次已验证该替代流程。Excel 文件上传、下载继续通过浏览器完成。
- 本次验证的是 x86_64。未直接验证 ARM64、龙芯、飞腾、统信、麒麟等其他架构或发行版组合；需要根据实际目标环境补测。
- 未做 Linux 桌面浏览器的人工视觉检查、系统字体或打印一致性验收。HTTP 页面资源加载与后端功能通过，不代表每种浏览器版本均已实测。
- 未测试 macOS。
- QEMU 软件模拟的运行时间不适合用于推断目标电脑的性能。
- 服务保持只监听 127.0.0.1。远程无桌面 Linux 如需从另一台电脑访问，应另外准备 SSH 端口转发。

测试环境来源：[QEMU 官方下载说明](https://www.qemu.org/download/)、[Alpine 官方镜像目录](https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/)、[Ubuntu 官方最小镜像目录](https://cloud-images.ubuntu.com/minimal/releases/jammy/release/)。测试下载已分别核对提供方发布的 SHA-512 / SHA-256 校验值。
