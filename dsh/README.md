# dsh/ — Lepimemory 的 DeepSeek Harness 资产

> 当前运行时已收敛到单一 SQLite 入口（`RUNTIME_CONTRACT = 1`）。历史实验记录（Phase 1 草案期）见 `docs/research/dsh-findings.md`。

## 组成

| 路径 | 说明 |
| --- | --- |
| `profiles/lepimemory/` | profile **源**：正式人设（`@deepseek-ai/dsh-persona`）+ 能力面裁剪（`tool-web` 仅留 search、`fetch:false`；`session-reference` / `file-reference-local` 置 `disabled`）+ 压缩/裁剪（`compaction-basic`、`tool-result-pruner`，落在 preset 的 **isolate realm**）+ `lepimemory-state` 配置行 |
| `plugins/dsh-lepimemory-state/` | 自研角色运行时插件（下方详述） |

profile 目录是**源**，不直接运行：由 launcher 复制并生成到 `$DSH_HOME/profiles/lepimemory`。

## 安装 / 使用

不使用全局 dsh / npx / 手工 `dsh plugin add link:`。统一走仓库固定 launcher：

```bash
make bootstrap                                      # 校验并安装 Node 24.20.0 / pnpm 10.28.2
make install-profile DSH_HOME=/tmp/lepimemory-home  # frozen install + 生成 profile
DSH_HOME=/tmp/lepimemory-home make dev              # 启动锁定 dsh（core 就绪后打印认证链接）
```

`make install-profile`（`scripts/runtime.mjs install`）会：

1. 以 `pnpm install --frozen-lockfile` 安装根工作区（根 `pnpm-lock.yaml` 已生成，不重新解析依赖）；
2. 把 `dsh/profiles/lepimemory` 复制进 `$DSH_HOME/profiles/lepimemory`；
3. 按**解析后的连接**生成 `cordis.patch.yml` 与 `package.json`；凭据只出现为 `apiKeyEnv` 名字，值只随子进程 env 传递，绝不写进 profile；
4. 物化绝对插件 link（`node_modules/@dsh-external/dsh-lepimemory-state` → 本插件目录）。插件依赖用仓库相对路径（`link:../../../dsh/plugins/…`），不要手改。

- profile 仅对**本 launcher 生成**的目录幂等；遇到非本 launcher 生成的同名目录报 `LEPI_PROFILE_CONFLICT`，不覆盖用户 profile。
- 未配置共享连接时，生成物写 `providers: {}` 并中和 draft profile 中残留的官方 URL 回落——不会放行 stock 模型偷跑。
- 每次启动先校验固定 Node 版本、锁定 CLI 与插件 peer/helper 版本、以及 `/lepimemory/health` 的 `core=true`；核心不兼容或 SQLite 失败即终止。

## 插件 `dsh-lepimemory-state`（当前实现）

单一存储：`$DSH_HOME/lepimemory/runtime.sqlite`（`node:sqlite`，schema_version=1，`journal_mode=DELETE` / `synchronous=FULL` / `foreign_keys=ON`），**状态与完整审计在同一事务提交**。不再读写 `state.json` / `*.jsonl`，也不从消息跑正则；旧 `memory.js` fire-and-forget 写路径已删除。

`lib/` 模块职责：

- `config.js` — 解析 `LEPI_*` 环境（唯一默认来源；不写回用户文件），旧 `.env` 一次性迁移；
- `store.js` — SQLite + 事务 + 审计 + 不可变快照 + owner/epoch；
- `evidence.js` / `processor.js` / `contracts.js` — 中性证据索引与受限模型契约（`submit_result` 校验）；
- `control.js` — 必经 `agent/pre-step` 控制、单一 `manage_memory` 工具、原生确认（`ctx.userQuestions`）；
- `admission.js` — 逐候选准入（`laya` 或 `generative`，显式选择、运行时不自动切换）；
- `memory.js` — normalize / admit / write supervisor（唯一 supervisor，短事务 claim + lease）；
- `write-worker.js` / `curate-worker.js` / `raw-source.js` / `recall-source.js` — 获准快照写入与 raw/document 核对（不靠口头成功）；
- `trust.js` / `recall.js` — 按现行政策投影召回（先政策、再分数）；
- `history.js` — canonical surface 遗忘/恢复（`session.append` + `surfaceOp`，不新增 dsh event 类型）；
- `state-runtime.js` / `state.js` / `machine.js` — 角色状态（6h 心境衰减 + 事件规则 + 渲染）；
- `hindsight.js` — Hindsight REST 客户端（`retainAsync` / `operation` / `document` / `units` / `cancel` / `recall`）；
- `action.js` — `write_note` 真实落盘（`<dataRoot>/notes/<action_id>.md`，原子创建 + 审计）；
- `panel.js` — 受限 HTTP 路由；`client.js`（插件根，`dsh.client`）— 浏览器侧状态面板；
- `index.js` — 组装（`openStore` → evidence → processor → admission → history → control/memory），注册 hook 后 `memory.start`。

**工具面**：仅暴露 `manage_memory`（`kind` ∈ `remember` / `correct` / `forget` / `restore` / `re_remember` / `grant` / `revoke`，只带 `source_ids` / `candidate_ids`，不传正文）与 `write_note`。旧的 `remember` / `forget` / `restore_memory` 工具已移除。

**面板路由**（全部经共享 `connection` 鉴权，未鉴权即返回 401/403，不读 store）：

| 路由 | 权限 | 用途 |
| --- | --- | --- |
| `GET /lepimemory/health` | 公开只读 | launcher readiness（core / node / dsh / schema / service-ready bool） |
| `GET` · `POST /lepimemory/state` | 操作者 | 有效状态（衰减视图）；数值调整经校验后固定原因、原子提交 + 审计 |
| `GET /lepimemory/history?kind=&limit=&offset=` | 操作者 | 审计分页（封闭 kind 集合） |
| `GET /lepimemory/candidate?id=&reveal=` | 操作者 | 已获准快照 / 生命周期 / 来源引用（无 heap 回退；`reveal=1` 仅审计原文） |
| `POST /lepimemory/retry` | 操作者 | 按既有身份唤醒 request/task（不新开 operation） |

**状态修改不再编辑 JSON 文件**：运行时写走上述操作者 HTTP route（同一 SQLite writer）与工具路径。

## 配置

全部经 `LEPI_*` 环境变量（见根 `.env.example`）；profile patch 里不再用 `!!js` 读端点。共享连接 `LEPI_LLM_BASE_URL` + `LEPI_LLM_API_KEY` 成对填写；每路由 override 必须 URL/key 成组。旧 `.env` 首次加载一次性迁移并先备份 `.env.legacy-<timestamp>`（0600）；`GEEK_TECH_CLUB_API_KEY` 等旧别名迁移后不再被解析。端点/key 只来自环境，绝不进仓库、日志或回执。

## 现状 / 证据

当前演示剧本与开发日志见 `docs/DEMO.md`、`docs/DEVLOG.md`；11 项运行时实现及实际 Web D0–D7 已完成。按用户要求收束，D8 完整独立演示及额外后端比较不继续执行，**不宣称 D0–D8 全套通过**。`docs/research/` 保留为历史记录，非当前工作流。
