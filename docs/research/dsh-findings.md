# dsh 实地调研报告（DeepSeek Harness · 0.1.7-rc.2）

> **历史证据 · 非当前工作流**：本文是 2026-09-28 的 dsh 实机调研记录，采样与结论按当时原样保留。当前架构见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) §1–§2。
> ⚠️ 与现状的差异：文中早期的启动/操作方式（全局 `dsh`、`!!js` 读端点、`make reset`、手工 env）**不是当前启动指南**；现行入口见 [README](../../README.md) 与 [dsh/README](../../dsh/README.md)。

> 整理：Agent 会话，2026-09-28（v0.3）。基于本机 Fedora 实机验证，供 Lepimemory 部署与后续开发使用。
> 关联：当前架构见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) §1–§2。
> 相关文件：`docs/research/artifacts/`（组合树快照）、`dsh/profiles/lepimemory/`（profile 草案）、仓库根目录部署脚手架。

## TL;DR

1. 「复用 npm 发布版 dsh + 新建 `lepimemory` profile」路线**已验证可行**；专用实例已跑通（§4）。
2. 本机红线：**永远让 dsh 用自带 runtime 的官方 Node 启动**（`~/.local/bin/dsh` wrapper 已封好）；nixpkgs 构建的 Node 会启动即崩（§3.1）。
3. 能力面裁剪的正确落点：**agent preset 的 plugins 列表**（Web 面下会话能力由 preset 决定，而不是顶层 row 的 disabled）——与 `CONCEPTS.md` 现有表述有一处小差异，建议按此修正（§2.7）。
4. 「全新 DSH_HOME + 直装 profile」的安装/启动链路已在沙盒验证（§4）——`make dev` 的核心假设成立。

## 1. 本机实况（2026-09-28）

| 项 | 个人实例 | Lepimemory 专用实例 |
| --- | --- | --- |
| 服务 | `dsh.service`（用户级） | `lepimemory-dsh.service`（用户级） |
| 端口 | 127.0.0.1:3080 | 127.0.0.1:3180 |
| profile | `web`（含个人 patch 定制） | `lepimemory`（见 §6 草案） |
| 状态 | 14:51:43 起，0 重启，内存 ~400MB | 18:38:56 起，0 重启，内存 ~120MB |

- 安装：`~/Applications/dsh`（569MB）；CLI：`~/.local/bin/dsh`（wrapper → 官方 Node 24 runtime）；版本 `0.1.7-rc.2`。
- 数据：`~/.dsh`（337MB）：`profiles/`、`sessions/`（按工作目录分桶）、`storages/`、`sessions-search.db`、`.credentials.yaml`（600）。
- 修复史：09-28 14:51 之前 24h 内有 118 次失败重启（根因：nixpkgs Node 与 `node-addon-require-builtin` 不兼容）；改用 runtime 官方 Node 后归零。
- 另有 Hindsight 容器常驻（127.0.0.1:8888 API / :9999 UI，镜像 `ghcr.io/vectorize-io/hindsight:latest`，卷 `hindsight-data`，`restart: unless-stopped`）。

## 2. 关键机制（对 Lepimemory 相关）

