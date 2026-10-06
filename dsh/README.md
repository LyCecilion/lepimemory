# dsh/ — Lepimemory 的 DeepSeek Harness 资产

> 本目录是 Lepimemory 的 dsh 侧资产：一个 profile（人设 + 能力面裁剪 + 隔离 realm）和一个 out-of-tree 插件 `@dsh-external/dsh-lepimemory-state`。
> 项目总览见仓库 [README](../README.md)，本机启动卡见 [LOCAL_HANDOFF.md](../LOCAL_HANDOFF.md)，架构理由见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

## 组成

| 路径 | 说明 |
| --- | --- |
| `profiles/lepimemory/` | profile **源**：正式人设（`@deepseek-ai/dsh-persona`）+ 能力面裁剪（`tool-web` 只留 search、`fetch:false`；`session-reference` / `file-reference-local` 禁用）+ 压缩/裁剪（`compaction-basic`、`tool-result-pruner`，放在 preset 的 isolate realm）+ `lepimemory-state` 配置行 |
| `plugins/dsh-lepimemory-state/` | 自研角色运行时插件（见下文） |

profile 目录是源，不直接运行：由 launcher 复制并生成到 `$DSH_HOME/profiles/lepimemory`。

## 固定安装 → 构建 → 验证

不使用全局 dsh / npx / 手工 `dsh plugin add link:`，统一走仓库固定 launcher（`make` 已在 PATH 前置 `.runtime/bin`）：

```bash
make bootstrap                                      # 校验并安装 Node 24.20.0 / pnpm 10.28.2
make install-profile DSH_HOME=/tmp/lepimemory-home  # frozen install + 生成 profile（先 build）
DSH_HOME=/tmp/lepimemory-home make dev              # 构建后启动锁定 dsh（core 就绪后打印认证链接）

make build          # 编译手写源码 → 生成物（lib/、scripts/dist/、client.js）
make typecheck      # 静态类型检查（emitDeclarationOnly + 三个 noEmit 检查）
make verify         # 行为测试 + SQLite CLI smoke
make lint           # ESLint（--max-warnings=0）
make format-check   # Prettier 检查
make check          # 完整门：verify → lint → format-check
```

`make install-profile`（由 `scripts/src/runtime.ts` 实现）做四件事：

1. `pnpm install --frozen-lockfile` 安装根工作区（不重新解析依赖）；
2. 把 `dsh/profiles/lepimemory` 复制进 `$DSH_HOME/profiles/lepimemory`；
3. 按解析后的连接生成 `cordis.patch.yml` 与 `package.json`；凭据只以环境变量名出现，值只随子进程传递，绝不写进 profile；
4. 物化绝对插件 link（`node_modules/@dsh-external/dsh-lepimemory-state` → 本插件目录）。插件依赖用仓库相对路径（`link:../../../dsh/plugins/…`），不要手改。

另外几点：

- profile 只对本 launcher 生成的目录幂等；遇到外来同名目录报 `LEPI_PROFILE_CONFLICT`，不覆盖用户 profile。
- 未配置共享连接时生成物写 `providers: {}`，并中和草稿里残留的官方 URL 回落——不会放行 stock 模型偷跑。
- 每次启动先校验固定 Node 版本、锁定 CLI 与插件版本、以及 `/lepimemory/health` 的 `core=true`；核心不兼容或 SQLite 失败即终止，不会回退到系统工具。

## 源码与产物（不要编辑生成物）

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| 手写服务端源码 | `plugins/dsh-lepimemory-state/src/*.ts` | 内部 import 带显式 `.ts` 后缀，`tsc` 输出时改写为 `.js` |
| 浏览器安全共享定义 | `plugins/dsh-lepimemory-state/src/shared/*.ts` | 无 `node:` 依赖，服务端与客户端共用 |
| 手写客户端源码 | `plugins/dsh-lepimemory-state/src/client/**/*.ts(x)` | React namespace JSX；`panel.css` 是样式原文 |
| 构建/运行时源 | `scripts/build.mts`、`scripts/src/*.ts` | `build.mts` 只用可擦除类型；runtime / verify-runtime 生成到 `scripts/dist/` |
| **生成物（gitignored）** | `plugins/dsh-lepimemory-state/lib/**`、`client.js`、`client.js.map`、`scripts/dist/**` | 由 `make build` 生成，不要提交或手工修改 |
| 行为测试 | `plugins/dsh-lepimemory-state/test/*.test.js` | `node:test` 套件，走生成的 `lib/` 运行；保持 JS |

运行时只引用生成物（`main=./lib/index.js`、`exports["./client"]=./client.js`）。改行为只改 `src/`，再 `make build`。

## 模块阅读顺序（`src/`）

