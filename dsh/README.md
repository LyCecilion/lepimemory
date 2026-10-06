# dsh/ — Lepimemory 的 DeepSeek Harness 资产

> Lepimemory 的 dsh 侧资产：一个 profile（人设 + 能力面裁剪 + 隔离 realm）和一个 out-of-tree 插件 `@dsh-external/dsh-lepimemory-state`。
> 本项目入口与演示见仓库 [README](../README.md)；**本机**启动卡见 [LOCAL_HANDOFF.md](../LOCAL_HANDOFF.md)（仅本机，不用于验收）；架构与设计理由见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。
> 历史实验记录（Phase 1 草案期）见 [docs/archive/dsh-findings.md](../docs/archive/dsh-findings.md)。

## 组成

| 路径 | 说明 |
| --- | --- |
| `profiles/lepimemory/` | profile **源**：正式人设（`@deepseek-ai/dsh-persona`）+ 能力面裁剪（`tool-web` 仅留 search、`fetch:false`；`session-reference` / `file-reference-local` 置 `disabled`）+ 压缩/裁剪（`compaction-basic`、`tool-result-pruner`，落在 preset 的 **isolate realm**）+ `lepimemory-state` 配置行 |
| `plugins/dsh-lepimemory-state/` | 自研角色运行时插件（下方详述） |

profile 目录是**源**，不直接运行：由 launcher 复制并生成到 `$DSH_HOME/profiles/lepimemory`。

## 固定安装 → 构建 → 验证

不使用全局 dsh / npx / 手工 `dsh plugin add link:`。统一走仓库固定 launcher（`make` 已在 PATH 前置 `.runtime/bin`）：

```bash
make bootstrap                                      # 校验并安装 Node 24.20.0 / pnpm 10.28.2
make install-profile DSH_HOME=/tmp/lepimemory-home  # frozen install + 生成 profile（先 build）
DSH_HOME=/tmp/lepimemory-home make dev              # 构建后启动锁定 dsh（core 就绪后打印认证链接）

make build          # 编译手写源码 → 生成物（lib/、scripts/dist/、client.js）
make typecheck      # 静态类型检查（emitDeclarationOnly + 三个 noEmit 检查）
make verify         # 运行 scripts/dist/verify-runtime.js：行为测试 + SQLite CLI smoke
make lint           # ESLint（手写源码/测试/配置，--max-warnings=0）
make format-check   # Prettier 检查（同一手写文件集合）
make check          # 完整门：verify → lint → format-check
```

`make install-profile`（`scripts/src/runtime.ts`，生成 `scripts/dist/runtime.js` 后执行 `install`）会：

1. 以 `pnpm install --frozen-lockfile` 安装根工作区（根 `pnpm-lock.yaml` 已生成，不重新解析依赖）；
2. 把 `dsh/profiles/lepimemory` 复制进 `$DSH_HOME/profiles/lepimemory`；
3. 按**解析后的连接**生成 `cordis.patch.yml` 与 `package.json`；凭据只出现为 `apiKeyEnv` 名字，值只随子进程 env 传递，绝不写进 profile；
4. 物化绝对插件 link（`node_modules/@dsh-external/dsh-lepimemory-state` → 本插件目录）。插件依赖用仓库相对路径（`link:../../../dsh/plugins/…`），不要手改。

- profile 仅对**本 launcher 生成**的目录幂等；遇到非本 launcher 生成的同名目录报 `LEPI_PROFILE_CONFLICT`，不覆盖用户 profile。
- 未配置共享连接时，生成物写 `providers: {}` 并中和 draft profile 中残留的官方 URL 回落——不会放行 stock 模型偷跑。
- 每次启动先校验固定 Node 版本、锁定 CLI 与插件 peer/helper 版本、以及 `/lepimemory/health` 的 `core=true`；核心不兼容或 SQLite 失败即终止（`make dev` 只在 `build` 成功后启动，缺依赖会给出明确提示而不是回退到系统工具）。