1. **profile 分层**：bundle patches → profile `cordis.patch.yml` → home patch → `--patch` 叠加；`--dump-config` 可免启动检查组合树。
2. **创建 / 安装**：`dsh --profile <name> --from-default-profile web`（用 shipped 模板建新 profile）；`dsh plugin --profile <name> add <pkg>`（插件管理，转发 pnpm）；profile 也可直接以文件目录安装进 `$DSH_HOME/profiles/<name>/`（沙盒已验证）。
3. **Web 鉴权**：启动打印 `http://127.0.0.1:<port>/?token=…`；无 token → 401；token → 303 + HttpOnly cookie → 200。`--port / --host / --no-open / --trusted-host` 可控。
4. **默认模型**：base 行出厂自带 `deepseek-official / deepseek-flash`；自定义端点（零代码）配在 `llm-pi-ai` 行的 `providers`。
5. **审批与沙箱**：默认 workspace-write + ask、fail-closed；副作用操作可被审批留痕。
6. **审计底座**：session log 为 append-only 事件日志；"Model-visible ⟺ logged" 有运行时校验；插件可经 `SessionEventMap` 追加自定义事件。
7. **裁剪落点（重要）**：Web 面下每个会话挂一个 agent preset；编码向行（tool-bash / fs / skills / …）已被 bundle 从 host 面挪走、**由 preset 决定是否挂载**。→ 想裁，就自定义 preset + 改 `agent-preset-registry` 默认。新增行用 `- insert:`；对既有行的补丁为「整行替换 config」。
8. **遥测**：OTel 默认 `FEEDBACK_ONLY` 发送至 deepseeksvc（`DSH_TELEMETRY_MODE` 可调）。
9. **section `text` 支持函数形式**：每次 prompt 组装都会调用 `section.text(context)`（`packages/core/system-prompt/src/index.ts:606`）——「每轮重读外部状态」的机制依据（2026-09-29 复核）。
10. **插件日志通道**：cordis 标准 `ctx.logger`（`ctx.logger('<name>')` 取具名 logger）——插件报错/提示统一走它（2026-09-29 复核）。
11. **`DSH_HOME` 解析语义**：`resolveDshHome()` = 显式配置 → `$DSH_HOME` → `~/.dsh`（`packages/util/home-paths`；含 `~` 展开与绝对化）——插件自持文件路径需与之一致（2026-09-29 复核）。
12. **插件日志可见性（踩坑）**：`ctx.logger('<name>')` 是 cordis 标准通道，但 **stock bundle 未挂 console exporter**——运行时 `.warn/.error` **不会**出现在 `dsh web` 的 stdout（仅 app-boot 的 diagnostics exporter 收集启动期 warn/error，`warning: N entries did not activate` 即来自它）。→ 要「给人看的日志」需显式挂 logger 行，或改走 **durable 审计事件**（Phase 3 的 429 退避/降级提示应走后者）。
13. **会话事件订阅与每轮收尾钩子**：插件可 `ctx.on('session/event', (session, event) => …)` 订阅（回调直接拿到 live Session）；`agent/turn-stopping` 是 **serial** 派发，payload `{ agent, turn, signal }`，在轮次关闭**之前**运行（`core/agent-loop/src/agent.ts:359-362`）→ 可在**开放轮次内**用 `agent.session` 追加事件。现成范例：`deliverables/workspace-changes/src/{index,recorder}.ts`。
14. **⛔ out-of-tree 插件不能追加「新事件类型」（Phase 3 审计的硬约束，2026-09-29 实测）**：
    - **读侧**：`session-persistence` 按**仓库内生成的静态白名单** `KNOWN_SESSION_EVENT_TYPES`（`core/session/src/known-event-types.ts`）准入；不在表内且**无 `ignorable: true`** 的事件 → **整条日志被拒绝解读**（`session-persistence/src/storage-contract.ts`）。
    - **写侧**：`Session.append(type, data)` **没有 `ignorable` 透传入口**（`core/session/src/index.ts:722`）。官方插件实践直言：**不要用新事件类型 append**，改用「从既有事件派生」或「插件自有存储」（`preset/agent-preset/skills/cordis-plugin-development/references/practices.md`）。
    - **实测**：在 `agent/turn-stopping` 里 `agent.session.append('persona/state-diff', {...})` → 追加**成功**（日志出现 seq=64、**无 `ignorable`**）；重启进程重开会话 → `Failed to load history: … contains event type "persona/state-diff" (seq 64) unknown to this harness and not marked ignorable; refusing to interpret the log`（**整个会话不可加载**）。
    - **写路径穷举（2026-09-29 补测）**：冷路径 `ctx.sessionPersistence.open(id,'write')` 的 `SessionHandle.append(events)` 虽接受完整事件（含 `ignorable`），但 seam **单写者**、活会话写句柄已被 agent-loop 持有 → 探针实测 `SessionAlreadyOwnedError: … already owned by an active write handle`。故**无任何受支持的活写路径**。
    - **结论**：CONCEPTS §5.3 原计划「合并 `SessionEventMap` 追加 `memory/recall` / `persona/state-diff` / `decision/attribution`」在本版本**对 out-of-tree 插件不可行**；审计须落**插件自有持久化**，或从既有事件派生——而「已落 `system/message` 的提示词变更」本身就是「效果」的可回放证据（Trajectory 的 Prompt Diff 即此）。

## 3. 注意事项与坑