1. `config.ts`（`LEPI_*` 解析）→ `index.ts`（组装装配）。
2. `store.ts`（SQLite/事务/审计/快照）→ `task-store.ts` / `candidate-store.ts`（具名 SQL）→ `json.ts`。
3. `evidence.ts`（证据索引）→ `processor.ts` / `contracts.ts`（处理契约）→ `raw-source.ts` / `recall-source.ts`（来源核验）。
4. `control.ts`（必经控制）→ `admission.ts`（逐候选价值）。
5. 记忆协调：`memory.ts`（门面）→ `memory-supervisor.ts`（tick/lease/槽）→ `memory-pipeline.ts`（normalize/admit）→ `memory-authorization.ts`（政策 + 原子提交）→ `memory-common.ts` → `write-worker.ts` / `curate-worker.ts`。
6. 状态与读路径：`state-runtime.ts` / `machine.ts` / `trust.ts` / `recall.ts`。
7. 历史与行动：`history.ts`（有效历史隔离）、`action.ts`（真实便条）、`panel.ts`（操作者路由）、`hindsight.ts`（REST 客户端）。
8. 共享定义 `shared/`，客户端 `client/`（入口 `index.tsx`，组件在 `client/components/`）。

依赖单向：`client → shared`、`server → shared`、`shared` 无 `node:`；`memory-pipeline` 不 import `memory-supervisor`；`memory.ts` 是记忆模块的唯一门面。

## 类型检查 vs 运行时校验（都不能省）

- `make typecheck` 是静态保证：strict + `noUncheckedIndexedAccess` + Bundler resolution，覆盖服务端/客户端/scripts 与 `build.mts`。它防字段拼写、悬空 promise、`any` 等，但不代表外部数据合法。
- `make verify` 是运行时保证：真实 SQLite 文件、`node:sqlite`、行为套件与 CLI smoke，验证事务/回滚/单写者/不可变快照这些只有真跑才能证明的事。
- 外部输入（HTTP body、`JSON.parse`、模型输出）在源码里先按 `unknown` 收窄，再经 shape/validator 校验；类型断言不是数据校验，不能拿来"通过"构建。

## SQL owner 与事务边界

- `store.ts` 是 schema、CHECK 约束与审计的唯一所有者；`task-store.ts` / `candidate-store.ts` 只提供具名 SQL，由调用方放进原有业务事务，不私自提交新的业务单元。
- `memory-authorization.ts` 持有"快照 + 生命周期 + write 任务 + 审计"的外层事务，不能拆成三次独立提交。政策读取保留在授权 owner，不在协调器里内联业务 SQL。
- 不跨 `await` 持有事务，网络等待不占 SQLite 事务。`Store.transaction` 运行时强制同步、拒绝嵌套 savepoint、拒绝 async。

## 插件 `dsh-lepimemory-state`（当前实现）

单一存储：`$DSH_HOME/lepimemory/runtime.sqlite`（`node:sqlite`，`schema_version=1`，`journal_mode=DELETE` / `synchronous=FULL` / `foreign_keys=ON`），状态与完整审计在同一事务提交。不读写 JSON 状态文件，也不从消息正文跑正则。

**工具面**：只有 `manage_memory`（`kind` ∈ `remember` / `correct` / `forget` / `restore` / `re_remember` / `grant` / `revoke`，只带 `source_ids` / `candidate_ids`，不传正文）和 `write_note`。

**面板路由**（全部经共享 `connection` 鉴权，未鉴权即 401/403，不读 store）：

| 路由 | 权限 | 用途 |
| --- | --- | --- |
| `GET /lepimemory/health` | 公开只读 | launcher readiness（core / node / dsh / schema / service-ready） |
| `GET` · `POST /lepimemory/state` | 操作者 | 有效状态（衰减视图）；数值调整校验后固定原因、原子提交 + 审计 |
| `GET /lepimemory/history?kind=&limit=&offset=[&grouped=1]` | 操作者 | 审计分页（封闭 kind 集合）；`grouped=1` 按主体分组、按组分页 |
| `GET /lepimemory/candidate?id=&reveal=` | 操作者 | 已获准快照 / 生命周期 / 来源引用（`reveal=1` 仅审计原文） |
| `POST /lepimemory/retry` | 操作者 | 唤醒既有 request/task（不新开 operation） |

## 隔离 smoke 方法（开发验证）

面向开发者与验证者，不操作真实用户数据：

- 用固定 `.runtime/bin/node` / `.runtime/bin/pnpm`；为新验证 `mktemp -d` 出自有 fixture，配 `DSH_HOME=$FIXTURE/home`、全新 `LEPI_BANK=lepimemory-<uuid>` 与空 env 文件。绝不复用或清理用户 home/bank/volume。
- 不用 `make reset` / `docker compose down -v` 来"从零开始"，不停用户服务。想干净就用新 home + 新 bank。
- 合成数据、脱敏输入：测试一律用虚构材料（如「青柠」/`lepi-test`），不把真实记忆、笔名、私人端点或凭据写进仓库或 fixture。提交前对照本地 `.sanitize-patterns`（gitignored，绝不提交）复查。
- 实验原始产物（`--dump-config` 快照、session jsonl、沙盒 home）一律放 `/tmp`；仓库里只留结论。
- 外部记忆服务缺席时，用 fixture 注入依赖缺席来验证"非 fatal / deferred"分支；不为测试在产品代码里加 skip 开关。

## 配置

全部经 `LEPI_*` 环境变量（见根 [.env.example](../.env.example)）。共享连接 `LEPI_LLM_BASE_URL` + `LEPI_LLM_API_KEY` 成对填写；每路由 override 必须 URL/key 成组。旧 `.env` 首次加载一次性迁移并先备份 `.env.legacy-<timestamp>`（0600），旧别名迁移后不再解析。端点/key 只来自环境，不进仓库、日志或回执。