## 源码与产物（不要编辑生成物）

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| 手写服务端源码 | `plugins/dsh-lepimemory-state/src/*.ts` | 内部 import 用显式 `.ts` 后缀，`tsc` 输出时重写为 `.js` |
| 浏览器安全共享定义 | `plugins/dsh-lepimemory-state/src/shared/*.ts` | 无 `node:` 依赖，服务端与客户端共用 |
| 手写客户端源码 | `plugins/dsh-lepimemory-state/src/client/**/*.ts(x)` | React namespace JSX；`panel.css` 为样式原文 |
| 构建/运行时源 | `scripts/build.mts`、`scripts/src/*.ts` | `build.mts` 只用可擦除类型；runtime/verify-runtime 生成到 `scripts/dist/` |
| **生成物（gitignored）** | `plugins/dsh-lepimemory-state/lib/**`、`client.js`、`client.js.map`、`scripts/dist/**` | 由 `make build` 生成；**不要**提交或手工修改 |
| 行为测试 | `plugins/dsh-lepimemory-state/test/*.test.js` | 现有 `node:test` 套件，走生成的 `lib/` 运行；不迁 TS |

运行时只引用生成物（`main=./lib/index.js`、`exports["./client"]=./client.js`）。改行为只改 `src/`，再 `make build`。

## 模块阅读顺序（`src/`）

1. `config.ts`（`LEPI_*` 解析）→ `index.ts`（组装装配）。
2. `store.ts`（SQLite/事务/审计/快照）→ `task-store.ts` / `candidate-store.ts`（具名 SQL owner）→ `json.ts`。
3. `evidence.ts`（中性证据索引）→ `processor.ts` / `contracts.ts`（受限模型契约）→ `raw-source.ts` / `recall-source.ts`（来源核验）。
4. `control.ts`（必经控制）→ `admission.ts`（逐候选价值）。
5. 记忆协调：`memory.ts`（门面）→ `memory-supervisor.ts`（tick/lease/槽）→ `memory-pipeline.ts`（normalize/admit）→ `memory-authorization.ts`（政策读取 + 原子提交）→ `memory-common.ts`（共享纯导出）→ `write-worker.ts` / `curate-worker.ts`。
6. 状态与读路径：`state-runtime.ts` / `machine.ts` / `trust.ts` / `recall.ts`。
7. 历史与行动：`history.ts`（canonical surface）、`action.ts`（真实便条）、`panel.ts`（操作者路由）、`hindsight.ts`（REST 客户端）。
8. 共享定义 `shared/`，客户端 `client/`（入口 `index.tsx`，组件在 `client/components/`）。

依赖单向：`client → shared`、`server → shared`、`shared` 无 `node:`；`memory-pipeline` 不 import `memory-supervisor`；`memory.ts` 是记忆图的唯一门面。

## 类型检查 vs 运行时校验（两者都不能省）

- `make typecheck` 是**静态**保证：strict + `noUncheckedIndexedAccess` + Bundler resolution，覆盖服务端/客户端/scripts 四套 tsconfig 与 `build.mts`。它防字段/union 拼写、悬空 promise、`any` 等，但**不**代表外部数据合法。
- `make verify` 是**运行时**保证：真实 SQLite 文件、`node:sqlite`、六个行为套件与 CLI smoke；验证事务/回滚/单写者/不可变快照等只有真跑才能证明的事。
- 外部输入（HTTP body、`JSON.parse`、模型输出）在源码里**先按 `unknown` 收窄**，再经既有 shape/validator 校验；**类型断言不是数据校验**，不得用来「通过」构建。

## SQL owner 与事务边界

- `store.ts` 是 schema、CHECK 约束与审计的**唯一所有者**；`task-store.ts` / `candidate-store.ts` 只提供具名 SQL 操作，**由调用方把它们放进原业务事务**，不得私自 `commit` 出新的业务单元。
- `memory-authorization.ts` 持有「快照 + 生命周期 + write 任务 + 审计」的**外层事务**；不能用三次独立提交替代原原子单元。政策读取（`grants`/`forget_scopes`/`requests`/`history_work` fence）保留在授权 owner，不在协调器里内联业务 SQL。
- **不跨 `await` 持有事务**；网络等待不占 SQLite 事务。`Store.transaction` 保留「同步、拒绝嵌套 savepoint、拒绝 async」的运行时 gate。

## 插件 `dsh-lepimemory-state`（当前实现）

