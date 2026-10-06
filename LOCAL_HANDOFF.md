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

`make dev` 会生成角色 profile、启动 Hindsight 和 laya 两个记忆服务，然后启动网页实例。不需要另外运行全局 dsh。
