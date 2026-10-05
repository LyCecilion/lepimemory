# DEMO — 固定验收剧本（D0–D8）

> 目标：让你在**一条固定脚本**里看到——一个角色**忠实理解**对话、按候选判定长期价值、把获准内容写成**可核对的原始来源**，并且「记 / 忘 / 恢复 / 行动」的每条因果链都能在 **SQLite、面板、Trajectory、真实文件和 wire** 上复核。
>
> **这不是「D0–D8 已通过」的声明。** 本文给出的是本轮收敛**批准执行的固定剧本**；实际跑到哪一步、哪些是父证据、哪些仍待跑，见 §4「现状与诚实清单」。任何中间步骤都不得当成整套能力完成。真实云模型与 mutations 只有在真正跑过之后才算验证。

> **先理解，再操作**：第一次看页面或准备向观众讲解，请先读 [机制与 Demo 页面导览](MECHANISM.md)。本文负责给出验收步骤，导览负责解释这些步骤为什么存在、页面上的信号是什么意思。

全部命令在仓库根执行。默认入口**不使用系统 Node / 全局 dsh / pnpm**；不执行 `make reset` / `docker compose down -v`；旧 bank 与用户数据一律保留。

---

## 0. 运行与前提

**固定基线**：Node `24.20.0`、pnpm `10.28.2`、dsh `0.1.7-rc.2`，SQLite 单写者。

```bash
make bootstrap          # 校验并按固定 SHA 安装 Node/pnpm；已发布工件校验通过后 frozen install
make install-profile    # 由固定 Node 生成 home profile 与连接 patch（不调用全局 dsh plugin install）
```

- **共享连接**：`.env` 里 `LEPI_LLM_BASE_URL` 与 `LEPI_LLM_API_KEY` 必须**成组**填写。两项都空 = **unconfigured**：只读界面可用，**不代表可以对话**；不会回落到任何官方默认 URL，也不会放行 stock 模型。只填一项会报 `LEPI_CONNECTION_INCOMPLETE`。
- 旧 `.env` 首次加载会先保存权限 `0600` 的 `.env.legacy-<timestamp>` 再迁移；两者都不提交。
- 缺核心入口或不兼容时 `make dev` 报 `LEPI_CORE_NOT_READY`（或核心校验失败终止），**不会**用旧记忆桥接管新配置。

**用新的 home / bank 启动**（该 home 初次不存在）：

```bash
DSH_HOME=/tmp/lepimemory-demo PORT=3181 LEPI_BANK=lepimemory-demo-20261005 make dev
```

- 若该 home 已存在且**不是本轮 fixture**，改用新的 `/tmp/lepimemory-demo-<uuid>` 与对应新 bank；**不删除**旧 fixture / 旧用户数据。
- 打开 launcher 打印的**认证链接**（303 后清 token）。**不要绕过认证**直接读状态。已有、且不是 launcher 生成的同名 profile 报 `LEPI_PROFILE_CONFLICT`，请换新 home。
- 外部服务：Hindsight `0.10.0`（仅 loopback `:8888`）与 laya（loopback `:8000`）需已 loaded；**共享云连接未配置不算完整演示**。截图不得含认证 URL 或 key。

---

## 1. 先知道去哪看（可观测面）

| 面 | 看什么 | 在哪 |
| --- | --- | --- |
| **SQLite（真源）** | 状态、审计、请求、快照、生命周期、授权、任务、行动、历史工作 | `<DSH_HOME>/lepimemory/runtime.sqlite`（`journal_mode=DELETE`、`synchronous=FULL`、`foreign_keys=ON`，单写者） |
| **插件路由** | 只读 `health`；操作者 `state` / `history` / `candidate` / `retry` | `GET /lepimemory/*`（所有数据/正文动作**先**过 `connection.requestRejection`，401/403 在读取前拒绝） |
| **面板** | 状态摘要 + 渲染文本、**8 个历史标签**、操作者状态编辑、系统回执、来源链与 reveal | composer 上方状态面板 |
| **Trajectory** | **Prompt Diff**（模型实际看到什么）、工具调用、事件 | 会话页 Trajectory 标签 |
| **便条文件** | 真实落盘便条 | `<DSH_HOME>/lepimemory/notes/<action_id>.md` |
| **记忆本体** | Hindsight bank（`LEPI_BANK`，默认 `lepimemory-v2`） | Hindsight UI |

面板历史标签（最新在前、可翻页，每页默认 10）：**审计 / 召回 / 写入 / 遗忘 / 行动 / 任务 / 控制 / 确认**（对应 `kind=audit|recall|retain|forget|action|task|control|consent`）。

### 状态语义（诚实口径）