单一存储：`$DSH_HOME/lepimemory/runtime.sqlite`（`node:sqlite`，schema_version=1，`journal_mode=DELETE` / `synchronous=FULL` / `foreign_keys=ON`），**状态与完整审计在同一事务提交**。不再读写 `state.json` / `*.jsonl`，也不从消息跑正则；旧 fire-and-forget 写路径已删除。

**工具面**：仅暴露 `manage_memory`（`kind` ∈ `remember` / `correct` / `forget` / `restore` / `re_remember` / `grant` / `revoke`，只带 `source_ids` / `candidate_ids`，不传正文）与 `write_note`。旧的 `remember` / `forget` / `restore_memory` 工具已移除。

**面板路由**（全部经共享 `connection` 鉴权，未鉴权即返回 401/403，不读 store）：

| 路由 | 权限 | 用途 |
| --- | --- | --- |
| `GET /lepimemory/health` | 公开只读 | launcher readiness（core / node / dsh / schema / service-ready bool） |
| `GET` · `POST /lepimemory/state` | 操作者 | 有效状态（衰减视图）；数值调整经校验后固定原因、原子提交 + 审计 |
| `GET /lepimemory/history?kind=&limit=&offset=[&grouped=1]` | 操作者 | 审计分页（封闭 kind 集合）；`grouped=1` 按「主体」分组、以组为单位分页 |
| `GET /lepimemory/candidate?id=&reveal=` | 操作者 | 已获准快照 / 生命周期 / 来源引用（无 heap 回退；`reveal=1` 仅审计原文） |
| `POST /lepimemory/retry` | 操作者 | 按既有身份唤醒 request/task（不新开 operation） |

状态修改不再编辑 JSON 文件：运行时写走上述操作者 HTTP route（同一 SQLite writer）与工具路径。

## 隔离 smoke 方法（开发验证）

面向开发者与验证者；**不**操作真实用户数据。

- 用固定 `.runtime/bin/node` / `.runtime/bin/pnpm`；为新验证 `mktemp -d` 出一个自有 fixture，配 `DSH_HOME=$FIXTURE/home`、全新 `LEPI_BANK=lepimemory-<uuid>` 与空 env 文件。**绝不**复用或清理用户 home/bank/volume。
- **不运行** `make reset` / `docker compose down -v` 来「从零开始」；不停止用户服务。想干净就用新 home + 新 bank。
- **合成数据、脱敏输入**：测试一律用虚构材料（如「青柠」/`lepi-test`），不把任何真实记忆、笔名、私人端点或凭据写进仓库或 fixture。提交前对照本地 `.sanitize-patterns`（gitignored，含个人标识，**绝不提交**）复查。
- **实验原始产物放临时目录**：`--dump-config` 快照、A/B patch、session jsonl、沙盒 home 一律放 `/tmp`，验证完只把**结论**写进 `docs/archive/`；不进仓库。
- 外部记忆服务（Hindsight/laya）缺席时用本地 fixture 注入的外部依赖缺席验证「非 fatal / deferred」分支；不为测试在产品代码里加 skip 开关。

## 配置

全部经 `LEPI_*` 环境变量（见根 [.env.example](../.env.example)）；profile patch 里不再用 `!!js` 读端点。共享连接 `LEPI_LLM_BASE_URL` + `LEPI_LLM_API_KEY` 成对填写；每路由 override 必须 URL/key 成组。旧 `.env` 首次加载一次性迁移并先备份 `.env.legacy-<timestamp>`（0600）；`GEEK_TECH_CLUB_API_KEY` 等旧别名迁移后不再被解析。端点/key 只来自环境，绝不进仓库、日志或回执。

## 现状 / 证据

架构与设计理由见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)；演示剧本与开发日志见 [docs/DEMO.md](../docs/DEMO.md)、[docs/DEVLOG.md](../docs/DEVLOG.md)；当前固定 `make verify` 的实际输出与历史里程碑均在 DEVLOG。11 项运行时实现及实际 Web D0–D7 已完成；按用户要求收束，D8 完整独立演示及额外后端比较不继续执行，**不宣称 D0–D8 全套通过**。`docs/archive/` 保留为历史记录，非当前工作流。
