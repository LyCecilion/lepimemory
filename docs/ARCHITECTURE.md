# Lepimemory 架构说明

本文记录当前实现的模块职责、数据流和设计取舍。页面怎么读见 [MECHANISM](MECHANISM.md)，怎么跑起来见 [README](../README.md) 与 [dsh/README](../dsh/README.md)，开发过程与踩坑见 [DEVLOG](DEVLOG.md)。

**这套架构要保证的事**：过去发生的事情，经过记忆与状态系统，确实改变了角色未来的判断、表达和行动；而且这条因果链能被人查证。为此它把关键事实都做成可核对的记录，而不是事后补的日志。

---

## 1. 运行时与职责边界

### 1.1 分工

| 组件 | 负责 | 不替谁决定 |
| --- | --- | --- |
| **dsh**（DeepSeek Harness `0.1.7-rc.2`） | 会话、模型调用、工具管线、审批、上下文压缩、Web 客户端 | 不决定长期记忆的授权与可用性 |
| **自研插件** `@dsh-external/dsh-lepimemory-state` | 控制、逐候选判定、授权、状态机、历史隔离、可核对写入、召回、行动、审计 | 不重写会话或模型协议 |
| **Hindsight**（`0.10.0`，REST） | 原始记忆的生命周期：document / observation / 带 trace 的检索 | 不负责人格，也不决定一条材料现在能不能用 |
| **laya**（`0.3.26`，CPU 多语言）或备选 generative | 单条候选"值不值得长期保存"的判定 | 不判对错，不判授权 |
| **SQLite**（`node:sqlite`，`schema_version=1`） | 状态、快照、生命周期、授权、任务、行动、审计的唯一数据源 | 不是"所有服务都健康"的总灯 |

两条底线：**不把人格外包给记忆服务的配置**；**不把记忆检索退化成一次性 RAG 塞进 prompt**；也不让一条流畅的综合文字自动升格为事实。

选 dsh 做骨架的理由：它把"模型看得见的内容必然被记录"当作运行时强制约束，题目要的可观测与审计几乎是结构性白得的。它的扩展点（系统提示词段、工具注册、`agent/pre-step`、审批、slot）都是可卸载的插件机制，不需要 fork。

### 1.2 服务端模块（`PLUGIN/src`，`PLUGIN` = `dsh/plugins/dsh-lepimemory-state`）

内部 import 带显式 `.ts`/`.tsx` 后缀，`tsc` 输出时改写为 `.js`。

**入口与配置**

- `src/index.ts` — 组装：`openStore` → evidence → processor → admission → history → control/memory/action/state/panel；注册完 hook 才启动 `memory`。唯一运行入口。
- `src/config.ts` — 解析 `LEPI_*` 环境变量（唯一配置来源，不写回用户文件），含 `expandHome` 与旧 `.env` 的一次性迁移。

**持久化**

- `src/store.ts` — SQLite 连接、事务、审计、不可变快照、owner/epoch。schema 和 CHECK 约束的唯一所有者。
- `src/task-store.ts` / `src/candidate-store.ts` — task / candidate 行的具名 SQL 操作。它们不自己开事务，由调用方放进原有业务事务。
- `src/json.ts` — `parseJson`（按 fallback 区分数组/对象/null）。

**证据与契约**

- `src/evidence.ts` — 中性证据索引（用 `session_id:seq:block_index` 引用消息，不存正文）+ `turnWindow` 只读窗口查询。
- `src/processor.ts` / `src/contracts.ts` — 受限的处理模型契约与 `submit_result` 校验（允许一次结构修复）。
- `src/raw-source.ts` / `src/recall-source.ts` — raw 与 document 的来源核验、组装。

**控制与记忆协调**