| status | 面板标签 | 含义 |
| --- | --- | --- |
| `pending` | 待处理 | 已接受、等待处理 |
| `deferred` | 待判定 | 语义等待，需显式重试或政策/模型版本变化才重评 |
| `written` | 已核实入库 | **只有** document 原文/metadata 与可用 raw 核对通过 |
| `reconciled` | 处理完成 | doc+raw 已证明在库，但操作记录不可得 |
| `unknown` | 结果不明 | 无法证明结果，暂停、不参与当前材料 |
| `failed` | 处理失败 | 处理终止失败 |
| `rejected` / `cancelled` / `expired` | 已拒绝 / 已取消 / 已过期 | 真实终态 |
| `submitted` / `running` | 已提交 / 处理中 | 在途，**不等于** written |
| `local_isolating` / `local_isolated` | 本地隔离中 / 已停止使用 | 本地抑制 fence |
| `remote_pending` / `remote_curating` | 后端清理待完成 / 后端清理中 | 远端整理，**与本地隔离分开报** |
| `audit_only` / `superseded` / `forgotten` | 仅审计 / 已被取代 / 已遗忘 | 不进入当前模型材料 |

> **不能按「工具 `isError=false`」或「async ack 已接受」显示成功。** 只有 `written`（doc+raw 核对通过）才说「已核实入库」。SQLite 导入的 legacy 记录一定显示「处理失败 / 结果不明（历史记录）」，绝不冒充成功。

---

## 2. 固定剧本 D0–D8

每步给出：**操作** → **应观察到的证据**（SQLite / UI / source / tool / file / wire）→ **诚实注意**。

### D0 — 基线就绪

**操作**：打开 launcher 链接；看面板与 `GET /lepimemory/health`。

**证据**：
- `/lepimemory/health`：`node=true`（v24.20.0）、`dsh=true`（rc2）、`schema=true`（`schema_version=1`）、`core=true`、`serviceReady=true`。
- SQLite 已建：`meta`、`state(id=1)`、`evidence`、`requests`、`snapshots`、`lifecycle`、`grants`、`tasks`、`raw_links`、`forget_scopes`、`history_work`、`actions`、`settled_turns`、`audit`。
- 共享连接缺失时：只读界面可用，控制请求被拒；**derived 连接不会发送到默认官方 endpoint**，不输出 key。

### D1 — 忠实理解候选 + 真实准入判定

**操作**：角色依次问「①喜欢安静？②这个周末有空？③接受突然来访？」，回复 `1:y,2:y,3:n`。

**证据**：
- `tasks` 出现 `normalize` → `admit`；
- 三条候选带**主语 / 时间 / 否定**与真实 source 引用；普通问候**不**变成长期有价值候选；
- 真实 **laya** verdict（`accept`/`defer`/`reject`）及其来源可见（`tasks` / `audit`）。

**注意**：模型结果需**人工核查语义**，不能靠 source 文字断言它「正确」。laya 阈值是 demo 起点，**不称校准概率**；`usage` 表示裁剪时 defer。

### D2 — 明确记住 + 跨会话读回（政策投影）

**操作**：明确说「我偏好安静、不喜欢突然来访」。回执先 `pending`，后台核实后 `written`。

**证据**：
- `snapshots`（**不可变**；`UPDATE` 被触发器拒绝）+ `lifecycle`（`pending`→`active`）；
- `raw_links`：`document_id = lepi-<candidate_id>`、`version_hash`，与 document 原文/metadata 一致；
- `audit` 记录完整身份链；receipt 只有在 doc+raw 核对通过后才说「已核实入库」。

**跨会话**：换会话问偏好 → 实际请求使用获准材料；面板能从 observation/raw 回到 candidate 与**真实 message/splice**（来源链）。

**注意**：accepted async **不等于** written；`completed` 不等于 consolidation 完成。

### D3 — 纠正 / 计划 / 临时状态（不可变快照 + supersession + 政策区分）

**操作**：明确纠正一个未来安排；再记录一个过去日期的计划，问当前安排。

**证据**：
- 纠正：旧 snapshot JSON **不变**（不可 UPDATE），`lifecycle` → `superseded`，**current 停用**；新任务状态独立。
- 计划：`valid_until` 过期 → `history_only`，`occurrence` 仍 `planned`，**不**当未来事件、**不**当已发生。
- 无明确期限的 `temporary_state` 只作**当日陈述**，不写成当前状态。
- 若 raw 变化 / 来源缺失，走 **safe fallback**（仍允许且已验证的 snapshot），**不从本地旧 body 复活**。

### D4 — 真实便条 journal + 状态操作者编辑

**操作**：同标题便条允许两次；拒绝第三次。再用面板操作者编辑改 `valence`。

