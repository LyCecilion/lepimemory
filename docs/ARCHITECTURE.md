# Lepimemory 架构说明（当前实现）

本文是 Lepimemory **唯一的现行架构说明**。它记录*现在*的实现、职责边界与设计理由，并指向源码落点；它不是路线图，也不是验收记录。

- 早期过程草稿（`CONCEPTS.md`、`DESIGN_NOTES.md`、`PLAN.md`、`HANDOFF.md`）已被本文**取代并移除**；其中的有效结论并入此处，历史记录保留在 [DEVLOG](DEVLOG.md) 与 [archive](archive/)。
- 面向观众/演示者的页面导览见 [MECHANISM](MECHANISM.md)；固定验收剧本见 [DEMO](DEMO.md)；实测结论与证据见 [DEVLOG](DEVLOG.md) 与 [archive](archive/)。
- 实际启动、开发与排查命令见仓库 [README](../README.md) 与 [dsh/README](../dsh/README.md)。

**贯穿全篇的命题**：过去发生的事情，经过记忆与状态系统，确实改变了角色未来的判断、表达和行动；而这条因果链又能被人看到。架构的每一处取舍都在服务这条闭环，并把它做成**可核对的账本**而非事后日志。

---

## 1. 运行时与职责边界

### 1.1 一句话分工

| 组件 | 治什么 | 不替谁决定 |
| --- | --- | --- |
| **dsh**（DeepSeek Harness `0.1.7-rc.2`） | 会话、模型调用、工具管线、审批、上下文压缩、Web 客户端 | 不替插件决定长期记忆的授权与可用性 |
| **自研插件** `@dsh-external/dsh-lepimemory-state` | 控制、逐候选准入、授权、状态机、canonical 遗忘、可核实写入、政策召回、行动账本、审计 | 不重写会话或模型协议 |
| **Hindsight**（`0.10.0`，REST） | *原始*记忆生命周期：document / observation / 带 trace 的召回 | 不负责角色人格，也不决定一条材料当前是否可用 |
| **laya**（`0.3.26`，CPU 多语言）/ 备选 generative | 单候选「是否值得长期保存」的价值判定 | 不判对错、不判授权 |
| **SQLite**（`node:sqlite`，`schema_version=1`） | 状态、不可变快照、生命周期、授权、任务、行动、审计的单写者真源 | 不是「所有服务健康」的总灯 |

必须守住的边界：**不把角色人格外包给 Hindsight 的 bank 配置，也不把记忆检索退化成一次性 RAG 塞进 prompt；更不让 observation 凭一段流畅文字升格为事实。**

选择 dsh 的关键理由：它把「model-visible ⟺ logged」当作运行时**强制不变式**，题目要的可观测与审计几乎是白得的结构性保证；一切皆插件（out-of-tree 无需 fork），扩展点（系统提示词 section、工具注册、`agent/pre-step` waterfall、审批、slot）都是可卸载的 effect。

### 1.2 模块图（`PLUGIN/src`，服务端）

`PLUGIN` = `dsh/plugins/dsh-lepimemory-state`。内部 source import 用明确 `.ts`/`.tsx` 后缀，`tsc` 输出时重写为 `.js`。

**入口与配置**

- `src/index.ts` — 组装：`openStore` → evidence → processor → admission → history → control/memory/action/state/panel；注册 hook 后才 `memory.start`。唯一运行入口。
- `src/config.ts` — 解析 `LEPI_*`（唯一默认来源，不写回用户文件），含 `expandHome` 与旧 `.env` 一次性迁移。

**持久化**

- `src/store.ts` — SQLite 连接、事务、`audit`、不可变快照、owner/epoch；schema 与 CHECK 约束的所有者。
- `src/task-store.ts` / `src/candidate-store.ts` — task / candidate 行的 SQL owner（惰性 prepared SQL）。它们提供具名操作，**由调用方把它们放进原业务事务**，不私自提交新的业务单元。
- `src/json.ts` — `parseJson`（按 fallback 区分数组/对象/null）。

**证据与契约**