- **3.1 Node 构建**：本机（nixpkgs）不可用；一律走 `~/.local/bin/dsh`。交付 README 建议注明「dsh 需要官方发行版 Node（或使用随包 runtime）」。
- **3.2 端口**：评审机默认 :3080；本机 :3080 被个人实例占用 → 专用实例用 :3180。`make dev` 支持 `PORT` 覆盖。
- **3.3 DSH_HOME**：专用实例目前共享 `~/.dsh`（凭据 / 历史共用）；交付形态用独立 DSH_HOME（`make dev` 默认 `./.dsh`，已 gitignore，可一键重置）。
- **3.4 参考仓库**（`Workspace/external/deepseek-harness`）是只读源码参考（无依赖、不做全仓构建）；**不要在其中运行 dsh**。
- **3.5 凭据**：`.credentials.yaml` 不进仓库；自定义端点走环境变量（`.env`）；systemd 实例需 `EnvironmentFile` 注入。
- **3.6 文档修正**：`CONCEPTS.md` §6.5 的 `pnpm dsh web --profile lepimemory` 实际会报 `select a profile only once` —— **已于 2026-09-28 修正**为 `pnpm dsh --profile lepimemory`（或 `dsh lepimemory`）。
- **3.7 本机环境**：`docker compose` 曾缺失，已于 2026-09-28 安装（v5.5.1）；Hindsight 已迁到仓库 `docker-compose.yml` 管理（见 `hindsight-findings.md`）。评委环境按 compose 流程即可。

## 4. 验证记录（本机实测）

| 项目 | 结果 |
| --- | --- |
| 服务启动 + 鉴权链 | ✅ 401 → 303 → 200（34KB SPA） |
| 重启韧性 | ✅ 重启后 6s 内恢复 |
| 端到端模型调用（headless） | ✅ "PONG" @1.75s |
| 实例隔离对照 | ✅ 个人实例 uptime 未断、0 重启 |
| 草案组合验证（`--patch` 叠加 + `--dump-config`） | ✅ 见 `artifacts/dsh-lepimemory-draft-composed.yml` |
| 沙盒全量启动（独立 `DSH_HOME` + 直装 profile） | ✅ 随机端口，401 → 200（SPA 34KB） |
| UI 端到端对话 + preset/工具面核验（会话日志） | ✅ `agentPreset=lepimemory`；工具仅 `web_search` / `web_fetch` / `ask_user_question` |
| 状态注入插件 A/B（假人格实验） | ✅ 语气显著变化（见 `artifacts/ab-fake-persona.md`） |
| `make dev` 全流程（仓库内 `DSH_HOME`，全新一次跑通） | ✅ 401 → 200；插件行入组合树（修复见 §7） |

未验证（待后续）：取消 / 打断语义（CONCEPTS §8 未决项）。

## 5. 操作速查

```bash
# 组合树检查（免启动；可加 --patch <file.yml> 叠加验证）
dsh --profile lepimemory --dump-config

# 一次性任务（真实模型调用）
dsh --profile headless "……"

# 插件管理
dsh plugin --profile lepimemory add <pkg>

# 专用实例管理
systemctl --user restart lepimemory-dsh
journalctl --user -u lepimemory-dsh -n 20 | grep token   # 入口链接（重启会换 token）
```

## 6. profile 草案说明（`dsh/profiles/lepimemory/`）

目标 = 「模型接入 + 能力面裁剪」两件事：

