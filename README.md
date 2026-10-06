<!-- Lepimemory — 极创工作室第二次面试题 -->

# 蝶忆 Lepimemory

> 一个具有**持续状态、人格、长期记忆与真实行动**能力的角色 Agent —— 而且它的每一次变化都能被观测与审计。
> （极创工作室第二次面试题 · 形式：PPT + 公开仓库）

**状态：Lv1/Lv2 已完成并收尾。** 当前单用户、单角色运行时已实现并完成切换（`RUNTIME_CONTRACT = 1`）：单一 SQLite 写入 + 不可变快照 + 统一审计、必经控制与权限确认、逐候选准入、获准快照写入可核对的 raw 来源、按现行政策投影 recall、canonical surface 遗忘/恢复、真实行动与状态审计；旧 JSON 状态/审计文件与 `memory.js` fire-and-forget 写入路径已删除，不保留兼容别名。

> **验收边界**：11 项运行时实现及实际 Web D0–D7 已完成；按用户要求收束，D8 完整独立演示及额外后端比较不继续执行，**不宣称 D0–D8 全套通过**。真实证据、失败与边界见 `docs/DEMO.md`、`docs/DEVLOG.md`；`docs/archive/` 保留为历史记录，非当前工作流。

第一次看 Demo、想向别人解释页面和机制？先读 **[Lepimemory 怎么工作：机制与 Demo 页面导览](docs/MECHANISM.md)**：一分钟开场白、仪表盘读法、记忆/状态/行动闭环和逐屏讲解路线。

## Lv1/Lv2 完成口径

| 题目目标 | 已交付的闭环 |
| --- | --- |
| Lv1：持续对话与稳定角色 | 原生会话、有效历史与压缩；配置人设、持久心境/关系状态进入实际模型输入 |
| Lv2：拥有过去 | 逐候选理解/准入/授权、核实写入、跨会话政策召回、时效/纠正、全会话行为遗忘与选择性长期记忆恢复 |
| Lv2：真实行动 | 原生审批、独立 UUID 便条文件、执行账本与状态结算；拒绝不冒充成功 |
| 可观测性与审计 | 状态前后值、真实工具与文件、请求/任务回执、记忆来源链及操作者详情 |

完成依据是实际 Web **D0–D7** 记录，以及行为检查 + SQLite CLI smoke，见 [DEVLOG](docs/DEVLOG.md)。其中 **93/93 是 2026-10-05 当时的历史记录**，不是当前数字；当前固定 `make verify` 实际输出为 **103/103 通过**（每次以命令输出为准）。D8 完整独立验收已按用户要求收束；模型保守误判、限流与 `unknown` 仍如实呈现，不声称生产级全场景可靠性。Lv2.5 及更高等级不属于本轮交付。

## 快速开始（评委自助）

> 本机开发另有 [LOCAL_HANDOFF.md](LOCAL_HANDOFF.md)（固定 playground home/bank/端口）；那是**个人本机启动卡**，**验收一律用下面这类全新 fixture home/bank**，不要复用其中数据。

前置：Docker（含 Compose v2）、make、Bash、curl、tar、OpenSSL 与 shasum。
默认入口**不使用系统 Node 或全局 dsh/pnpm**：`make bootstrap` 校验并安装 Node **24.20.0** / pnpm **10.28.2**，根工作区锁定 dsh **0.1.7-rc.2**；后续只做 frozen install。

```bash
make bootstrap
# 没有 .env 时才复制；不要覆盖已有凭据。
cp .env.example .env
# 成组填写 LEPI_LLM_BASE_URL / LEPI_LLM_API_KEY；key 不会回落到官方端点。
make install-profile DSH_HOME=/tmp/lepimemory-new-home

# 用新的 fixture home / bank 启动（不要复用旧数据）。
DSH_HOME=/tmp/lepimemory-demo PORT=3181 LEPI_BANK=lepimemory-demo-20261005 make dev
```

统一入口（`make bootstrap` / `install-profile` / `dev` / `verify`），全部由仓库固定 Node **24.20.0** 驱动；`make dev` 在启动前先校验锁定 CLI/插件版本与 `/lepimemory/health` 的 `core=true`，核心不兼容或 SQLite 失败即终止：