- `src/evidence.ts` — 中性证据索引（以 `session_id:seq:block_index` 引用消息，不存正文）+ `turnWindow` 只读窗口查询。
- `src/processor.ts` / `src/contracts.ts` — 受限模型契约与 `submit_result` 校验（一次结构修复额度）。
- `src/raw-source.ts` / `src/recall-source.ts` — raw / document 来源核验与组装。

**控制与记忆协调**

- `src/control.ts` — 必经 `agent/pre-step` 控制、单一 `manage_memory` 工具、原生确认（`ctx.userQuestions`）。
- `src/memory.ts` — 记忆运行时**门面**：构造 stores → authorizer → pipeline → workers → supervisor。构造器不查库、不起 timer、不注册 hook。对外只暴露 `createMemoryRuntime` 的 enqueue/afterTurn/start/wake/retry/health/dispose/recall/readMemory。
- `src/memory-supervisor.ts` — 唯一 tick/作业槽/lease 与计时器 owner；claim / expire / reconcile / wake。`runTask` 与 `runRemote` 由门面注入，**本模块不 import pipeline**，保持 import 图有向无环。
- `src/memory-pipeline.ts` — normalize / admit 作业处理（价值判定、有界准入、普通/私密分流、授权交接）。**不含任何 SQL**。
- `src/memory-authorization.ts` — 政策读取（`grants`/`forget_scopes`/`requests`/`history_work` fence + evidence session 查找）、候选政策核验、单项授权核验与「原子提交」外层事务。
- `src/memory-common.ts` — 共享纯导出（`BACKOFF`、稳定错误码、`identityOf`、公共类型）。
- `src/admission.ts` — 逐候选价值判定；`laya` 或 `generative`，**显式选择、运行时不自动切换**。
- `src/write-worker.ts` / `src/curate-worker.ts` — 可核实的 Hindsight 写入与远端整理。

**状态、行动与界面**

- `src/state-runtime.ts` / `src/machine.ts` — 回合结算（数据化规则、6h 心境衰减、状态审计）与组装期短事务衰减。
- `src/trust.ts` — 信任档与召回政策投影（先政策、再打分）。
- `src/recall.ts` — 读路径召回投影与审计。
- `src/history.ts` — canonical surface 遗忘/恢复（复用 `Session.append` + `sessionQuery`，不新增 dsh event 类型）。
- `src/action.ts` — `write_note` 真实落盘（`<dataRoot>/notes/<action_id>.md`，原子只创建 + 审计 + journal）。
- `src/panel.ts` — 受限操作者 HTTP 路由（先鉴权，401/403 在读取前拒绝）。
- `src/hindsight.ts` — Hindsight REST 客户端（`retainAsync`/`operation`/`document`/`units`/`cancel`/`recall`）。

**浏览器安全的共享定义（`src/shared`，无 `node:` 依赖）**

- `src/shared/domain.ts` — 领域词汇：Candidate / EvidenceRef / 任务 kind/status / 生命周期 / verdict / purpose 等 union；成员只允许来自既有契约字面量与 SQLite CHECK。
- `src/shared/api.ts` — 面板 HTTP DTO（`ok`/`preview`/`error`、可空/可缺字段、数值取值域）。
- `src/shared/state.ts` — 状态的纯定义/校验/渲染（`BASELINE`、`NUMERIC_FIELDS`、`validateState`、`renderState` 等）。
- `src/shared/activity.ts` — `deriveChatSignal` / `resolveActivity` 的纯规则（工具 > 说话 > 思考；审批/提问优先；错误/待机）。
- `src/shared/avatar-assets.ts` / `src/shared/avatar-frames.ts` — 立绘素材表与帧/候选表（`AvatarKey` 静态约束）。
- `src/shared/pins.ts` — 固定版本常量（Node `v24.20.0` / pnpm `10.28.2` / dsh `0.1.7-rc.2`）。

### 1.3 模块图（`PLUGIN/src/client`，浏览器 TSX）

- `src/client/index.tsx` — 浏览器半入口：经宿主 `window.__ModuleLoader__.load({ id, factory })` 以 lazy-CJS 装载；只导出 `inject = ['slots','locale','sidebarRightTabs']` 与 `apply`。`require` 只能取平台 seed（`react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`）。
- `src/client/components/*.tsx` — `Panel`、`StateStrip`、`Badges`、`HistoryBlock`、`HistoryRows`、`CandidateDetail`、`RecallDetail`、`EditorForm`、`AvatarOverlay`、`atoms`；组件只接 props，无 fetch / timer / 数据库知识。
- `src/client/{hooks,feed,status,history-model,util,constants,locales,types}.ts` + `panel.css` — hooks 组合、共享状态轮询源（`feed`）、状态标签、历史模型、请求工具与文案。

