# 本机启动卡

只用于本机开发。对外演示按仓库 [README](./README.md) 用全新的 home / bank。

在项目目录打开终端，执行：

```bash
DSH_HOME="$HOME/.local/share/lepimemory/playground" \
LEPI_BANK=lepimemory-playground \
PORT=3181 \
make dev
```

三个参数的含义：

- **DSH_HOME**：这份实例的会话、状态和便条存放位置。选了持久目录，不放 `/tmp`。
- **LEPI_BANK**：这份实例的长期记忆库，和测试库分开。
- **PORT=3181**：网页端口，避开已有实例使用的 3080。

`make dev` 会生成角色 profile、并行启动记忆服务和网页实例。不需要另外运行全局 dsh。

首次构建会下载固定版本模型。通常不要设置 `HF_ENDPOINT`：启动器检测到 HTTP(S) 代理时使用 `https://huggingface.co`，没有 HTTP(S) 代理时使用镜像站。显式设置会覆盖自动选择；不要把镜像站和 HTTP 代理混用。SOCKS-only 的 `ALL_PROXY` 不属于这条构建代理链。

`core ready` 只表示网页核心已就绪，不表示记忆服务已经启动成功。启动日志中两张镜像应构建成功，随后可查看 `http://127.0.0.1:8888/health` 和 `http://127.0.0.1:8000/health`；前者应为 `healthy`、数据库已连接，后者应为 `ok`、多语言模型已加载。
