 本机直接这样启动

 在项目目录打开终端，执行：

 ```bash
DSH_HOME="$HOME/.local/share/lepimemory/playground" \
LEPI_BANK=lepimemory-playground \
PORT=3181 \
make dev
 ```

 这三个参数分别是：

- DSH_HOME：保存你这份实例的会话、状态和便条。我这里给你选了持久目录，不放 /tmp。
- LEPI_BANK：这份实例使用的长期记忆库，和之前的测试库分开。
- PORT=3181：网页端口，避开之前已有实例使用的 3080。

 make dev 会生成角色 profile、尝试启动 Hindsight 和 laya，并启动网页实例。不用另外运行全局 dsh。
