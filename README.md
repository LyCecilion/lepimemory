<!-- Lepimemory — 极创工作室第二次面试题 -->

# 蝶忆 Lepimemory

> 一个具有**持续状态、人格、长期记忆与真实行动**能力的角色 Agent —— 而且它的每一次变化都能被观测与审计。
> （极创工作室第二次面试题 · 形式：PPT + 公开仓库）

**状态**：Phase 0–4 已完成（架构决策 / dsh 状态注入验证 / Hindsight 记忆服务跑通 / 角色运行时骨架）。**Lv1·Lv2 运行时收敛已实现并完成切换**（`RUNTIME_CONTRACT = 1`）：单一 SQLite 写入 + 不可变快照 + 统一审计、必经控制与权限确认、逐候选准入、获准快照写入可核对的 raw 来源、按现行政策投影 recall、canonical surface 遗忘/恢复、真实行动与状态审计；旧 JSON 状态/审计文件与 `memory.js` fire-and-forget 写入路径已删除，不保留兼容别名。

> **验收边界**：11 项运行时实现及实际 Web D0–D7 已完成；按用户要求收束，D8 完整独立演示及额外后端比较不继续执行，**不宣称 D0–D8 全套通过**。真实证据、失败与边界见 `docs/DEMO.md`、`docs/DEVLOG.md`；`docs/research/` 保留为历史记录，非当前工作流。

## 快速开始（评委自助）

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
| `Makefile` · `scripts/bootstrap-runtime.sh` · `scripts/runtime.mjs` | 固定运行时入口：`bootstrap` / `install-profile` / `dev` / `verify`（`verify` 另跑 `scripts/verify-runtime.mjs` 与插件行为测试） |
| `package.json` · `pnpm-lock.yaml` · `pnpm-workspace.yaml` | 根工作区：锁定 Node/pnpm/dsh 版本与插件依赖（frozen install） |
| `dsh/profiles/lepimemory/` | profile 源（人设 + 能力面裁剪 + 隔离 realm）；由 launcher 复制并生成到 `$DSH_HOME` |
| `dsh/plugins/dsh-lepimemory-state/` | 自研角色运行时插件（SQLite 状态/审计、控制、准入、记忆、历史、行动、面板） |
| `deploy/hindsight/` · `deploy/laya/` | 两个固定记忆服务的镜像定义（按 digest / revision 固定，不拉浮动模型） |
| `docker-compose.yml` | 记忆服务编排（仅 loopback 端口；复用既有同名数据/缓存卷） |
| `docs/DEMO.md` · `docs/DEVLOG.md` | 当前演示剧本与开发日志 |
| `docs/research/` | dsh 调研、Hindsight 实测报告与历史附录（历史记录） |
| `.env.example` | 环境变量样例（凭据留空；见下） |

## 配置（`.env.example`）

所有运行配置经 `LEPI_*` 环境变量；样例见 `.env.example`，**凭据字段一律留空**，真值只放本机 `.env`（已 gitignore）。

- 共享连接 `LEPI_LLM_BASE_URL` + `LEPI_LLM_API_KEY`：**成对填写**（要么都填、要么都空）；只填一项在启动时报 `LEPI_CONNECTION_INCOMPLETE`，不会发往任何默认官方 URL。
- 每路由连接 override（`LEPI_ROLE_*` / `LEPI_PROCESS_*` / `LEPI_CONTROL_FALLBACK_*` / `LEPI_HINDSIGHT_*`）：**未设置则整组继承共享连接；要覆盖必须 URL/key 成组**，不部分继承。
- `LEPI_BANK` 默认 `lepimemory-v2`，拒绝旧 `lepimemory`；演示用新的 `lepimemory-demo-*`。
- 旧 `.env` 首次加载一次性迁移：先备份 `.env.legacy-<timestamp>`（0600），`GEEK_TECH_CLUB_API_KEY` → `LEPI_LLM_API_KEY`、旧 `HINDSIGHT_API_LLM_*` → `LEPI_HINDSIGHT_*` override；迁移后不再支持旧别名。端点缺失只报告字段名，不猜地址。

## 文档地图

- `CONCEPTS.md` — 已定的架构决策
- `DESIGN_NOTES.md` — 正在形成的判断（含未解项）
- `HANDOFF.md` — 推进计划与上下文交接
- `docs/DEVLOG.md` — 开发日志（工作全过程 + 踩坑台账）
- `CHALLENGE.md` — 题目原文