1. **模型接入**：`llm-pi-ai.providers` 追加 `geek-tech-club`（`.env`: `GEEK_TECH_CLUB_API_KEY`）；默认模型暂保持 `deepseek-official`；「切换为 .env 端点」的开关以注释形式预留（评委场景建议开启）。**baseURL 亦来自 `.env`（`LEPI_LLM_BASE_URL`，经 `!!js` 读取；已实测：合法表达式启动零错误、非法表达式启动即 `SyntaxError` 快速失败，见根 `HANDOFF.md`「工作区纪律」）。**
2. **裁剪**：新增 `preset-lepimemory`（persona 正式文本 / tool-ask-user / tool-web / compaction 启用，见 `artifacts/context-management.md`），并把 `agent-preset-registry` 默认指向它；编码向工具不挂载；「行动工具」留给自研插件。
3. **人设**：preset 的 persona 行按 per-agent 遮蔽部署级「coding agent」文案（无需改全局 `system-prompt`）；**正式人设文本已落地在该行的 `prefix`**（见 `artifacts/persona-injection.md`）。

   ⚠️ **persona 遮蔽是必须项，不是美化项**——A/B 实验直接提供了证据：
   `artifacts/ab-fake-persona.md` 状态 B 的回复里，模型自称
   「我这"一天"其实就是在 `/tmp/lepimemory-dsh-tests` 这个工作目录里待命，随时准备帮你跑命令、翻文件、查资料」。
   该 A/B 已证明「状态文本能改变语气」，但**同一份证据也说明底座 coding-agent 人设会渗透出来**：
   状态只改语气，改不掉身份自述。故遮蔽必须在 Phase 1 落地，且正式人设文本不能照抄状态 B 的措辞
   （它仍是 coding agent 口吻，非目标角色文案）。

   **机制依据**（`packages/preset/persona/src/index.ts:64-71`）：persona 包的 prefix / suffix
   就是 `DEPLOYMENT_PERSONA_PREFIX`(order 0) 与 `DEPLOYMENT_PERSONA_SUFFIX`(order 10200)
   两个中央槽位；preset 内的 persona 行以**同名 section** 注册，故在 agent scope 内 shadow 全局贡献
   （`system-prompt` 的 scoped section 同名即遮蔽）。

**评审点**：① 默认 provider 是否切换；② 裁剪清单取舍（web / ask-user / compaction）；③ 行动工具形态；④ 评审通过后：应用到运行实例 + 重启 + 回归验证。

## 7. 部署脚手架（草案 v0.1，仓库根目录）

- `docker-compose.yml` —— Hindsight：镜像 / 端口 / 卷 / `restart` 对齐本机现有容器；健康检查打 `/health`（用镜像内 python3）。
- `.env.example` —— Hindsight key + dsh 端点 key；全部可留空（零 key 路径）。
- `Makefile` —— `dev / stop / clean / reset`；`dev` = compose 等健康检查 → dsh 前台启动；`DSH_HOME` 默认 `./.dsh`。
- `.gitignore` —— `.env` / `.dsh/` / `node_modules/`。
- `README.md`、`docs/DEMO.md`（均已定稿）。
- 已验证：compose YAML 可解析 ✅、`make -n dev` 命令序列正确 ✅、profile 沙盒启动链路 ✅、
  **完整 `make dev` ✅**（本机 3181 冒烟：401 → 200；插件行入组合树）。
- 测试中发现并修复两处（2026-09-28）：① `install-profile` 缺依赖物化 → 增加
  `dsh plugin --profile lepimemory install`；② 插件依赖改为**仓库相对 link**（`link:../../../dsh/plugins/…`）。
- 注：compose 步骤已去掉 `--pull always`（避免误换正在运行的容器）；需要最新镜像时手动 `docker compose pull`。

## 8. 变更记录

- 2026-09-28 v0.1：初稿（本机实地调研 + profile 草案）。
- 2026-09-28 v0.2：补部署脚手架草案与验证记录；新增文档修正 3.6 / 3.7。
- 2026-09-28 v0.3：修正 `CONCEPTS.md` §6.5 启动命令（见 3.6）。
- 2026-09-28 v0.4：`make dev` 全流程实测（含两处修复）；§3.7 更新（compose 已装）。
- 2026-09-28 v0.5：脱敏与端点环境变量化——个人数据改合成示例；`LEPI_LLM_BASE_URL` 经 `!!js` 读取（非法表达式快速失败已实测）；工作区纪律见根 `HANDOFF.md`。
- 2026-09-29 v0.6：复核补 §2.9–2.11（`section.text` 函数形式 / `ctx.logger` / `DSH_HOME` 解析语义）与 headless 测试台构成，供 Phase 3 状态持久化实现。
- 2026-09-29 v0.7：补 §2.12 日志可见性踩坑（stock bundle 无 console exporter）；Phase 3 第一步（状态持久化）已实现并验收，见 `artifacts/state-persistence.md`。
- 2026-09-29 v0.8：补 §2.13–2.14（会话事件订阅 + 每轮收尾钩子；**out-of-tree 不能追加新事件类型**，实测重载拒绝）。据此改写 `CONCEPTS.md §5.3` 审计落点。
- 2026-09-29 v0.9：§2.14 补「写路径穷举」——冷路径 `ctx.sessionPersistence.open(id,'write')` 亦被单写者拒绝（探针实测 `SessionAlreadyOwnedError`），坐实「**无受支持活写路径**」。