- `src/control.ts` — 必经的 `agent/pre-step` 控制、单一 `manage_memory` 工具、原生确认卡（`ctx.userQuestions`）。
- `src/memory.ts` — 记忆子系统的门面：构造 stores → authorizer → pipeline → workers → supervisor。构造函数不查库、不起定时器、不注册 hook，对外只暴露 enqueue/afterTurn/start/wake/retry/health/dispose/recall/readMemory。
- `src/memory-supervisor.ts` — 唯一的定时 tick / 任务槽 / lease 拥有者。它不 import pipeline，保证依赖图无环。
- `src/memory-pipeline.ts` — normalize / admit 作业（价值判定、有界准入、普通/私密分流、授权交接）。不含 SQL。
- `src/memory-authorization.ts` — 政策读取（grants / forget_scopes / requests / history_work 屏障）、候选政策核验、单项授权核验、原子提交的外层事务。
- `src/memory-common.ts` — 共享纯导出（`BACKOFF`、错误码、`identityOf`、公共类型）。
- `src/admission.ts` — 逐候选价值判定，`laya` 或 `generative` 显式二选一，运行时不自动切换。
- `src/write-worker.ts` / `src/curate-worker.ts` — 可核对的 Hindsight 写入与远端整理。

**状态、行动与界面**

- `src/state-runtime.ts` / `src/machine.ts` — 回合结算（数据化规则、6h 心境衰减、状态审计）与组装期的短事务衰减。
- `src/trust.ts` — 信任档与召回政策筛选（先政策，再打分）。
- `src/recall.ts` — 读路径的召回筛选与审计。
- `src/history.ts` — 有效历史的隔离与恢复（复用 `Session.append` + `sessionQuery`，不新增 dsh 事件类型）。
- `src/action.ts` — `write_note` 真实落盘（`<dataRoot>/notes/<action_id>.md`，只创建不覆盖 + 审计 + journal）。
- `src/panel.ts` — 操作者 HTTP 路由（先鉴权，401/403 在读取任何数据前返回）。
- `src/hindsight.ts` — Hindsight REST 客户端（retainAsync / operation / document / units / cancel / recall）。

**浏览器安全的共享定义（`src/shared`，不含 `node:` 依赖）**

- `src/shared/domain.ts` — 领域词汇：Candidate / EvidenceRef / 任务与生命周期 / verdict / purpose 等 union，成员只来自既有契约字面量与 SQLite CHECK。
- `src/shared/api.ts` — 面板 HTTP DTO 的形状与取值域。
- `src/shared/state.ts` — 状态的纯定义/校验/渲染（`BASELINE`、`NUMERIC_FIELDS`、`validateState`、`renderState`）。
- `src/shared/activity.ts` — 活动判定纯规则：工具 > 说话 > 思考；审批/提问优先；错误/待机兜底。
- `src/shared/avatar-assets.ts` / `src/shared/avatar-frames.ts` — 立绘素材表与帧表（`AvatarKey` 静态约束）。
- `src/shared/pins.ts` — 固定版本常量（Node `v24.20.0` / pnpm `10.28.2` / dsh `0.1.7-rc.2`）。

### 1.3 客户端模块（`PLUGIN/src/client`，浏览器 TSX）

- `src/client/index.tsx` — 浏览器入口：经宿主 `window.__ModuleLoader__.load({ id, factory })` 以 lazy-CJS 装载，只导出 `inject = ['slots','locale','sidebarRightTabs']` 与 `apply`。`require` 只能取平台提供的三个 seed（`react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`）。
- `src/client/components/*.tsx` — `Panel`、`StateStrip`、`Badges`、`HistoryBlock`、`HistoryRows`、`CandidateDetail`、`RecallDetail`、`EditorForm`、`AvatarOverlay`、`atoms`。组件只接 props，不做 fetch、不开定时器、不知道数据库。
- `src/client/{hooks,feed,status,history-model,util,constants,locales,types}.ts` + `panel.css` — hooks 组合、共享状态轮询源（`feed`）、状态标签、历史模型、请求工具与文案。

TSX 用 React namespace import（`jsx: 'transform'` + `React.createElement`），不生成 jsx-runtime 依赖；打包 external 严格限定在三个 seed 内。