`src/client` 的 TSX 用 React namespace import（`jsx: 'transform'` + `React.createElement`），不生成 jsx-runtime require；`external` 严格限定在三个 seed 内。

---

## 2. 源码、产物与构建

### 2.1 最终目录

```text
PLUGIN/
  src/*.ts                     服务端手写源码
  src/shared/*.ts               浏览器安全的共享定义
  src/client/**/*.ts(x)         浏览器手写源码
  src/client/panel.css          面板样式原文（构建时以 text loader 内联）
  src/client/tsconfig.json      浏览器 noEmit 检查
  tsconfig.json                 服务端输出配置（rootDir=src → outDir=lib）
  lib/**                        生成的 ESM JS / d.ts / maps
  client.js (+ .map)            生成的宿主 lazy-CJS 客户端
  test/*.test.js                现有 node:test 行为测试（不改 TS）
scripts/
  build.mts                     可擦除类型的构建入口
  src/runtime.ts                固定运行时 / profile 生成 / dev / verify
  src/verify-runtime.ts         行为测试 + SQLite smoke
  dist/**                       生成的启动/验证 JS
  tsconfig.json · tsconfig.tools.json
```

### 2.2 生成物政策

`lib/`、`client.js`、`scripts/dist/` 全是**生成物**：不提交、不手工维护，已在 `.gitignore` 精确忽略。旧约定「把 `lib/` 当源码提交」已废止；全新 clone 通过「固定安装 → 构建」生成运行产物。

- 运行时只引用生成物：package `main=./lib/index.js`、`exports["./client"]=./client.js`、`files`/`dsh` 清单不变。
- 完整 build 在 emit 前只清理**已完成源码搬迁、明确属于生成区**的 `lib/`、`scripts/dist/` 与客户端输出；**不删除** assets、test、src、profile 或数据。

### 2.3 固定工具链与单向依赖