**证据**：
- 两次允许 → `notes/<action_id>.md` **两个不同文件**（按 action UUID，不按 slug 去重）；正文各自保留。
- 拒绝第三次 → **无新文件**、无成功状态、无「我做过」经历。
- `actions` 表：`prepared` → `executed` / `rejected` / `cancelled` / `unavailable`，含**真实 session/turn/step/call**；工具输出精确 `{action_id,path,title,outcome,executed}` + 持久 `presentationMeta.lepimemory-action`。
- 操作者编辑：`POST /lepimemory/state` body **恰好** `{mood:{valence,arousal},relation:{trust,closeness,familiarity}}`，逐字段校验后在**同一事务**提交状态 + 完整 before/after 审计，cause 固定「操作者调整演示状态」。改完同一个会话再发一句，**实际 prompt 与回复受影响**；过期 cause 不会永久写「刚刚」。

**注意**：成功只由 **journal 确认 `executed`**，不是 `isError=false`；真实拒绝/取消/不可用**不**计工具失败，普通失败只降 `valence`、**不降 trust**。

### D5 — 私密材料：批准 vs 待定 / 私有正文

**操作**：用**虚构私密睡眠材料**明确要求记住。

**证据**：
- 确认前：SQLite / audit / 新工具参数中**没有 private body**（原始对话日志例外）；UI 显示候选卡「允许长期记住这条信息吗？」（`允许这条` / `不保存`）。
- 选择允许 → 入库（snapshot `active` + raw）；第二条拒绝 → **不落快照**。
- 用隔离 `LEPI_CONSENT_TIMEOUT_MS=1000` 证明**晚答无效**：超时 / 旧 token / 进程重启后的迟到答案永不执行，只产生 `cancelled`/`expired` 元数据。
- 撤销话题授权后新任务停住、未发送任务清理；**历史是否保留/遗忘是另一道选择卡**（默认保留已有）。

### D6 — 遗忘：本地隔离 vs 后端整理；恢复 LTM，不恢复旧 surface

**操作**：用 `FORGET_DEMO_TOKEN` 的**虚构**偏好/事件建立两个会话，再 `/compact`；选择 forget。

**证据**：
- `local_isolating` → `local_isolated`（**本地已停止使用**）；后端 `invalidate` 另外报 `backend_pending`/`remote_curating`/完成，**与本地隔离分开**。
- **当前会话、已有另一会话、以及新会话的下一实际 transport request 均无该材料**；取证（`fetch_context`/`fetch_memory`）也不给；**原始 operator 审计保留**。
- 被改的 user/assistant/tool 区间用 `lepimemory-redacted` notice 替换（配对平衡扩大，不留孤立 tool result）；被忘正文不再发给任何处理工具。

**恢复**：`restore` **只恢复 LTM raw**——逐条核实为**当前 `forgotten` 的原记录**，**不重建**已经净化的旧对话 surface；`re_remember` 只为**本次新指定内容**立例外，不复活其他旧候选。

**注意**：这是一次**不可逆的历史净化**承诺——**不要承诺「可逆复原历史」**。

### D7 — 重启对账（固定 op-ID）+ 短暂不可达

**操作**：一个合成 task 在 async ack 后**重启 dsh**；另让 Hindsight 短暂不可达。

**证据**：
- 重启后**沿原 `operation_id` 查询**（`tasks.operation_id` 不换新），不重复 POST；`unknown` 明确显示「结果不明」，**never** 显示「已写入」。
- lost-ack：doc + raw 均证明 payload 已在库 → `reconciled`（「已核实入库，操作记录不可得」）；doc 原文缺失/不匹配、raw 缺失或来源不明 → `unknown`，暂停且不参与当前材料。
- Hindsight 短暂不可达：系统仍有 UI，task `deferred`（有界退避 1s/2s/4s）；**本地已隔离的内容不会因 server 恢复或迟到 write 回流**。

### D8 — 状态 / 审计 / 回执 / 来源链 / JSON 字段

> 本轮按用户要求不继续此完整独立验收；以下保留为接口与演示说明，不代表 D8 已通过或仍在后台执行。

**操作**：查看状态、task/回执、来源链与 JSON 字段；请求一个未知 kind。

**证据**：
- `GET /lepimemory/state`：`{ok,rendered,mood,relation,updatedAt,core,status,counts}`（无正文）。
- `GET /lepimemory/history?kind=...&limit=&offset=`：8 个合法 kind；未知/构造函数 kind 返回 **400 `unknown_kind`**；limit/offset 非法 400；SQL 分页，不全量读旧 JSONL。
- `GET /lepimemory/candidate?id=<uuid>`：批准快照 / 生命周期 / 来源引用 / raw links / operations / grants；**无 heap 回退**；已遗忘默认隐藏正文，操作者用 `&reveal=1` 仅审计查看（**不恢复**）。
- `POST /lepimemory/retry`：body 固定 `{kind:'request'|'task', id:<uuid>}`；只按既有身份唤醒；ID 不存在 404，终态/禁止 409，unknown 不换新 operation；旧输入被新 forget fence 判为不安全 → `LEPI_INPUT_RESUBMIT_REQUIRED`（请重新发起，不偷读原正文）。
- 压缩后身份 / 有效状态仍进入输入。
- **准入后端**：laya 与 generative 只按这些固定样例观察。若 laya 语义不合格，在 UI/配置显式设 `LEPI_ADMISSION_BACKEND=generative` 再跑同样样例，**报告所用 backend**，**不静默切换**。