---

## 2. 源码、产物与构建

### 2.1 目录约定

```text
PLUGIN/
  src/*.ts                     服务端手写源码
  src/shared/*.ts               浏览器安全的共享定义
  src/client/**/*.ts(x)         浏览器手写源码
  src/client/panel.css          样式原文（构建时以文本内联）
  src/client/tsconfig.json      浏览器 noEmit 检查
  tsconfig.json                 服务端输出配置（rootDir=src → outDir=lib）
  lib/**                        生成物：ESM JS / d.ts / maps
  client.js (+ .map)            生成物：宿主 lazy-CJS 客户端
  test/*.test.js                行为测试（node:test，保持 JS）
scripts/
  build.mts                     可擦除类型的构建入口
  src/runtime.ts                固定运行时 / profile 生成 / dev / verify
  src/verify-runtime.ts         行为测试 + SQLite smoke
  dist/**                       生成物
  tsconfig.json · tsconfig.tools.json
```

### 2.2 生成物政策

`lib/`、`client.js`、`scripts/dist/` 都是生成物：不提交、不手工维护（`.gitignore` 精确忽略）。全新 clone 走"固定安装 → 构建"生成运行产物。完整 build 在输出前只清理生成区，不删除 assets、test、src、profile 或数据。运行时只引用生成物（package `main=./lib/index.js`、`exports["./client"]=./client.js`）。

### 2.3 固定工具链与单向依赖

