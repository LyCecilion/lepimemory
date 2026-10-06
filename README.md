<!-- Lepimemory — 极创工作室第二次面试题 -->

# 蝶忆 Lepimemory

> 一个会**记住过去、保持稳定人格、采取真实行动**的角色 Agent，而且它的每一步变化都可以查证。
> 极创工作室第二次面试题（形式：PPT + 公开仓库），题目原文见 [CHALLENGE.md](CHALLENGE.md)。

蝶忆不是"给聊天模型塞一段人设"。它在模型外面维护着三样东西：

- **状态**：心境与关系是存进数据库的数值，随真实事件更新，再翻译成语气提示进入模型输入；
- **记忆**：说过的话要经过理解、判定、授权、来源核对，才会进入长期记忆；下次回答前再筛一遍，看哪些现在允许用；
- **行动**：答应写便条，就真的生成文件；文件不存在就不算成功。

页面右侧的**状态面板**是这套系统的仪表盘：当前状态、处理进度、这轮用了哪些来源、哪些事情确实完成了，都能看到。想向别人讲解它怎么工作，从 [docs/MECHANISM.md](docs/MECHANISM.md) 开始。

**当前进度**：Lv1/Lv2 的完整闭环和 Lv3 的状态立绘已经实现，正在准备演示。自动化检查（行为测试 + SQLite 冒烟 + 类型/风格检查）全部通过，数字以 `make verify` / `make check` 的实际输出为准。已知边界与未实现项见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 7 节。

## 快速开始

前置：Docker（含 Compose v2）、make、Bash、curl、tar、OpenSSL、shasum。
入口**不使用**系统 Node 或全局 dsh/pnpm：`make bootstrap` 校验并安装固定的 Node **24.20.0** / pnpm **10.28.2**，dsh 锁定 **0.1.7-rc.2**。

```bash
make bootstrap
# 没有 .env 时才复制样例；不要覆盖已有凭据。
cp .env.example .env
# 成组填写 LEPI_LLM_BASE_URL / LEPI_LLM_API_KEY，见下节。
make install-profile DSH_HOME=/tmp/lepimemory-new-home

# 用全新的 home / bank 启动
DSH_HOME=/tmp/lepimemory-demo PORT=3181 LEPI_BANK=lepimemory-demo-20261005 make dev
```

启动前要知道的事：

- **安装是冻结安装**：只执行 `pnpm install --frozen-lockfile`，不重新解析依赖；不使用全局 dsh/pnpm/npx，也不手工 `dsh plugin add`。
- **验证用全新数据**：演示和验证一律用新的 home / bank。不要用 `make reset` 制造"干净结果"，旧 bank 与用户数据一律保留。
- **profile 由 launcher 生成**：`install-profile` 把 `dsh/profiles/lepimemory` 复制进 `$DSH_HOME`，生成连接配置并物化插件 link。遇到不是这个 launcher 生成的同名目录会报 `LEPI_PROFILE_CONFLICT`——换一个新 home，不要删原目录。
- **走原生认证**：打开 launcher 打印的认证链接（303 后清除 token），不要绕过认证直接读状态。
- **没配云连接 = 只读**：`LEPI_LLM_BASE_URL` 和 `LEPI_LLM_API_KEY` 都为空时系统进入 `unconfigured` 状态，界面可看、不能对话，控制与记忆请求都被拒绝。系统绝不回落到任何默认官方端点。
- **首次启动较慢，需要网络**：`make dev` 第一次会构建两个固定的记忆服务镜像（Hindsight、laya），只在首次构建时拉模型（默认走 `hf-mirror.com`）。两个服务不可达不影响核心界面与任务状态。
- 旧 `.env` 首次加载会一次性迁移：先备份权限 0600 的 `.env.legacy-*`，两个文件都不提交。

统一入口（`make bootstrap` / `install-profile` / `dev` / `verify` / `check`）都由仓库固定的 Node 驱动。`make dev` 在启动前校验锁定的 CLI/插件版本与 `/lepimemory/health` 的 `core=true`，核心不兼容或 SQLite 失败就直接终止。

## 配置

所有运行配置走 `LEPI_*` 环境变量，样例见 [.env.example](.env.example)。凭据字段一律留空，真值只放本机 `.env`（已 gitignore）。

- **共享连接** `LEPI_LLM_BASE_URL` + `LEPI_LLM_API_KEY`：成对填写，要么都填、要么都空。只填一项启动时报 `LEPI_CONNECTION_INCOMPLETE`，key 不会发往任何端点。
- **每路由 override**（`LEPI_ROLE_*` / `LEPI_PROCESS_*` / `LEPI_CONTROL_FALLBACK_*` / `LEPI_HINDSIGHT_*`）：不设置就整组继承共享连接；要覆盖就必须 URL/key 成组填，不做部分继承。
- **`LEPI_BANK`**：长期记忆库的名字，默认 `lepimemory-v2`（拒绝旧名 `lepimemory`）；演示用新的 `lepimemory-demo-*`。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `Makefile` · `scripts/bootstrap-runtime.sh` · `scripts/src/runtime.ts`（生成 `scripts/dist/runtime.js`） | 固定运行时入口：`bootstrap` / `build` / `install-profile` / `dev` / `verify` / `check` |
| `package.json` · `pnpm-lock.yaml` · `pnpm-workspace.yaml` | 根工作区：锁定 Node/pnpm/dsh 版本与依赖（frozen install） |
| `dsh/profiles/lepimemory/` | profile 源：人设 + 能力面裁剪 + 隔离 realm；由 launcher 复制生成到 `$DSH_HOME` |
| `dsh/plugins/dsh-lepimemory-state/src/` | 自研角色运行时插件的手写源码（服务端 `src/*.ts`、共享 `src/shared/*.ts`、客户端 `src/client/**`）；`lib/`、`client.js` 是生成物 |
| `deploy/hindsight/` · `deploy/laya/` | 两个记忆服务的镜像定义（按 digest / revision 固定，不拉浮动模型） |
| `docker-compose.yml` | 记忆服务编排（仅 loopback 端口；复用既有数据/缓存卷） |
| `docs/` | 机制导览、架构说明、开发日志 |
| `.env.example` | 环境变量样例（凭据留空） |

## 文档地图

- [docs/MECHANISM.md](docs/MECHANISM.md) — 机制与页面导览：向别人讲解时从这里开始
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构说明：模块职责、数据流、设计取舍、边界
- [docs/DEVLOG.md](docs/DEVLOG.md) — 开发日志：里程碑与踩坑台账
- [dsh/README.md](dsh/README.md) — 开发者指南：构建、验证、源码结构、事务边界
- [LOCAL_HANDOFF.md](LOCAL_HANDOFF.md) — 本机开发启动卡（不用于对外演示）
- [CHALLENGE.md](CHALLENGE.md) — 题目原文