- 根工作区锁定并校验：Node **24.20.0**、pnpm **10.28.2**、dsh **0.1.7-rc.2**；devDependencies 精确固定（TypeScript 5.9.3、esbuild 0.25.12、prettier 3.6.2、eslint 10.12.0、typescript-eslint 8.71.1 等）。默认入口**不使用系统 Node / 全局 dsh / pnpm / npx**；安装统一 `--frozen-lockfile`。
- `tsconfig.base.json` 为 strict 基线（`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`noEmitOnError` 等）；服务端 rootDir=`src` → outDir=`lib`（declaration + map），客户端 `noEmit` + DOM + 经典 JSX，`scripts` 输出 `dist`。
- 依赖方向单向：`client → shared`、`server → shared`、`shared` 无 `node:` 依赖；`memory-pipeline` 不 import `memory-supervisor`；`memory.ts` 是记忆模块图的唯一门面。类型只有从已安装声明取用的 `import type {}` augmentation，不产生 runtime require，也不自造全局 AnyContext。

### 2.4 构建 / 检查入口

完整 build 顺序固定：校验 Node/pnpm → 需要时 frozen install → 服务端 tsc → scripts tsc → client/tools noEmit 检查 → 客户端 esbuild 打包 → 退出 0。任一步失败即非零退出，`make dev` **不得**回退到旧产物或系统 Node。

- `make build` = `node scripts/build.mts`；`make install-profile` = `build.mts --install` + `dist/runtime.js install`；`make dev` / `make verify` 依赖 build 后跑 `dist/runtime.js`。
- `make typecheck` = `build.mts --typecheck`（emitDeclarationOnly 更新服务端声明 + 三个 noEmit 检查，不改 JS）。
- `make lint` / `make format-check` 只覆盖手写源码、测试与维护配置（不含生成物、历史证据、Python/Docker 文件）；`make check` = `verify` → `lint` → `format-check`。

客户端 bundle 用 esbuild 内联 sourcemap，banner/footer 实现宿主 factory 约定，entry 导出 `inject`/`apply`（不再自行调 `load`）；用 metafile 断言 external imports 严格等于三个 seed 集合，成功后再原子写 `client.js`。开发命令、模块阅读顺序与隔离 smoke 方法见 [dsh/README](../dsh/README.md)。

---

## 3. 控制、候选与授权

### 3.1 每次真实输入先过控制

`checkControl` 在 `agent/pre-step` 的 `next()` **之前**执行，按真实 `source.kind=user` 判定；模型文本不能直接授权。控制走独立处理路由，允许一次经验证的备用路由；全部失败就**停车**，不把失败解释成「没有控制请求」。用户明确记忆请求绕过**价值筛选**，但不绕过来源、敏感授权与遗忘抑制。

### 3.2 候选：忠实还原，不预先按价值过滤

处理器从**当前 session 的真实证据**抽取候选 `CandidateDraft`（`content_kind` / `origin` / `sensitivity` / 时间字段）。候选不因「看起来没价值」而少提；纯提问、来源不明、含糊编号不造确定陈述。范围匹配的 `submit_result.source_ids` 只能列出**本次已提供的真实来源 ID**，不能把范围/请求 ID 当成来源；`fetch_context` 只公布本次核验的原生 evidence ID 枚举。

### 3.3 敏感与授权

- `ordinary` 可自主保存；`private` / `excluded` **不落队列正文**：价值判断先在内存完成，拟保存才走原生非工具确认卡（heap-only、十分钟有效、晚答不执行、进程重启即失效）。
- 授权是 `grants` 里的 typed scope：`item` / `topic` / `continuous`。范围匹配通过后，还要核验当前任务的 live root、`policy_epoch` 与遗忘 fence，**不能拿授权范围对象替代任务上下文**。
- 撤销先停止依赖它的新保存（含未发送任务），是否遗忘已有获准记忆是**另一项**确认选择。

### 3.4 未知与停车的边界

- 无法证明一段综合材料与遗忘范围无关时，**保守抑制**（`uncertain` → 不放行），不靠高置信度放宽授权。
- 旧输入被新 fence 判为不安全 → `LEPI_INPUT_RESUBMIT_REQUIRED`，要求用户**重新发起**，不偷读原正文。
- 控制失败、服务不可用或结果不明都**停车/拒绝**，不以空 guard 或假成功绕过屏障。

---

## 4. 持久化与远程任务

### 4.1 单一 SQLite 与同步事务

状态、完整 before/after 审计、不可变快照、生命周期、授权、任务与行动都在**同一个 SQLite 库**（`node:sqlite`；`journal_mode=DELETE` / `synchronous=FULL` / `foreign_keys=ON`，单写者）。**状态数值提交与审计在同一同步事务**；本地事务不跨 `await`。

- **不可变快照**：获准候选 `INSERT snapshots`，DB 触发器禁止 `UPDATE`；正文改变或纠正产生**新候选**，不复用身份改写快照。
- **稳定身份**：`candidate_id`（本地候选）、`document_id = lepi-<candidate_id>`（Hindsight 文档）、`operation_id`（固定写入工作身份，重放 payload 不变）、raw UUID（一个候选可能对应多条）。
- 未获准或最终结束的普通候选移除正文，只留必要结果/来源/版本/校验标识；未授权私密正文**从不落盘**。

### 4.2 任务、lease 与两槽并发

- 后台由**受控任务槽**推进：一个 normalize/admit 本地槽，一个交替领取 write/curate 的远端槽；网络等待不占 SQLite 事务。
- claim 用**短同步事务**：select 到期可领任务 → 标 `running` + `lease`；死 owner 回收 submitted lease 时**保留原 operation ID**。
- `TICK_MS=2000`、`BACKOFF=[1000,2000,4000]` 与可重试状态集固定；`drain` 中止本模块 controllers、清 timers 并等待 in-flight promise。

### 4.3 分阶段回执与「written」判据

服务端接受请求、`submitted`、`completed` **都不等于**已入库。只有 `units(document_id)` 全分页 + document 原文/metadata 与可用 raw 核对通过，才报 `written`。lost-ack 沿原 `operation_id` 查询，doc+raw 均证明在库才 `reconciled`，否则 `unknown`。行动成功另以 **journal** 为准（见 §6）。

状态词（面板与 API 共用）：`pending` / `deferred` / `submitted` / `running` / `written` / `reconciled` / `unknown` / `failed` / `rejected` / `cancelled` / `expired`，以及遗忘侧的 `local_isolating` / `local_isolated` / `remote_pending` / `remote_curating`。

### 4.4 诚实的边界：本地与远端不能原子提交

本地事务**不能**与远端写入原子提交。系统用**稳定身份 + 恢复记录 + 政策重新检查 + 分阶段回执**来协调：不盲目重试、失败后不偷偷换新 operation、不宣称「无限有效 exactly-once」。**取消异步任务不等于撤回已经产生的数据**；恢复连接后仍沿原 op/document 查找迟到 raw 并逐条作废。原始日志可以保留供审计，但不因此向模型重新开放；已经发给提供方的数据不能追溯撤回。

---

## 5. 召回、纠正与遗忘

### 5.1 先允许，再相关

读路径用 Hindsight 的 `recall` + `trace` 取候选，但**先过政策，再打分**：政策投影 `attribute(results, { sourceMap, store, purpose, nowMs, ... })` 先裁决 —— `current` 不采用 `superseded`/`history_only`；`forgotten`/`audit_only`/`unknown`/`pending` 从**所有模型材料**排除；active 还需来源版本当前、raw valid、授权已有保存且未遗忘。排序只在政策允许集合内进行，默认 `minSemantic=0.35`、`maxItems=4`。

- **来源证明**：只有关联到已获准快照的 origin/formation，且后端文档与 raw 仍有效、同版的材料才可用。综合观察必须逐断言核验（`verifyObservation`，每断言有来源、时间/身份未被扩大），**不能借 metadata 或 prose 升为 fact**；`trustOf` 对 unknown 返回 `unknown`。
- **安全回退**：综合文本含不允许/缺失来源时，不用它，改为正常预算内的**合格原始来源快照**；source fallback 记 `score_source='parent_observation'`，不伪装 raw 自己有 semantic 分。
- 入选材料标注 **user statement / verified action / unconfirmed inference**、日期与 current/history 用途，并写审计（不存召回正文或 embedding trace）。

### 5.2 纠正与时效

冲突走 **supersession**：旧 snapshot JSON 不变、`lifecycle=superseded`、current 停用、**保留历史**。三档信任按来源身份区分：`fact`（用户明说，不衰减）、`experience`（journal 确认已执行的行动，不衰减）、`inference`（角色推断，**14 天半衰期**，被明确否认立即停用）。未来计划绑定真实主表达的 `source.at`（不接受模型把钟面重标到另一时区）；过去日期的计划只作历史，**不自动升级为已发生**；无截止的 `temporary_state` 只作当日陈述。

### 5.3 canonical 历史隔离（遗忘）

遗忘不是删除，也不是「只让模型忽略」。确认后：**同一事务** `lifecycle=forgotten`、建立 typed `forget_scope`、`policy_epoch++`、停止相关或无法排除关联的任务、给所有 owner sessions 加 `history_work` pending。随后净化本 home 中可读会话的 **canonical surface**：被改的 user/assistant/tool 区间用 `lepimemory-redacted` notice 替换，assistant 不能作 replace 体，tool-call/result 组**配对平衡**扩大，`sourceEventSeqs` 用 canonical 顺序；system 节点 0（persona + 状态段）受保护。只有**所有可读会话隔离证明完成**才发 `local_isolated`；远端 `invalidate`/整理**另报**（`remote_curating`）。

无法证明隔离完成时**拒绝使用旧输入**（不生成模型请求），而不是只提示模型「请忽略」。原始 operator 审计仍保留，但不能绕过模型的受限取证与记忆政策。

### 5.4 恢复与重新记住

- **restore**：只把**当前 forgotten 的原记录**逐条核实后恢复为 LTM，**不重建**已净化的旧 surface。
- **re_remember**：只为本次真实新表达、经确认的新候选立例外；普通再次提及**不**解除抑制，也不复活相似旧快照。
- **revoke**：停止该范围的新保存；已有获准记忆是否遗忘是另一项选择。

> **不声称**：早期草稿提出的「实体降级（S2）」「内容重写（S3）」「硬删除（S4）」三种遗忘模式**未实现**；当前实现的是 S1 型检索抑制 + canonical surface 隔离 + 远端作废/整理 + 选择性 LTM 恢复。也不承诺「可逆复原历史」或「物理擦除远端/provider cache」。

---

## 6. 状态、行动与立绘

### 6.1 状态：存储层是数值，呈现层是情境化文本

- 维度：心境 `mood{valence, arousal}` + 关系 `relation{trust, closeness, familiarity}`；初始值即基线（`BASELINE`）。
- **模型不能直接写状态**：文本输出若构成**事件**，事件再驱动状态机。更新由**离散规则 + 回合事实**决定，规则显式声明为数据并配「为什么存在」的注释。
- **6h 半衰期**：心境偏离基线的部分按 6 小时半衰期回归（不是六小时后清零）；relation 无同样自然衰减。衰减在组装期**短事务**内按当前 clock 进行并记审计。
- **渲染分层**：`renderState` 只显示当前显著的近期 cause（中性文字 + 实际时间，不超过六小时），**不显示数值**。
- **操作者编辑**：`POST /lepimemory/state` 在已认证 operator 路由下，body **恰好**是五个数值，逐字段 `validateState` 后与完整 before/after 审计**同事务**提交，cause 固定；角色没有 HTTP 写工具。

当前自动规则（可审计、按回合事实去重结算）：

| 回合事实 | 规则影响 |
| --- | --- |
| 本轮有真正提交的用户表达 | `familiarity +0.03` |
| 本轮有账本确认的成功行动 | `valence +0.12`、`closeness +0.03` |
| 本轮有真实工具失败 | `valence -0.12`，**不降 trust** |
| 审批拒绝、取消、不可用，或一般控制错误 | 不冒充成功，也不按普通失败处罚用户关系 |

`settled_turns` + `actions.state_applied` 保证重启/重复结算不双算；迟到核验的行动由显式 reconcile 只补给已结算的真实 turn 一次。

### 6.2 行动：成功以 journal 为准

`write_note` 每次调用分配独立 `action_id`，先前登记 `prepared`（含真实 session/turn/step/call），事务外独占创建临时文件、fsync 后 `link(final)` **原子只创建**（碰撞绝不覆盖），最终文件 hash 匹配后**同一事务**改 `executed` + 完整 audit。崩溃后 `prepared` 行显式对账：hash 匹配则恢复为 executed，否则 `unknown`，**绝不重写一遍**。**绝不拿 `isError === false` 当成功。**

### 6.3 立绘：状态的一种输出

右侧栏面板与对话 dock 的立绘共享**同一份** `/lepimemory/state` 轮询源（`feed`），不出现两套 5 秒轮询。活动由共享纯规则映射为 `idle | think | speak | tool | approval | question | error`，帧/候选表以 `AvatarKey` 静态约束，预热只取每组首选帧。立绘是**状态的输出**，不是一个独立播放动画的前端组件。

> **不声称**：早期草稿设想的「disposition 慢漂移基线」「情绪门控检索排序」（情绪影响召回/主动度）、Live2D / TTS / STT **均未实现**。当前没有「情绪影响检索」这类行为。

---

## 7. 边界与验证

### 7.1 明确边界

- **单用户 / 单角色**：demo 时区 `Asia/Shanghai`；不自动导入旧 bank，不做多租户或多人权限系统。演示与验证一律用**合成 fixture**与新的 home/bank，不操作真实用户数据。
- **外部依赖**：Hindsight 与 laya 是外部服务。未配置共享连接时为 unconfigured（只读，绝不回落到默认官方端点）；服务不可达时后台任务 `deferred`、控制停车，但 core UI 与任务状态仍可用，**不静默降级为「无记忆回答」**，也不偷偷切换准入后端。

### 7.2 真实观察到的受限

- 处理模型会**保守误判/误抑制**（无法证明无关即阻断）；上游会 **HTTP 429 限流**。系统按失败/停车/resubmit 处理，**不**添加静默重试或后端降级，也不把 schema 合法或小样本跑通包装成通用可靠性。
- 结果不明一律 `unknown`，不翻译成「成功」；模型判断的质量问题**不是**已经解决的通用问题。

### 7.3 自动化与验收范围

- 当前自动化：固定 `make verify`（行为检查 + SQLite CLI smoke）、`make typecheck`、`make lint`、`make format-check`、`make check`。数字随时间推进，以执行时实际输出为准（见 [README](../README.md) 与 [DEVLOG](DEVLOG.md)）。
- 真实 Web 面上，**D0–D7** 已有实际运行证据；**D8 完整独立演示与额外后端比较按用户要求收束，未宣称整套 D0–D8 通过**。见 [DEMO](DEMO.md) 的诚实清单。

### 7.4 未实现 / 未验证（列此仅作边界，不构成承诺）

- disposition 慢漂移基线、情绪影响检索/主动度；Live2D / TTS / STT 外化。
- 「实体降级 / 内容重写 / 硬删除」（S2–S4）遗忘模式；observation 的自动级联重算作为产品能力。
- 情绪极性冲突（又亲近又防备）的表达；各层上下文的固定 token 预算。
- 「A 参与」vs「关于 A」的**自动**切分仍为「机器候选 + 用户确认」的回避式处理。
- 未测过的中文质量、概率校准与预算结论**不编造**；Lv2.5 及以上不属于本轮。

---

## 8. 决策演进与证据索引

### 8.1 被取代的机制（before → current）

| 早期机制 | 现状 |
| --- | --- |
| JSONL（`audit/recall/retain/forget/action.jsonl`）作审计真源 | 单一 SQLite；状态变更与完整审计同事务 |
| 直接编辑 `state.json` 当状态 | `state` 表 + 操作者 HTTP 路由（固定 cause、同事务审计） |
| 遗忘＝Hindsight `invalidate`（可无损 revert） | 本地抑制 fence 先行 + 远端整理另报；不承诺可逆复原 |
| observation 一律按 fact、不衰减 | 先 `verifyObservation` 才可作参考；不自动升格为事实 |
| `retain` fire-and-forget / `isError=false` 即成功 / accepted 即写入 | 唯一 `retainAsync`；`written` 需 doc+raw 核对；行动成功以 journal 为准 |
| `remember` / `forget` / `restore_memory` 三个工具 | 合并为 `manage_memory({kind, source_ids, candidate_ids})`，角色不能自行授权 |
| 自研 `OPERATION_VALIDATOR` 设想 / 正则识别「忘掉 X」 | 插件侧政策层 + 必经控制 + 模型工具调用 |
| `tool.failure.dampen` 的 `relation.trust` delta | 删除；普通工具失败只降 `valence` |
| 记忆写路径 v1（写死判断 + 直接 retain） | 理解 / 逐候选准入 / 授权 / 不可变快照 / 可核对写入管线 |
| JavaScript 源码 + 提交 `lib/` 产物 | TS/TSX 手写源码；`lib/`、`client.js`、`scripts/dist/` 生成且不提交 |
| 单体 `memory.js` 协调 | `memory` 门面 + supervisor / pipeline / authorization / task-store / candidate-store 拆分 |

### 8.2 证据索引

- **过程与坑、日期化历史**：[DEVLOG](DEVLOG.md)（含 93/93 等**当时**的里程碑记录，属历史，不代表当前数字）。
- **实测结论**：`docs/archive/dsh-findings.md`、`dsh-ui-findings.md`、`hindsight-findings.md`、`hindsight-measurements.md`。
- **原始证据**：`docs/archive/artifacts/`（召回/遗忘/写入/行动/上下文/信任档/状态面板/状态持久化/状态机/会话事件 spike/人设注入/假人格 A/B 等）。
- **面向观众与验收**：[MECHANISM](MECHANISM.md)（页面导览）、[DEMO](DEMO.md)（D0–D8 固定剧本与诚实清单）。
- **启动与开发**：[README](../README.md)、[dsh/README](../dsh/README.md)、`LOCAL_HANDOFF.md`（本机启动卡，验收不使用其中的 playground home/bank/端口）。

> archive 与 DEVLOG 条目保留**当时的**采样值、方法与源码位置，可能反映已被取代的行为；读取时以本文与当前 `PLUGIN/src` 为准。