- 根工作区锁定 Node **24.20.0**、pnpm **10.28.2**、dsh **0.1.7-rc.2**；devDependencies 精确固定（TypeScript 5.9.3、esbuild 0.25.12、prettier 3.6.2、eslint 10.12.0、typescript-eslint 8.71.1 等）。入口不使用系统 Node / 全局 dsh / pnpm / npx；安装统一 `--frozen-lockfile`。
- `tsconfig.base.json` 是 strict 基线（`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`noEmitOnError` 等）；服务端 rootDir=`src` → outDir=`lib`（declaration + map），客户端 `noEmit` + DOM + 经典 JSX，`scripts` 输出 `dist`。
- 依赖方向单向：`client → shared`、`server → shared`、`shared` 无 `node:` 依赖；`memory-pipeline` 不 import `memory-supervisor`；`memory.ts` 是记忆模块的唯一门面。类型只从已安装声明 `import type`，不产生运行时依赖。

### 2.4 构建与检查入口

完整 build 顺序固定：校验 Node/pnpm → 需要时 frozen install → 服务端 tsc → scripts tsc → client/tools noEmit → 客户端 esbuild 打包 → 退出 0。任一步失败就非零退出，`make dev` 不回退旧产物或系统 Node。

- `make build` = `node scripts/build.mts`；`make install-profile` = `build.mts --install` + `dist/runtime.js install`；`make dev` / `make verify` 在 build 后跑 `dist/runtime.js`。
- `make typecheck` = `build.mts --typecheck`（emitDeclarationOnly + 三个 noEmit 检查，不改 JS）。
- `make lint` / `make format-check` 只覆盖手写源码、测试与维护配置；`make check` = `verify` → `lint` → `format-check`。

客户端 bundle 用 esbuild 内联 sourcemap，banner/footer 实现宿主 factory 约定，entry 导出 `inject`/`apply`；用 metafile 断言 external imports 严格等于三个 seed，成功后原子写 `client.js`。

---

## 3. 控制、候选与授权

### 3.1 每次真实输入先过控制

`checkControl` 在 `agent/pre-step` 调 `next()` 之前执行，只认真实 `source.kind=user` 的输入。控制意图走独立的处理路由，允许一次经验证的备用路由；全部失败就停车，绝不把失败解释成"没有控制请求"。用户明确的记忆请求跳过**价值判定**，但跳不过来源核验、敏感授权与遗忘抑制。

### 3.2 候选：忠实还原，不预先按价值过滤

处理模型从当前会话的真实证据里抽取候选（`content_kind` / `origin` / `sensitivity` / 时间字段）。候选不因为"看起来没价值"就少提；纯提问、来源不明、含糊的编号不编造成确定陈述。范围匹配的 `source_ids` 只能引用本次提供的真实来源 ID，不能把范围 ID 当来源用。

### 3.3 敏感内容与授权

- `ordinary` 可自主保存；`private` / `excluded` 的正文不进任何队列——价值判定先在内存完成，确定要保存才弹原生非工具确认卡（只在内存、十分钟有效、晚答不执行、重启即失效）。
- 授权是 `grants` 里的类型化范围：`item` / `topic` / `continuous`。范围匹配通过后还要核验当前任务的 live root、`policy_epoch` 与遗忘屏障，不能拿授权范围对象替代任务上下文。
- 撤销授权先停止依赖它的新保存（含未发送的任务）；已保存的获准记忆是否一并遗忘，是另一项确认选择。

### 3.4 未知与停车的边界

- 无法证明一段综合材料与遗忘范围无关时保守抑制（`uncertain` 即不放行），不靠"置信度高"放宽授权。
- 旧输入被新的隔离屏障判为不安全时返回 `LEPI_INPUT_RESUBMIT_REQUIRED`，要求用户重新发起，不偷读原正文。
- 控制失败、服务不可用、结果不明都停车或拒绝，不用空 guard 或假成功绕过屏障。

---

## 4. 持久化与远程任务

### 4.1 单一 SQLite 与同步事务

状态、完整前后值审计、不可变快照、生命周期、授权、任务、行动都在同一个 SQLite 库（`journal_mode=DELETE` / `synchronous=FULL` / `foreign_keys=ON`，单写者）。状态数值与审计在同一同步事务提交；事务不跨 `await`（`Store.transaction` 运行时强制同步、拒绝嵌套 savepoint、拒绝 async）。

- **不可变快照**：获准内容 `INSERT` 进 `snapshots`，数据库触发器禁止 `UPDATE`。内容变化或纠正产生新候选，不改写旧快照。
- **稳定身份**：`candidate_id`（本地候选）、`document_id = lepi-<candidate_id>`（Hindsight 文档）、`operation_id`（一次写入工作的固定身份，重试重放同一 payload）、raw UUID（一个候选可能对应多条）。
- 未获准或最终结束的普通候选会移除正文，只留结果/来源/版本标识；未授权的私密正文从不落盘。

### 4.2 任务、lease 与两个任务槽

- 后台由受控任务槽推进：一个本地槽做 normalize/admit，一个远端槽交替领取 write/curate。网络等待不占数据库事务。
- 领取任务用短同步事务：找到期任务 → 标 `running` + lease；死掉的 owner 的 lease 被回收时保留原 `operation_id`。
- `TICK_MS=2000`、`BACKOFF=[1000,2000,4000]` 与可重试状态集固定；`drain` 中止本模块的控制器、清定时器并等待在途 promise。

### 4.3 分阶段回执与 `written` 的判据

服务端接受请求、`submitted`、`completed` 都不等于已入库。只有把 `units(document_id)` 全分页查完、且 document 原文/metadata 与可用 raw 核对通过，才报 `written`。丢失回执时沿原 `operation_id` 查询：doc+raw 都证明在库才 `reconciled`，否则 `unknown`。行动成功另以 journal 为准（见 §6）。

状态词（面板与 API 共用）：`pending` / `deferred` / `submitted` / `running` / `written` / `reconciled` / `unknown` / `failed` / `rejected` / `cancelled` / `expired`，以及遗忘侧的 `local_isolating` / `local_isolated` / `remote_pending` / `remote_curating`。

### 4.4 诚实的边界：本地与远端无法原子提交

本地事务和远端写入不可能一起提交。系统用**稳定身份 + 恢复记录 + 政策复查 + 分阶段回执**来协调：不盲目重试，失败后不偷偷换新 operation，不声称 exactly-once。**取消异步任务不等于撤回已经产生的数据**；恢复连接后仍沿原操作身份查找迟到的 raw 并逐条作废。原始日志保留供审计，但不因此向模型重新开放；已发给提供方的数据无法追溯撤回。

---

## 5. 召回、纠正与遗忘

### 5.1 先允许，再相关

读路径用 Hindsight 的 `recall` + `trace` 取候选，但**先过政策，再打分**：`attribute(results, { sourceMap, store, purpose, nowMs, ... })` 先裁决——`current` 不采用 `superseded`/`history_only`；`forgotten`/`audit_only`/`unknown`/`pending` 从所有模型材料中排除；`active` 还要求来源版本当前、raw 有效、授权仍在且未被遗忘。排序只在政策允许的集合内进行，默认 `minSemantic=0.35`、`maxItems=4`。

- **来源证明**：只有关联到已获准快照、且后端文档与 raw 仍有效同版的材料才可用。综合观察必须逐断言核验（`verifyObservation`：每条断言有来源，时间/身份不被扩大），不能借 metadata 或流畅文字升格为 fact；`trustOf` 对 unknown 返回 `unknown`。
- **安全回退**：综合文本含有不允许或缺失的来源时不用它，改为预算内的合格原始来源快照；回退记 `score_source='parent_observation'`，不伪装 raw 自己有语义分。
- 入选材料标注 user statement / verified action / unconfirmed inference、日期与用途，并写审计（不存召回正文或 embedding trace）。

### 5.2 纠正与时效

冲突走 supersession：旧快照 JSON 不变、`lifecycle=superseded`、current 停用、历史保留。三档信任按来源身份区分：`fact`（用户明说，不衰减）、`experience`（journal 确认已执行的行动，不衰减）、`inference`（角色推断，**14 天半衰期**，被明确否认立即停用）。未来计划绑定真实表达的 `source.at`（不接受模型把时间改标到别的时区）；过去日期的计划只作历史，不自动变成"已发生"；无截止的 `temporary_state` 只作当日陈述。

### 5.3 遗忘：有效历史隔离

遗忘不是删除，也不是"让模型忽略"。确认后在同一事务里：`lifecycle=forgotten`、建立类型化的 `forget_scope`、`policy_epoch` 加一、停止相关或无法排除关联的任务、给所有 owner 会话加 `history_work` pending。然后净化本机所有可读会话的**有效历史**（模型当前获准阅读的对话历史）：被改的 user/assistant/tool 区间换成 `lepimemory-redacted` 提示，tool-call/result 成对平衡扩大，`sourceEventSeqs` 按有效历史顺序；系统节点 0（人设 + 状态段）受保护。只有所有可读会话都拿出隔离证明，才报 `local_isolated`；远端作废/整理另行报告（`remote_curating`）。

无法证明隔离完成时直接拒绝使用旧输入（不生成模型请求），而不是提示模型"请忽略"。原始审计保留，但不能绕过模型的受限取证与记忆政策。

### 5.4 恢复、重新记住、撤销

- **restore**：只把当前 forgotten 的原记录逐条核实后恢复为长期记忆，不重建已净化的旧历史。
- **re_remember**：只为本次真实新表达、经确认的新候选建立例外；普通再次提及不解除抑制，也不复活相似的旧快照。
- **revoke**：停止该范围的新保存；已有记忆是否遗忘是另一项选择。

早期草稿设想的"实体降级 / 内容重写 / 硬删除"（S2–S4）遗忘模式没有实现；当前是检索抑制 + 有效历史隔离 + 远端作废/整理 + 选择性恢复。也不承诺可逆复原历史或物理擦除远端缓存。

---

## 6. 状态、行动与立绘

### 6.1 状态：存储是数值，呈现是情境文本

- 维度：心境 `mood{valence, arousal}` + 关系 `relation{trust, closeness, familiarity}`；初始值即基线（`BASELINE`）。
- **模型不能直接写状态**：文本输出若构成事件，事件再驱动状态机。更新由显式声明为数据的离散规则 + 回合事实决定，每条规则带"为什么存在"的注释。
- **6h 半衰期**：心境偏离基线的部分按 6 小时半衰期回归（不是六小时后清零）；关系参数没有自然衰减。衰减在组装期的短事务内按当前时钟进行并记审计。
- **渲染分层**：`renderState` 只显示当前显著的近期原因（中性文字 + 实际时间，不超过六小时），不显示数值。
- **操作者编辑**：`POST /lepimemory/state` 在已认证的操作者路由下，body 恰好是五个数值，逐字段 `validateState` 后与完整前后值审计同事务提交。角色没有任何 HTTP 写工具。

当前自动规则（可审计，按回合事实去重结算）：

| 回合事实 | 状态变化 |
| --- | --- |
| 本轮有真正提交的用户表达 | `familiarity +0.03` |
| 本轮有记录确认的成功行动 | `valence +0.12`、`closeness +0.03` |
| 本轮有真实工具失败 | `valence -0.12`，不降 `trust` |
| 审批拒绝、取消、不可用，或一般控制错误 | 不算成功，也不当作普通失败惩罚用户关系 |

`settled_turns` + `actions.state_applied` 保证重启/重复结算不双算；迟到核验的行动由显式 reconcile 只补给已结算的真实 turn 一次。

### 6.2 行动：成功以 journal 为准

`write_note` 每次调用分配独立 `action_id`，先登记 `prepared`（含真实 session/turn/step/call），事务外独占创建临时文件、fsync 后 `link(final)` **只创建不覆盖**（碰撞绝不覆盖），最终文件 hash 匹配后在同一事务改 `executed` + 完整审计。崩溃后 `prepared` 行显式对账：hash 匹配恢复为 executed，否则 `unknown`，绝不重写一遍。绝不拿 `isError === false` 当成功。

### 6.3 立绘：状态的一种输出

右侧栏面板与对话 dock 的立绘共享同一份 `/lepimemory/state` 轮询源（`feed`），不出现两套 5 秒轮询。活动由共享纯规则映射为 `idle | think | speak | tool | approval | question | error`，帧表以 `AvatarKey` 静态约束，预热只取每组首选帧。立绘是状态的输出，不是独立播放动画的前端组件。

早期草稿设想的"性格慢漂移基线""情绪影响检索/主动性"以及 Live2D / TTS / STT 均未实现；当前没有"情绪影响检索"这类行为。

---

## 7. 边界与已知限制

- **单用户、单角色**：时区 `Asia/Shanghai`；不自动导入旧 bank，没有多租户或多人权限。验证一律用合成 fixture 和新的 home/bank，不操作真实用户数据。
- **外部依赖**：Hindsight 与 laya 是外部服务。未配置共享连接时为 `unconfigured`（只读，绝不回落到默认官方端点）；服务不可达时后台任务 `deferred`、控制停车，但界面与任务状态仍可用，不静默降级成"无记忆回答"，也不偷偷切换判定后端。
- **模型判断有已知的保守误判**：无法证明无关就阻断，实测观察到过误抑制；上游会 HTTP 429 限流。系统按失败/停车/重发处理，不加静默重试，不把小样本跑通包装成通用可靠性。结果不明一律 `unknown`，不翻译成"成功"。
- **未实现**：性格慢漂移、情绪影响检索/主动性、Live2D / TTS / STT、S2–S4 遗忘模式、observation 自动级联重算、情绪极性冲突的表达、各层上下文的固定 token 预算。
- "A 参与"与"关于 A"的自动区分仍是"机器候选 + 用户确认"的处理方式。
- 阈值与概率未做校准；中文质量没有系统评测。Lv2.5（世界线）及更高难度不在当前范围。