---

## 3. 审计要能回答的问题（题目口径）

| 题目问题 | 本 Demo 的落点 |
| --- | --- |
| 用了哪些上下文和记忆 | Trajectory 的 **Prompt Diff** + `GET /lepimemory/history?kind=recall` + `candidate` 来源链（obs/raw→candidate→真实 message/splice） |
| 内部状态是否变化 | `GET /lepimemory/state` + `history?kind=audit`（前值→后值 + 命中规则/固定 cause），同 SQLite 事务 |
| 调用了哪些工具、输入结果 | dsh 原生 `tool/call` + `tool/result` + `history?kind=action`（journal：`prepared/executed/...`） |
| 产生了什么语言或行为 | Chat / Trajectory（`assistant/message`） |
| 上下文如何被裁剪/压缩 | Trajectory checkpoint 消息 + 会话日志 `compaction/*` 事件 |
| **为什么这样决定** | `history?kind=control/consent/task` + `audit`（命中规则、verdict/reason_code）+ 上述来源链 |

所有审计不存 private/excluded 正文、不存 body/hash；未授权内容只留随机临时 ID 与通用状态。

---

## 4. 现状与诚实清单

**本轮已完成**（2026-10-05，`exp/runtime-convergence`）：11 项运行时实现及实际 Web D0–D7；逐步证据、真实失败及修复见 [DEVLOG](DEVLOG.md)。全部演示材料均为合成 fixture，未重置或操作个人 bank。

- D0–D5：精确启动与未配置保护、编号回答/准入、跨会话来源链、安排/时效与来源回退、真实便条及拒绝、私密材料授权/超时/撤销。
- D6：两个实际会话及原生压缩；全会话隔离后，原会话、另一会话、新会话的真实角色 HTTP 请求均无被忘材料；原始审计保留。实际选择性恢复只恢复 LTM，不复活旧 surface；重新记住只创建新指定候选。
- D7：真实异步 ACK 后重启、原 opId 查询且无第二 POST；仅测试连接短暂不可达时 UI 仍可用并 deferred；恢复后迟到可见 raw 已 invalidated/0valid。真正未获 ACK 的另一任务经原身份查询成为 unknown，UI 与回执明确“结果不明”，不报 written。恢复后实际角色 HTTP200 仍无被忘材料或 unknown 新内容。

**按用户要求收束，不继续执行的部分**：D8 的完整独立演示及额外后端比较。状态/来源/JSON/constructor400 等已有部分单点证据，但**不据此宣布 D8 完整通过，也不宣布 D0–D8 全套通过**；实现与验收范围明确分开。

**保留的真实边界**：处理模型曾保守误抑制一个新偏好；该次显示 unknown，后经原生仅新内容确认建立例外，未移除旧遗忘范围。真实 HTTP429 曾触发拒绝/需新发，未添加静默重试或后端降级。Laya 仅按已运行样例观察，阈值非校准概率；未据此推广模型稳定质量，未新增 generative 比较场景。面板写操作仅有操作者状态编辑与既有身份 retry。

---

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| 首次启动慢 / 外部服务健康检查未过 | 等一会；`docker compose logs -f hindsight`（**不要** `down -v`） |
| 端口被占用 | 换 `PORT=3181` 或其它空闲端口 |
| `LEPI_CORE_NOT_READY` / 核心校验失败 | 先 `make bootstrap` → `make install-profile`，确认固定 Node 与 rc2 依赖 |
| profile 冲突（`LEPI_PROFILE_CONFLICT`） | 换新的 `DSH_HOME`，**不要**删原 profile / 旧数据 |
| 记忆像「没生效」 | 确认共享连接成组、Hindsight `:8888` 健康；看 `history?kind=recall` 与任务状态；服务不可达时任务 `deferred`，**不是**静默降级为「无记忆回答」 |
| laya 语义不合格 | 显式设 `LEPI_ADMISSION_BACKEND=generative` 重跑同样样例并报告 backend |
| 想「从零再来」 | **不要**用 `make reset` 验证新机制；改用新的 `/tmp/lepimemory-demo-<uuid>` 与新 bank |