- **安装是 frozen install**：根 `pnpm-lock.yaml` 已生成，命令只做 `pnpm install --frozen-lockfile`，不重新解析依赖；不使用全局 dsh/pnpm/npx，也不手工 `dsh plugin add`。
- **profile 由 launcher 生成**：`install-profile` 把 `dsh/profiles/lepimemory` 复制进 `$DSH_HOME`，按解析后的连接生成 `cordis.patch.yml`/`package.json` 并物化绝对插件 link。遇到**未由本 launcher 生成**的同名目录会报 `LEPI_PROFILE_CONFLICT`，请换新 home，不要删除原 profile。
- **原生认证**：打开 launcher 打印的认证链接，`303` 后清除 token；不要绕过认证直接读状态。
- **缺云连接 = 只读**：`LEPI_LLM_BASE_URL` + `LEPI_LLM_API_KEY` 都空时为 `unconfigured`，只读界面可用，控制/记忆请求被拒绝，**绝不回落到任何默认官方端点**。要对话必须显式成对填写（每路由 override 也必须 URL/key 成组）。
- **首次启动较慢且需要网络可达模型源**（默认 `hf-mirror.com`）：`make dev` 会构建两个**固定记忆服务镜像**——Hindsight 按固定镜像 digest + 模型 revision 缓存本地检索栈（向量维度 384），laya 是**独立 CPU 多语言服务**（`laya[serve]` 固定版本、torch CPU wheel、首次按 hash 锁定的 requirements）。两者都只在首次构建时拉模型，属构建前置，不是"秒级"。外部服务不可达时 core UI 与任务状态仍可用（记忆服务属外部依赖，不 fatal）。
- **不重置数据**：不要用 `make reset` 验证新机制；旧 bank、旧 home 与用户数据一律保留。旧 `.env` 首次加载会先备份权限 0600 的 `.env.legacy-*`，两文件均不提交。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `Makefile` · `scripts/bootstrap-runtime.sh` · `scripts/src/runtime.ts`（生成 `scripts/dist/runtime.js`） | 固定运行时入口：`bootstrap` / `build` / `install-profile` / `dev` / `verify` / `typecheck` / `lint` / `format-check` / `check`（`verify` 另跑 `scripts/src/verify-runtime.ts` 生成的 `dist/verify-runtime.js` 与插件行为测试） |
| `package.json` · `pnpm-lock.yaml` · `pnpm-workspace.yaml` | 根工作区：锁定 Node/pnpm/dsh 版本与插件依赖（frozen install）；devDependencies 固定 TS/esbuild/prettier/eslint |
| `dsh/profiles/lepimemory/` | profile 源（人设 + 能力面裁剪 + 隔离 realm）；由 launcher 复制并生成到 `$DSH_HOME` |
| `dsh/plugins/dsh-lepimemory-state/src/` | 自研角色运行时插件**手写 TS/TSX 源码**（服务端 `src/*.ts`、浏览器安全 `src/shared/*.ts`、客户端 `src/client/**`）；`lib/`、`client.js` 为生成物 |
| `deploy/hindsight/` · `deploy/laya/` | 两个固定记忆服务的镜像定义（按 digest / revision 固定，不拉浮动模型） |
| `docker-compose.yml` | 记忆服务编排（仅 loopback 端口；复用既有同名数据/缓存卷） |
| `docs/DEMO.md` · `docs/DEVLOG.md` | 当前演示剧本与开发日志 |
| `docs/archive/` | dsh 调研、Hindsight 实测报告与历史附录（历史记录） |
| `.env.example` | 环境变量样例（凭据留空；见下） |

## 配置（`.env.example`）

所有运行配置经 `LEPI_*` 环境变量；样例见 `.env.example`，**凭据字段一律留空**，真值只放本机 `.env`（已 gitignore）。

- 共享连接 `LEPI_LLM_BASE_URL` + `LEPI_LLM_API_KEY`：**成对填写**（要么都填、要么都空）；只填一项在启动时报 `LEPI_CONNECTION_INCOMPLETE`，不会发往任何默认官方 URL。
- 每路由连接 override（`LEPI_ROLE_*` / `LEPI_PROCESS_*` / `LEPI_CONTROL_FALLBACK_*` / `LEPI_HINDSIGHT_*`）：**未设置则整组继承共享连接；要覆盖必须 URL/key 成组**，不部分继承。
- `LEPI_BANK` 默认 `lepimemory-v2`，拒绝旧 `lepimemory`；演示用新的 `lepimemory-demo-*`。
- 旧 `.env` 首次加载一次性迁移：先备份 `.env.legacy-<timestamp>`（0600），`GEEK_TECH_CLUB_API_KEY` → `LEPI_LLM_API_KEY`、旧 `HINDSIGHT_API_LLM_*` → `LEPI_HINDSIGHT_*` override；迁移后不再支持旧别名。端点缺失只报告字段名，不猜地址。

## 文档地图

- `docs/ARCHITECTURE.md` — **唯一的现行架构说明**：职责边界、模块图、构建与产物政策、控制/授权、持久化与远程任务、召回/遗忘、状态/行动/立绘、边界与证据索引
- `docs/MECHANISM.md` — 面向观众与演示者的机制导览：页面怎么看、幕后怎样工作、现场怎么讲
- `docs/DEMO.md` — 固定验收剧本 D0–D8 与诚实清单
- `docs/DEVLOG.md` — 开发日志（工作全过程 + 踩坑台账 + 日期化历史）
- `docs/archive/` — 历史实测证据（dsh / Hindsight 调研与 artifact，非当前工作流）
- `dsh/README.md` — 开发者指南：固定安装 → 构建 → 验证、源码/产物、SQL owner 与隔离 smoke
- `LOCAL_HANDOFF.md` — **本机**启动说明（仅本机开发，不用于验收）
- `CHALLENGE.md` — 题目原文
