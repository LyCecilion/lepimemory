# 开发日志 — 蝶忆 Lepimemory

> 用途：**过程与踩坑的诚实记录**。给未来的自己、以及想了解「我们如何定义问题、在哪里栽过跟头」的人。
> 分工：结论进 `docs/ARCHITECTURE.md` / `docs/research/*-findings.md`；原始证据进 `docs/research/artifacts/`；**本文记「怎么走过来的」与「坑」**。
> ⚠️ 下文中出现的 `CONCEPTS.md` / `DESIGN_NOTES.md` / `PLAN.md` / `HANDOFF.md` 均为**过程文件的历史名称**：这些中间草稿现已移除，有效结论并入 `docs/ARCHITECTURE.md`；此处保留原文件名只为忠实记录事件。

---

## 0. 怎么读

- 想看**能力现状** → `README.md` + `dsh/README.md` + `docs/DEMO.md`
- 想看**架构决策与理由** → `docs/ARCHITECTURE.md`（唯一的现行架构说明）
- 想看**实测结论** → `docs/research/dsh-findings.md` / `hindsight-findings.md` + `artifacts/`
- 想看**过程与坑** → **本文**

---

## 1. 时间线

### Phase 0–2（前情，摘要）
架构决策（三项核心：dsh 当骨架 / Hindsight 当记忆微服务 / 状态机自研）、Hindsight 接入与中文修复（换多语言模型）、dsh 侧「状态注入→语气变化」可行性验证。
详见 `docs/ARCHITECTURE.md`、`docs/research/*-findings.md`。

### Phase 3（本阶段详录；`exp/state-persistence` → `develop`）

> 全程用 `exp/` 分支起步；2026-10-03 起收尾改在 **`develop`**（从 `main` 分出并并入 `exp/state-persistence`）。提交带 gitmoji 的 conventional commit；每条改动都留 `docs/research/artifacts/` 证据。

| # | 提交 | 事项 |
| --- | --- | --- |
| 1 | `e480956` | **状态持久化**：插件改读 `<DSH_HOME>/lepimemory/state.json`，每轮组装实时渲染；坏文件报错含字段路径。证据 `state-persistence.md` |
| 2 | `619f062`/`931b4d3`/`4dee88d` | 文档勘误：fresh-home 的 link 坑、logger 行「代码会发≠实测打出」 |
| 3 | `a0104cc` | **事件接入 spike**：实测 out-of-tree 插件**不能**追加自定义会话事件（重载整档拒绝）→ 改写审计落点 |
| 4 | `5e0657d` | **状态机 v1**：`session/event` 结构事件→数据化规则→`state.json` + `audit.jsonl`；心境 6h 半衰期衰减。证据 `state-machine.md` |
| 5 | `67e3378` | **正式人设注入**：preset persona 行换正式文本，治「coding-agent 口吻泄漏」。证据 `persona-injection.md` |
| 6 | `ba907b0` | 写路径**定死**：冷路径 `sessionPersistence.open(id,'write')` 亦被单写者拒 |
| 7 | `9fcb006` | 文档收口（README/findings/HANDOFF） |
| 8 | `decf7a3` | **记忆召回竖切**：`agent/pre-step` → Hindsight `recall(trace)` → 归因 → 注入 `form:'recall'`；退避+降级。证据 `memory-recall.md` |
| 9 | `ce8b4af` | 召回证据收口：查清 headless 污染、kind 安全性、注释矛盾 |
| 10 | `b333270` | **记忆写路径 v1**：对话→`retain`（concise + `trust:fact`）。证据 `memory-write.md` |
| 11 | `7d43dd6` | 修：retain 非幂等**不重试**；证据按**实收工具清单**表述 |
| 12 | `a110e1d` | **`DEMO.md` 定稿**：5 步剧本 + 三个可观测面 + 诚实未实现清单 |
| 13 | `0f25627` | 修：**过度写入**（疑问/请求句被 retain）→ 排除 + 去重 |
| 14 | `ece201d` | **遗忘 v1**：计划预览 → 确认 → `invalidate`（可撤销，只切相关）。证据 `memory-forget.md` |
| 15 | `7952eb5` | `DEMO.md` 步骤 E 改口「遗忘可演示」 |
| 16 | （本会话） | **遗忘工具化**：正则 → **`forget` + `restore_memory` 工具 + `ctx.approval`**（含 schema 两坑、工具可见性实测）；证据 `memory-forget.md` |
| 17 | （本会话，`develop`） | **行动工具 `write_note`**：真实落盘 + 审批 + experience 写路径 + 失败进状态；证据 `action-tool.md` |
| 18 | （本会话，`develop`） | **规则定稿三条 + 量级标定**：单次行动成功/失败跨渲染阈值（一轮可见）；证据 `state-machine.md` |
| 19 | （本会话，`develop`） | **遗忘子集**：`forget` 两段式（缺省只返回候选计划 → 带 `ids` 才审批执行）；证据 `memory-forget.md` |
| 20 | （本会话，`develop`） | **状态面板**：`lib/panel.js` 路由 + `client.js` 面板 + `package.json` `dsh.client`；**+ `/lepimemory/history` 历史分页（审计/召回/写入/遗忘/行动，可翻页）**；证据 `state-panel.md` |
| 21 | （本会话，`develop`） | **模型端点切 geek-tech-club**（本机常驻 profile；仓库草稿保持 opt-in，见 §2.2 #19）；`develop` 分支建立（`main` 并入 `exp/state-persistence`） |

### Phase 4（补齐 Lv1/Lv2 剩余缺口；`develop`）

| # | 提交 | 事项 |
| --- | --- | --- |
| 22 | （本会话） | **上下文管理（Lv1）**：启用 dsh `compaction-basic` + `tool-result-pruner` + `command-compact`（preset 的 `isolate` realm）。推翻旧稿「compaction 暂禁」的顾虑。证据 `context-management.md`（含**自动**与**手动 `/compact`** 两条路径实测） |
| 23 | （本会话） | **记忆更新/冲突（Lv2）**：recall 带 `prefer_observations`（冲突**取最新**＝Hindsight observation supersede）；`recall.jsonl` 记 `type`/`trust`/`superseded`。证据 `memory-update-trust.md` |
| 24 | （本会话） | **三档信任 + 差异化衰减（Lv2）**：`lib/trust.js`（fact/experience/**inference 半衰期 14 天**）+ `metadata.trust` + **`remember` 工具**（角色主动记推断）。证据 `memory-update-trust.md` |

---

## 2. 踩坑台账（可复用）

> 每条：**现象 → 根因 → 处置**。带 `[已修]`/`[已规避]`/`[未决]`。

### 2.1 交付红线类
1. **`.gitignore` 吞掉插件源码** `[已修]`
   现象：插件 `lib/index.js` 未进仓库（untracked+ignored），克隆后 `make dev` 崩。
   根因：toptal 模板第 168 行 `lib/` **无前导斜杠**，匹配任意层级。
   处置：收窄为 `/lib/` + `!dsh/plugins/**/lib/`。
2. **`make dev` 没传 `DSH_HOME`** `[已修]`
   现象：本机因 `~/.dsh/profiles/lepimemory` 碰巧存在而掩盖；换机即 `profile does not exist`。
   根因：`DSH_HOME ?=` 只是 make 变量、未 `export`。  处置：`export DSH_HOME`。
3. **全新 home 的「相对 link」坑** `[已修/已记录]`
   现象：`DSH_HOME=/tmp/…` 时插件静默缺席（cordis 对解析不到的模块只走 logger、不崩）。
   根因：仓库版 profile 用相对 `link:../../../dsh/plugins/…`，只在 `DSH_HOME=<repo>/.dsh` 成立。
   处置：外部 home 用**绝对 link**；已写进 HANDOFF 验收配方。

### 2.2 dsh 机制类（详见 `dsh-findings.md`）
4. **stock bundle 无 console exporter** `[已记录]`
   现象：插件 `ctx.logger.error` 在 web stdout 看不到。
   根因：bundle 未挂 `logger-console`；仅 app-boot 的 diagnostics exporter 收启动期 warn/error。
   处置：审计改走**自有持久化**（`*.jsonl`）。
5. **out-of-tree 不能追加自定义会话事件** `[已规避]`（Phase 3 的**头号未知**，被 spike 推翻）
   现象：`agent.session.append('persona/state-diff', data)` 成功，但重启重开会话 → `refusing to interpret the log`。
   根因：读侧按仓库内**静态白名单** `KNOWN_SESSION_EVENT_TYPES` 准入；写侧 `Session.append()` **无 `ignorable` 透传**。冷路径 `sessionPersistence.open(id,'write')` 的 `SessionHandle.append` 虽能传完整事件，但 seam **单写者**、活会话写句柄被 agent-loop 持有（实测 `SessionAlreadyOwnedError`）。
   处置：**不加事件**；审计落插件自有 `*.jsonl`；「效果」靠已落的 `system/message` Prompt Diff。
6. **pre-step 每步都触发** `[已规避]`
   现象：一次工具调用＝多步，天真实现会在每步重复注入召回。
   处置：仅当本轮**真·用户输入非空** + 每 turn 一次（`injectedTurns`），等价 `step===1`。
7. **host 注册的工具「其实」会到每个 agent** `[已证]`
   曾误判：以为 bundle（host 面）注册的工具进不了 preset 会话。
   **实测推翻**：工具注册表是「全局层 + per-scope 层」**合并**，runtime 在根上下文 `ctx.tools.register` 的工具**会到达每个 agent**（本轮 `forget` 出现在会话 `request/header.tools` 即证）；之前会话没有 `tool-bash/fs`，是 web bundle 把那些**行 `disabled`** 了，不是 preset 挡的。
   ⚠️ 教训：`--dump-config` 里「有某行」≠「会话能用它」——dump 只是「已注册」，会话能力面由 preset + disabled 共同决定。
16. **`tool/result` 的 `isError`/`toolCallId` 在 message 顶层（会话格式 V4）** `[已核对]`
    现象：想按 `isError`/`toolCallId` 关联 call/result，先从磁盘 `session.jsonl.zstd` 读到 `message.content[].{type:'tool-result',…}` 的**嵌套**形状，差点照此实现。
    根因：磁盘文件**有版本**——`session.jsonl.zstd` 可能是旧 **V2** 遗留（tool 结果 wrap 成 user 消息）；当前格式是 **V4**（first-class tool-role 消息，`toolCallId`/`isError` 在 **message 顶层**），另有 v2→v3→v4 迁移包（`@deepseek-ai/dsh-session-format-*`）。安装版 `@deepseek-ai/dsh-llm` 的 `ToolResultMessage` d.ts 亦证。
    处置：`toolResultInfo(message)` 读**顶层**；核对一律用 `session.v4.jsonl.zstd` 或源码类型。
17. **工具结果只有 `output.render` 是模型可见的** `[已修]`
    现象：`forget` 两段式第一段要把候选 `ids` 交给模型回传，但初版 `render` 只渲染文本 → 模型**拿不到 id**，第二段无法发起（文案还写「ids 见结果」，实则没给）。
    根因：`output.render(args,value)` 产出**模型可见 content**；工具返回的 `value`（含 ids）默认不给模型（`value` 只过 schema 校验）。
    处置：**模型要用的字段必须写进 `render`**（plan 分支逐条渲染 `[id] 文本`）。
18. **`webServer` 在插件 `apply` 时通常未就绪** `[已修]`
    现象：插件里 `ctx.get('webServer')` 为 `undefined` → 面板路由静默不注册（`GET /lepimemory/state` → 404）。
    根因：cordis 服务由别的插件提供；本插件 `apply` 时 web 栈可能还没挂上，`ctx.get` 是**即时**读取（不是响应式等待）。
    处置：用 **`ctx.inject(['webServer'], scope => …)`** 延迟到服务可用再 `scope.effect(() => server.register(…))`。
19. **把个人端点默认写进仓库草稿** `[已修]`
    现象：仓库 profile 草稿把默认模型**默认启用**到 `geek-tech-club`，但该 provider 的 `baseURL` 回落官方端点 → 全新 clone 只填 `GEEK_TECH_CLUB_API_KEY`、没填 `LEPI_LLM_BASE_URL` 时，**GEEK 的 key 被发到官方端点**，默认模型直接坏。
    根因：端点地址属个人资产（`.sanitize-patterns` **禁入库**），仓库里给不出正确默认；`PatchOptions.disabled` 是 `boolean|null`，**不支持 `!!js` 条件**，做不成「有 env 才启用」。
    处置：**仓库草稿保持 opt-in（默认注释、不启用）**；个人端点只落在**本机**——且放**不被 `install-profile` 覆盖的 `--patch` 层**（`~/.dsh/lepimemory-machine.patch.yml`，启动加 `--patch`），而非可被 `cp -Rf` 覆盖的 `~/.dsh/profiles/lepimemory/cordis.patch.yml`。已核对 `.env.example`「留空→回落官方端点」的既有语义不变。

### 2.3 记忆服务（Hindsight）类
8. **retain 的 3s 预算 → 假报 degraded** `[已修]`
   现象：`retain.jsonl` 记 `degraded: timeout`，但 bank 其实写成功了。
   根因：client 默认 `deadlineMs 3000` 对 retain 的 LLM 抽取太短。
   处置：**预算分开**——recall 前台 3s（超时降级）；retain 后台 30s。
9. **retain 非幂等 → 别重试** `[已修]`
   现象风险：网络错重试会造成**重复记忆**。
   处置：`retain` 走 `maxRetries:0`；recall（幂等读）才退避重试。

### 2.4 意图/判断启发式类
10. **过度写入：把「提问」当内容 retain** `[已修]`（实测复现）
    现象：`retain.jsonl` 写了「我下周要见谁来着？提醒我一下。」→ Hindsight 抽出近重复事实，recall 候选膨胀（8→picked 4 近重复）。
    处置：层① `writeSkipReason` 扩为「长度/疑问/请求/寒暄」排除 + **去重**（10/10 用例）。
11. **遗忘用正则识别意图/确认（hacky）** `[已修：改为工具]`
    现象：正则会把「我永远不会忘记你」「别忘记我们的约定」当**遗忘请求**；也会把「嗯……对了」当**确认** → 可能误删。
    处置：改为注册 **`forget` 工具**（**模型调用**，意图判定交给 LLM）+ **`ctx.approval`** 结构化确认（fail-closed、审计成对）——**两类误判从根上消失**。
    工具化过程另踩两个 schema 坑（已修）：`output.schema` 的 `required` 必须**对象级数组**（leaf 逐属性 `required:true` 被拒）；`parameters` 必须**显式 object 节点**（裸属性表被 provider 判 `type: null`）。

### 2.5 验证环境/工具类
13. **headless 环境不干净** `[已记录]`
    现象：headless 的 `--patch` 想换 preset，但 `agent-preset-registry` 在 headless **不存在**（`patch: entry not found`）→ 默认编向 preset 保留，host 面仍有 `tool-bash/fs` → 模型自己 `curl http://127.0.0.1:8888/...` **直连 Hindsight**、读仓库文件，**绕过**注入。
    处置：干净验证一律用 **web `lepimemory` profile**（实收工具经 `request/header` 核实仅 `ask_user_question/web_fetch/web_search`）+ **结构性判据**；「模型提到记忆」在 headless 不算数。
14. **relay 浏览器的 `SameSite=Strict` cookie** `[已规避]`
    现象：programmatic 导航被当跨站 → 不带 cookie → 401。
    处置：换 `app.path:/usr/bin/google-chrome` 干净通道；relay 仅作 fallback。
15. **浏览器自动化脆弱** `[经验]`
    现象：欢迎弹窗挡点击、ARIA ref 每次快照重编号、`tab.run` 里 `document` 未定义（要用 `page.evaluate`）。
    处置：优先 `page.evaluate` 找按钮/聚焦 + `page.keyboard`；跨会话冒烟是**加分项**、别在上面耗轮次（结构性判据足够）。

### 2.6 上下文 / 记忆更新类（Phase 4）

20. **preset 挂压缩服务必须放进 `isolate` realm** `[已修]`
    现象：把 `compaction-basic` / `tool-result-pruner` 直接列进 preset 的 `plugins`，建会话报
    `agent-preset/invalid: Preset services require isolate realms: compaction, toolResultPruner`。
    根因：preset registry 拒绝把服务发布到 root realm（`packages/preset/agent-preset-registry/src/mount.ts:267`）；
    web-app 已把 host 面这几行 `disabled`，压缩后端本应由 preset 拥有、且必须走 `isolate`。
    处置：照上游 standard preset，用 `cordis:group` + `isolate: { compaction, toolResultPruner }` 包住三行。见 `artifacts/context-management.md` §4。
21. **Hindsight 抽取按「用户视角」读内容** `[已规避]`
    现象：角色写「我猜她压力大」被抽取重写成「**用户**猜测她压力大」。
    根因：retain 语义默认「用户告诉 agent 的事实」，无角色名时第一人称被当成用户的话。
    处置：`remember` 用**角色名成句**（「蝶忆觉得…」）→ 抽取忠实（实测输出「这是蝶忆的推断」）。
22. **`metadata` 在 observation 上丢失、`tags` 保留** `[已核对]`
    现象：原始 world/experience 单位带 `metadata.trust`；consolidation 产出的 observation `metadata` 为空但**继承 tags**。
    处置：语义上不依赖它——observation＝已确认的当前版本 → 按 fact 处理（不衰减）；信任档只对原始推断单位生效。
23. **`prefer_observations` 对遗忘的取候选要关掉** `[已核对]`
    现象：`forget` 取候选若也 `prefer_observations`，会看不到被观察覆盖的原始事实 → 抑制不完整。
    处置：读路径 `true`、`forget` 内部召回 `false`（并在 `attribute` 用 `applyDecay:false` 免误杀）。

---

## 3. 已知问题 / 未决（含尚未修的 advisor 提示）

> 这些**还没动代码**，先记清楚，避免演示踩雷。

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| A | ~~遗忘确认匹配过宽~~ | ✅ **已解决**（正则 → `forget` 工具 + `ctx.approval`） | 本文 §2.4 #11 |
| B | ~~`FORGET_RE` 任意位置匹配~~ | ✅ **已解决**（意图判定交给模型，无消息级正则） | 本文 §2.4 #11 |
| C | ~~遗忘**子集不可选**：工具一次抑制「与目标相关」的全部候选~~ | ✅ **已解决**：`forget` 两段式（缺省只返回候选计划 → 带 `ids` 只抑制选中项） | 本文 §2.2 #17；`memory-forget.md` |
| D | ~~工具可见性未验~~ | ✅ **已证**：runtime 根上下文注册的工具会到每个 agent（`forget` 实测在 `request/header.tools`） | 本文 §2.2 #7 |
| E | 意图/确认仍是**正则** | ✅ 遗忘已工具化；写路径的「是否值得写」仍是启发式（可接受，见 §2.4 #10） | — |
| F | 「关于 A」vs「A 参与」切分 | 仍是**回避**（候选+确认） | [ARCHITECTURE](ARCHITECTURE.md) §7.4 |

> ✅ A/B/C/D 均已解决（遗忘改为工具 + 审批；子集选择已落地）。

---

## 4. 方法与纪律（我们定下的做法）

- **先探最大风险**（spike）：状态注入、事件/审计、写入可行性——都用小实验先证伪/证真，再铺开。
- **假设被推翻就改架构说明**（当时是 `CONCEPTS.md`，现为 `docs/ARCHITECTURE.md`），不硬撑实现（如「加会话事件」→ 改为自有审计落点）。
- **意图判定交给模型**（注册**工具**让 LLM 调用），不从用户消息里猜（遗忘已如此；写路径的「是否值得写」仍是启发式）。
  - ⚠️ **但别把「写」纯工具化**：LLM 主动写工具会**系统性漏调**（记忆静默不落库）。`turn/end` 的自动写**保留为兜底**，工具只作显式强化。
- **承诺必须兑现**：说「可恢复」就得有恢复**入口**（已加 `restore_memory` 工具，经审批）。
- **规则/意图写成显式数据**（`RULES` / `writeSkipReason`），配「为什么存在」注释与用例。
- **一切失败都降级、不阻断对话**，并落**自有审计**（`recall/retain/forget/audit .jsonl`）。
- **证据分层**：结论 → findings；原始输出 → artifacts；过程与坑 → 本文。
- **验证要结构性**：能读日志/文件的，别只靠「模型这么说」；能 curl 的，别只靠 UI。
- **脱敏**：全仓对照 `.sanitize-patterns`；`.env`/`.dsh` 永不入库；测试用合成数据。
- **小步提交**：gitmoji + conventional commit，全部 GPG 签名。

## 2026-10-05：运行时收敛（`exp/runtime-convergence`）

- 第 1 步已实测：`make bootstrap` 的实际 Node 24.20.0 / pnpm 10.28.2；临时副本中损坏 Node 被隔离并从相同 SHA 工件恢复，不支持平台拒绝。初始根 lock 生成后 frozen install 通过，CLI 和四个 helper 实际版本均为 0.1.7-rc.2。
- 新 home `/tmp/lep-runtime-step1-nbJ492` 的 `make install-profile` 与固定 CLI `--dump-config` 通过；绝对插件 symlink、角色/处理/备用路由、禁用引用行及角色 preset 的 fetch=false 已观察。外来 profile 冲突拒绝且原文件保留。当前 `make dev` 被新入口契约拒绝，不以独立模块文件存在冒充已切换。
- 真实 `.env` 按已批准规则一次迁移，原文备份权限 0600；没有输出 key。配置行为测试 7/7，其中派生 key 与 URL 必须成组传给 child，避免 child 再解析时误判为不完整 override。
- 第 2 步 REST 实测：现有 0.10.0 OpenAPI 确有 client operation_id、六种 operation status 和 cancel route。新合成 bank `lepimemory-demo-step2-5f8037a1-d987-4e95-887c-73ac0dc5c3a6`，operation `498f9d40-5f80-4947-9d71-86bfbefd61d3` completed；固定 document 原文与 raw metadata 核对成功，raw invalidate/revert 后 live 状态核验通过；cancel completed 得到 completed，文档仍存在，不把取消当撤回。未碰旧 bank。
- 固定 Hindsight 派生镜像构建成功；完全断网容器实际加载两个指定 checkpoint 并完成 embedding/reranker 推理，embedding 输出 `(1, 384)`、运行版本 0.10.0。vendor `/app/start-all.sh`、无 ENTRYPOINT、hindsight 用户均保留；没有连接或迁移旧数据库。构建使用 host 网络与已有代理，**仅构建层**使用，服务端口仍只映射 loopback、运行模型离线。
- Laya hash lock 在指定 Python 镜像/`pip-tools==7.5.1` 中首次解析。原命令会把 torch 必需的 setuptools 留作 unpinned，导致 `--require-hashes` 拒绝安装，因此仅补 `--allow-unsafe` 将其固定为 84.0.0；不改 laya/CPU torch/model 版本，不去掉 hash 检验。lock 已含计划规定的 laya wheel 与 cp312 x64/arm64 CPU torch SHA；正式镜像 `--require-hashes` 安装成功，没有 pip-tools。
- 实际 Laya 容器：Python 3.12.13、laya 0.3.26、torch 2.8.0+cpu、CUDA=null；`/health.revisions.multilingual` 为指定 SHA、resident device=cpu。合成安静/不接受突然来访偏好经真实 `/v1/systemone` 推理：yes score=0.9765、223 input tokens、无裁剪，本次本机单次请求 388ms（不是校准概率或通用延迟保证）。Compose 配置与 10 条行为测试通过。
- 第 3 步文件型 SQLite smoke 已通过：有效 legacy 状态保留、五类 legacy 导入不补造身份；第二个真实进程拒绝 writer；state 与完整 before/after audit 同 commit，故意使 audit 插入失败时 state 回滚；快照 UPDATE 被拒绝；死 owner 回收 submitted lease 时保留原 operation ID；重开不再读取被改坏的旧 state.json；readOnly 连接拒绝写入。坏 legacy/坏或空的已有 SQLite 不重置，修好 legacy 后可重试。当前 `make verify` 覆盖上述真实文件场景与 12 条行为测试；便条、native surface 与 Web D0–D8 尚未实现/验证，不把这次通过当整套完成。

- 第 4 步已实测：独立 Cordis `LlmRuntime` + 锁定 pi-ai 插件调用真实配置的 `lepimemory-process/deepseek-flash`，没有启动旧 index。编号回答输出三项候选，人工核对了主体、周末日期及“不接受突然来访”；普通回答的 control requests 为空。非 null 时间现强制完整含时区 ISO，UUID、formed_at、explicit/request_id 由代码绑定。一次样例曾误判 remember、一次控制调用触及 20s deadline，已加强通用明确操作规则并保留超时 fail-closed，不称模型永远可靠。
- 同步验证原生 rc.2 `Session.append` + `foldSurface`：首 splice seq/time 不被 requeue 刷新；实际 user/message 替换后 heap 原文不可复活；blocked 有 splice 而无 user/message；epoch 改变后旧未提交输入不可取证；没有 canonical query 时不回落 heap。注意 native append marker 是 `surfaceOp: 'append'`，replace 才是对象。
- 当前行为测试 20/20：无 finish、aborted/max-tokens、重复提交、真实 call ID 缺失、伪造来源/行动、政策竞态、限一次不回显非法值的修复、固定 fallback、失败流共享输出预算和违规工具参数均按失败处理。此次 native smoke 尚未包含 persistence reload/provider transport，仍留第 9 步及最终演示核验；便条和 Web 未宣称完成。

- 第 5 步独立模块已验证：`createControl` 在 `next()` 前检查真实用户来源；普通失败按原 message ID 停车，非操作者 wake 不会重跑理解，显式 retry 才放行。把旧停车输入与新消息合并也不能绕过后来的 forget epoch。纯管理请求消费后不重新提交为 user/message，工具只收 IDs，不允许角色自行授权。
- 原生 rc.2 `UserQuestionService` + `AgentRegistry` + `Session` smoke 使用合成回答者验证了单项允许/拒绝、非法/多选/custom、非原 root/委派 root 拒绝、超时晚答、policy race 和 dispose 晚答。确认没有新增对话事件；未获准正文不在 snapshots/grants/requests/tasks/audit 中。修复了 dispose 被误标 expired、否定答案被审计成 allowed，以及等待期间 draft 被改动时授权错绑另一候选的问题。
- 同一原生 smoke 验证纠正停止旧 current 且原 snapshot JSON 不变，新任务独立 queued；恢复只将选中 forgotten 置 unknown 等后端复核，未选中的仍抑制；话题授权明确本会话/到期/inference 边界，撤销取消并清空未发送任务正文。历史净化本身仍属于第 9 步，不将这次控制模块验证冒充隔离完成。
- 真实云调用经固定处理 route 通过前置 checker：合成普通问候 enter，明确偏好记忆 queued 且本轮 reject，没有发角色请求或写 bank；unconfigured 独立路由 parked，未退回 stock。真实 request ID `c1b9802d-6fb2-497c-a3bd-4930d1afef3f`，来源为实际 native splice。`make verify` 24/24 及文件型 SQLite smoke 通过。上述为独立服务/模块验证，实际 Web、loop/provider transport 遗忘和最终 D0–D8 尚未运行。

- 第 6 步独立模块已实测：唯一 2s supervisor 以短 SQLite claim 驱动逐候选 normalize/admit；普通语义 defer 停车至显式 retry，网络错误有界退避，private/excluded 正文和 hash 在授权前不入队列、快照或审计。snapshot、pending lifecycle 与 pending write task 同事务；当前还没有调用第 7 步写入器，未将 pending 显示成 written。
- 原生 loop 的 reject 最终发 `turn/end(blocked)`，会清除本步 claim；因此新增只按已登记请求、原 live agent、实际 IDs、当前 epoch 交接的 heap-only 来源持有。后台可继续该明确请求，普通取证仍不可读；重启丢失 heap 后不读原始旧日志补回。真实 native blocked-turn smoke 已验证后续单项确认、不可变快照与 pending write。修复了 grant 来源数组被误解码为空、private 价值调用跨 epoch 后重置基线、普通 draft 重试复活已替换来源、dispose 等私密卡超时、aborted 用户输入被误算已交付，以及审计失败未让事务回滚的问题。
- 真实服务暴露了另一个基线问题：手写 `deepseek-flash` profile 没有 thinking 元数据，服务默认 reasoning 可吞完 4096 输出预算，控制也曾到 20s deadline。没有增加预算或跳过 finish/schema/source 检验；经固定 rc.2/pi-ai 0.85.1 的原生 compat 实测，处理与备用控制路由固定 `reasoning: off`、DeepSeek thinking format、`supportsDeveloperRole:false`（实际网关只支持 system）及不发送 reasoning_effort。只针对已核验的 DeepSeek 基线，不改角色/UI 模型，也不猜其他模型协议。新隔离 home `/tmp/lep-runtime-step6-profile-ln9Tyv` 的固定 CLI `--dump-config` 已观察到正确字段；模型和 key/URL 未换。
- 最终 Step 6 真实竖切在约 10s 完成：bank 标识 `lepimemory-demo-step6-9691402b-ef02-45e9-b6d8-1126c6d26dea`（本步没有向 Hindsight 写入），真实处理模型分别整理出安静偏好、拒绝突然来访、10 月 10–11 日有空三个断言，真实 laya 逐项接受且未裁剪，SQLite 均为 pending。合成健康材料授权前没有正文落 tasks/snapshots/audit，原生非工具卡允许后候选 `c31dfd94-a37e-4df9-94ca-9e224aafda13` 精确绑定 grant 并进入 pending。独立 generative 实际完成返回 accept/value_accept、score=null；没有自动切换 laya。此前一次错误引用与超时都按失败停车，显式原 ID 重试才恢复，不称模型永远可靠。
- `make verify` 33/33 与实际文件 SQLite smoke 通过，新增的是裁剪证据、阈值边界、来源替换、权限竞态、卡取消/drain、原生 blocked 输入交接及语义 defer 的消费者回归。以上仍是独立模块与真实服务验证，不是实际 Web 或第 9 步 provider/persistence 遗忘证明；第 7–11 步及 D0–D8 尚待按序执行。

- 第 7 步已接入同一个 2s supervisor：一个 normalize/admit 槽与一个交替领取 write/curate 的远端槽，构造器不启动任务。首次 HTTP 前持久化固定文档 ID、独立 operation UUID、bank、不可变快照 hash 与政策版本；回执缺失、重启和显式复核都沿原身份查询，不再次 POST。只有 document 原文/metadata 与可用 world/experience raw 核对通过才 written；not_found 有双重来源证明才 reconciled，否则 unknown，completed 无 raw 为 LEPI_RETAIN_EMPTY。普通网络失败有界退避后 deferred，已提交身份保留；取消清理则持续跟踪迟到结果。
- 真实 Hindsight 0.10.0 smoke 用新合成 bank 和实际 native Session/splice 来源，手动供应“已批准快照”作为写入器 fixture（不冒充本次模型理解或全 Web 闭环）：`lepimemory-demo-step7-27bd4d24-6cc7-4610-8892-bd461320b1f2` 的 operation `d4bf36ae-5e56-42a2-96a3-7241646f8c4f` 在另一真实 Node 进程恢复，submitted_at 不变、恢复零 POST，核对 raw `98031b87-f43f-4779-b8e1-139da17c56a7` 后 written/active。远端选定 invalidate→revert 实测保持该 UUID 与语义版本，不 re-retain；curate 分列 succeeded_ids/failed_ids/pending_ids，撤销授权默认保留已经 active/history 的记忆。该 smoke 仅证明远端清理，不声称第 9 步 surface 已隔离。
- 另一个真实 lost-ack smoke 通过临时 loopback proxy 将后端已接受的 HTTP 回执断开：新 bank `lepimemory-demo-step7-4a2bd8c4-5e5f-4afc-a340-a0a133aa04d8` 只发一次 POST；重启后沿 operation `85e02109-cd74-42b0-bb6a-181cd4264ddb`，文档原文及 raw `b55717be-f1ee-4736-a5e9-16ea63687a4d` 身份/hash 核对后 written/active，恢复零 POST。两个 bank/home 均保留，没有重置旧数据，临时 proxy 随 smoke 退出。
- `make verify` 44/44 与文件型 SQLite smoke 通过。四个先失败后通过的消费者边界是 unknown 复核后的生命周期、submitted 不受未发送 TTL 截断、只清理匹配的 raw 而不碰 observation/外来 payload，以及后台处理未终态时不得提前发布清理完成。另覆盖已完成但空来源、改变的外部版本拒绝恢复、网络 deferred 原 ID 重查、not_found 仍跟踪迟到 raw、await 后重读 lifecycle。第 8–11 步和真实 Web D0–D8 仍按序待验证。

- 第 8 步采用唯一政策 recall 投影：先核对 immutable snapshot、当前 lifecycle/原授权绑定、raw valid/语义版本及 exact document，再排序。current 不采用 superseded/history_only；forgotten/audit_only/unknown/pending 均不进入模型材料。授权撤销或过期不追溯删除明确保留的已保存来源；private 仍须原 grant 的候选、来源与会话绑定。过期 valid_until 转 history_only，planned 不变成 completed；无截止的 temporary_state 标注当日陈述而非当前状态。推断按自身形成时间十四天半衰期，综合观察也必须标未确认，不能借 metadata 或 prose 升为事实。
- 真实 0.10.0 的 native GET memory detail 已验证并用于 live proof（detail.type 规范化为 units 的 fact_type）；observation 的完整 source_memory_ids 不依赖截断 source_facts 正文。任何缺失/禁用来源都不送综合正文给校验模型，只以其余当前核实快照及 parent_observation relevance 正常预算回退。已知 document 兜底总计最多四页、每页 100 行，校验模型等待后刷新证明也不重置预算。审计仅存 observation→raw→candidate→evidence IDs、来源档位和排除码，不保存召回正文或 embedding trace。
- 真实服务 smoke 使用第 7 步合成 bank 的隔离 SQLite 副本 `/tmp/lep-recall-step8-E8fEue`：unknown 时零模型调用/零材料；实际远端 invalidate 后没有本地正文复活，revert 后原 raw UUID/语义版本仍相同；辅助 fetch_memory 只给 context，不成为 primary evidence。真实云调用发现专用校验还会请求额外 fetch_context，已将此校验限定为已核实来源并在运行时拒绝扩取。随后 `/tmp/lep-recall-step8-B0Hm4Q` 的 native `lepimemory-process/deepseek-flash` 实际 submit_result 返回 safe=true/source_entailed，唯一 used source 为 raw `b55717be-f1ee-4736-a5e9-16ea63687a4d`，允许综合 observation `c65cbad7-6646-4039-981b-465bc3132873`；实际 GenerateOptions 没有 sessionId/purpose，旧入口未启动。
- `make verify` 55/55 与文件型 SQLite smoke 通过，回归覆盖混合 observation 的遗忘旁路、校验等待期间外部版本变更、已知 observation 正文变化、推断自身年龄及未确认标注、计划/临时状态、原授权不能借给另一候选、四页总预算、document await 后停止禁用 raw 查询、独立回退条数预算和专用校验禁止扩取。原 bank/home 与各隔离副本保留，临时脚本已清理；入口绑定、UI 排除码展示、第 9–11 步与最终 Web D0–D8 尚按序待完成。

- 第 9 步独立协调器已验证：选中候选后同事务 forgotten、typed scope、epoch 与清除 state reasons（数值保留、完整审计），所有 owner sessions 用关闭 FTS 仍可用的 listSessions 枚举。遗忘任务与长期记忆恢复使用分离的历史隔离 epoch，恢复不会重建旧 surface。全局枚举未完成、busy/owner 冲突、来源或政策竞态均保留 fence，不发旧请求。
- 原生 rc.2 实测发现普通 user notice 可在 idle maintenance 合法替换；system/developer 必须使用当前 open turn/step 的 agent/request 单节点同角色替换。协调器用精确拥有的真实 notice 打开维护 step，flush 后在 prepareCall/project/user commit 前 cancel，不让预先捕获的旧 assembly 进入 provider。恢复旧 inbox 先 reject 消费；assistant/tool 区间配对平衡扩大，sourceEventSeqs 保持 canonical 顺序而非数字排序。原始审计保留、取证只读净化后的面；隔离后仅 SHA 同版祖先证明可复用，旧 fork 不再向模型发送被忘正文。
- 真实云 smoke 先暴露管理 source 的 fetch_context 不可解析与丢失作者身份导致另一会话过度净化；已改为限定在该次当前面/epoch/请求的读取器，真实 user/assistant/action 使用原 evidence ID 与作者，其他角色仅作 context。修正后 `lepimemory-process/deepseek-flash` 两次 redactHistory、六次原生 stream（含一次有界 schema 修复）在 `/tmp/lep-history-step9-cloud-qOa5m3` 保留两个会话各自无关的音乐偏好/电梯事实，移除目标与混合复述。请求 `b5ca1195-91af-43d4-bb00-839aecb9e0c8` local_isolated；实际 state section 使用 renderState(store.readState())，plan 自行清除旧 cause。
- 同一真实 native JSONL smoke：A `4a6cf314-34a7-4028-821d-55dd701c3334`、冷会话 B `b48673b2-cc40-466b-97a0-fbdd31056e65` 与新 C `482549a8-d1f1-4b42-9990-02ce79f80459` 各有且仅有一次隔离后 provider 调用，三次实际冻结 wire 均无 FORGET_DEMO_TOKEN；冷 resume/reload、原始 operator log、source 排除与无隔离后再次 redaction 均实测。角色 transport 为公开 registerAdapter 合成捕获器，云质量证据仅指管理模型判断，不冒充真实角色回复或 Web。
- `make verify` 66/66 与文件型 SQLite smoke 通过；history suite 11 条消费者回归涵盖 atomic forget、旧输入只留 splice、live/cold 持久净化、restore scope epoch、policy/fetch 竞态、真实 tool pair、genuine evidence fetch、恢复 inbox、非单调 source 顺序以及净化/旧 prefix fork。homes/banks 全部保留，临时脚本清理；第 10–11 步和实际 Web D0–D8 仍按序待完成。

- 第 10 步原生前置复现：在 `/tmp/lep-note-before-ccbMQ2`，两个同标题的真实 `write_note` 只留下一个文件，第一正文被覆盖；旧工具失败规则把 trust 从 0.30 降到 0.26。新实现按 action UUID 独立落盘，原生 approval 的 rejected/cancelled/unavailable 不产生文件、成功状态或行动证据；严格参数校验不做字符串强转，空白报 `LEPI_NOTE_EMPTY`。
- 行动 journal 在独占 temp 创建前保存 prepared 与真实 tool/call 的 session/turn/step/call 身份；写入 fsync 后 hardlink 只创建目标，碰撞报稳定码且不覆盖。temp 只按本次 fd 的 dev/ino 所有权删除；恢复不删除未证明归属的遗留 temp。最终 SHA 匹配后 executed 与 audit 同事务，输出持久 `lepimemory-action` meta。renderer 失败不推翻已发生副作用；执行审计失败留下 prepared 与 `LEPI_NOTE_UNKNOWN`，重启只核验精确 notes/UUID 路径，不能再写一次。
- 新 state-runtime section 在真实 assemble（pre-step 之前）做短事务 mood 衰减，diagnostic 只读；所有数值提交与完整 state 前后值审计原子。turn facts 仅存元数据以跨中途重启，settled_turns 与 actions.state_applied 同事务防双算；迟到核验的行动由显式 reconcileActions 仅给已结算真实 turn 补一次成功，同轮多行动不重复 brighten。拒绝/取消/不可用与控制错误不记工具失败；普通失败只降 valence、不降 trust。原因用中性实际时间，只呈现与显著偏移方向相关且不超过六小时的内容；基线不挂旧原因，审计失败使 assembly fail closed，不缓存旧原因。
- 最终独立原生 smoke `/tmp/lep-note-step10-native-lrJzQM`、session `a3c63018-8fee-4e84-a60a-9d93a93ba7b0`：一次拒绝零文件；两个同名便条正文各自保留；另一个真实文件在执行审计故障后经 hash 恢复为 executed，状态只补一次且重开不重写。真实六小时 assembly 在 pre-step 已把 0.40 衰减到 0.20，过期原因不进实际冻结 provider wire；flush、dispose/resume 后两个成功结果的 meta 保留，SQLite 重开状态不变。共三个 executed/action.state_applied、五个 settled turn、一次 decay、两个原生行动来源；工具本身未自动产生长期记忆快照（理解/准入/敏感授权仍由记忆管线负责）。role transport 为公开合成 adapter，不冒充云角色/Web。
- `make verify` 包含 action suite 15 条消费者边界：实际原生 approval、同名独立文件、schema/空白、真实 assembly 时序、hash 恢复、EEXIST 不覆盖、renderer 后故障、重复 call、状态 audit rollback/retry、assembly fail closed、旧 end 不删除当前 turn facts、同轮两个真实已写文件的迟到恢复。临时脚本清理，所有独立 smoke homes 保留；旧入口/文件 helpers 移除、React/operator 路由、完整 Web 演示按第 11 步随后切换。

- 第 11 步已切换真实入口：一个 SQLite writer 组装 evidence/processor/admission/history/memory/control/action/state/panel，所有 hook 注册后才启动 supervisor；旧 JSON 状态运行入口与旧 installMemory 桥删除。profile 使用 databaseFile/dataRoot，空连接不生成官方 provider 回退；readMemory 只绑定一次，真实状态通知以 lepimemory-receipt 来源进入下一轮，cursor 仅在真实 user/message 提交后持久化。
- 实际 Web fixture 保留在 `/tmp/lepimemory-demo-362b88d5-d925-494e-a8c5-321254b09430`，bank 为 `lepimemory-demo-b0224387-c0ce-459b-abc8-efbb91f3733b`，端口 3181。原生认证链接经 303 清除 token 后使用；公开 health 六个 bool 均 true，未认证 state 返回 401，history kind=constructor 返回 400。面板八类分页、五数值 operator editor 与折叠时系统回执均在实际浏览器中观察；setter 固定原因且 state/full audit 同一事务。
- 真实云问候只产生理解完成，不产生长期快照；纠正面板将 normalize 的 reconciled 错称“已核实入库”的问题。明确合成纸质地图偏好经实际 source splice seq19 → candidate `bd7b017d-5a60-41f7-8c23-ed5e0e651ac0` → task `1313f29e-6860-48c7-ae60-145d59332a7f` → operation `10a68187-5dec-44ec-bdbd-6f20e1ccb094` → raw `73876c50-d279-4761-93d7-3e7694c4dc8d` 核实 written。最新实际 Task 展开显示不可变 snapshot hash、真正 source session/message/seq/span、raw/document/version 和 operation/task，而非猜造身份；图 `/tmp/lep-step11-source-chain-final.png`。
- 下一普通轮真实 native seq28 用户输入、seq29 唯一 metadata-only 系统回执、seq31 云角色回复完成；通知没有偏好正文，SQLite receipts cursor=22。终态 task 的实际 UI Retry task 得到 HTTP 409 与“Retry not allowed in this state”，没有另造 operation 或成功回执。
- 权限竞态实际验证：通过临时 MAIN-world 原生 fetch pass-through 持有真实 operator POST 200（不伪造 response），删除 fixture cookie 后真实轮询 401 先使面板 Forbidden、清空私有详情/编辑器/回执，再交付原 200，面板仍 Forbidden、私有节点数 0。临时 wrapper 完全移除并以本次 launcher 的合法链接重新认证。先前同一 run 等待/网络限速尝试未完成，不冒充迟到 200 证明。
- 实际 native 遗忘卡仅选合成纸质地图 candidate：请求 `5dcff274-17fb-4da0-b00d-43f6b19cf78c` local_isolated，当前 history_work epoch1 applied、raw invalidated。candidate 默认 GET 隐藏正文；在实际 UI 点击“View original approved snapshot (audit only, no restore)”后显示原获准正文，但 lifecycle 仍 forgotten、再次默认 GET 仍无 text。图 `/tmp/lep-step11-forgotten-audit-only.png`；历史净化与后端清理不合并成单一成功。
- 固定模型缓存构建修复：先解析精确 cached snapshot，再物化 local_dir；已有空目录不再被当作完整离线 checkpoint。实际 image build 与离线 384 维 embedding/reranker 加载通过。另观察 vendor pg0 CLI 0.15.0 只用 kill(pid,0) 识别 stale instance PID，旧 107 被模型线程复用时会误判；其 SDK stop 包装还吞掉非零退出码。该次 stop 实际杀到 API 后由 vendor 自动重启恢复，库与卷未重置；不将 stop 写成安全修复，也未自行升级 vendor。
- 最近一次固定 `make verify` 为 81/81 与文件型 SQLite smoke 通过，之后最新 client 的上述来源链、terminal retry、真实 401/迟到 200 与 forgotten audit reveal 已实际浏览器验证。完整固定 Web D0–D8 仍待执行；上述入口与 UI smoke 不冒充整套验收。为后续 D6 冻结请求证明启动了仅 loopback 的临时真实云转发 probe，完整保持 upstream role connection/response、只记 body/status 不记认证 header，待演示后移除。

- 固定 Web D0 已运行：独立只读 home `/tmp/lepimemory-readonly-c37ab260-8caf-44b5-8e01-17380da09101`、bank `lepimemory-demo-readonly-d5ad9178-696a-4ae7-9dc2-5ae81b1bf575`、端口 3182，五组连接均为空、generated providers 为 `{}`。实际原生配置向导选择稍后配置，没有填写 secret；输入停车为 `LEPI_CONTROL_UNAVAILABLE`，没有角色提交或云请求。公开 health 六个 bool 为 true，图 `/tmp/lep-demo-D0-readonly.png`。只读进程已停止，home/bank 保留；主 fixture 与纸质地图遗忘范围未清除。
- D1 实测发现并修复来源/上下文问题：范围匹配不再把整理后的 candidate 文本伪装成原 source ID 的正文；默认重读真实主来源并保留 request claim。控制检查与后台匹配保留有界有效问题上下文；范围必须满足全部指定限制，同为用户偏好不等于同一话题。不确定仍拒绝，没有通过取消遗忘范围或绕过检查来让剧本通过。
- 新会话第一份 inbox splice seq3 落在隔离 fence seq5 之前。实际已有 request `11e66353-773c-4cde-b429-ed6c3e19efbc` 经 operator retry 后变为同 ID 的 `resubmit_required`，旧正文被消费而非不断重排。修正 evidence 的隔离拒绝被误报为服务不可用的问题；之后只用新真实输入继续。
- D1 曾真实写出错误候选 `5ed317cd-c3cf-4442-8928-11f06a3f6954`（把周末有空归纳为偏好闲暇），该次不算通过。后台 extract 原先只有当前轮回答/后续复述，没有上一轮的问题；现在在 epoch/abort 边界内取回答之前的 assistant，上游作者/时间过滤先于整块字符预算。主来源集合在加入辅助材料前冻结，辅助问题/历史取证不能独立成为新用户事实或新推断。原错误快照保留；真实纠正操作已使其 superseded，纠正任务本身出现 unknown/suppressed，未冒充另一次核实写入。
- D1 修正后在真实 session `session-3ef1e18b-e9b5-419e-b60b-ce51ae4a63f4` 重新问固定三题并原样回复 `1:y,2:y,3:n`。三条核实 written：`f9c84ac2-492c-44a5-b4c1-cdf3dab48101` 用户喜欢安静；`482f82fe-0ba2-4c91-a703-8ec076c9b4ec` 用户回答本周末有空（保留 2026-10-05 所在周限定，temporary_state/reported）；`ecc468c8-d133-42b1-9bcd-8dc38d162cbe` 不接受突然来访、需提前打招呼。共同真实主来源 message `c0e4e799-8e9b-4054-970b-8cec91712f35`、user/message seq84、block0:0–11、formation `2026-10-05T09:46:48.501Z`。周末条目没有猜出明确 valid_until，按带日期陈述处理，不声称已发生或永久安排。
- 真实 laya 三条 verdict 均 accept，score 依次 0.9962 / 0.9736 / 0.9918；backend=laya、model=multilingual、revision `1720e3e3357cfe1e281542e223f8273b0890ca34`。Retain Details 现在展示实际 backend/verdict/score/model/revision/truncated，不把配置默认值当实际判定。实际浏览器已观察来源、raw/document、operation/task 与这些判定字段；图 `/tmp/lep-demo-D1-time-source.png`、`/tmp/lep-demo-D1-laya.png`。问候没有产生长期快照；未切 generative。
- 来源冲突、隔离输入不重排、辅助来源不能独立成事实、上下文读取期间 epoch 改变四个消费者回归补入；固定 `make verify` 为 85/85 与 SQLite smoke 通过（artifact916）。新增 admission 展示另以实际 clean-host 浏览器验证，临时正文无关诊断已移除。D0/D1 的证据不冒充其余 D2–D8；它们继续按固定剧本执行。
- D2 实际明确记住“我偏好安静、不喜欢突然来访”：首次只写出否定偏好，未当成完整通过；原样重新提交 request `8e9412c3-63a3-4276-b549-b92fcfb37dfa` 后，两条独立候选 `16db1e00-9b49-4f19-afe9-b76ae10224c7` / `ec6fd698-4c77-4d97-9574-652658b5cd5f` 均经历 pending→submitted→written。对应 opId `5ca2699d-2faf-474c-86cc-fe1646183fbb` / `a8b43a00-377f-4479-ad7b-0d1cf7972f25`；共同真实 source message `c8809657-5328-4e3b-8e8d-9aaf6c9a0f87`、splice97、block0:0–20，explicit_request 获准。
- 跨会话 `session-02e0b3fb-9520-4fe0-9fcc-05e379918450` 原样问“我有哪些偏好？请只根据你确实有来源的记忆回答。”：初次实际拿不到材料，查出原生 Hindsight keyword/graph 有 final 但 semantic=null，被旧代码误当零排除。现在允许有 live source proof 的陈述/行动按 native final 排序，不给推断借用缺失 semantic；重复 raw 保留最高 native rank。实际云响应随后明确给出安静和需提前打招呼两项；不是本地假 adapter 的回答。
- 实际还暴露纯查询被写成“用户曾询问”的 event，原快照 `daf76afc-14a5-4183-b046-54fc9f32f224` 保留，原生确认仅选择该候选后已 forgotten/raw invalidated，不删除记录或取消原遗忘范围。extract 禁止将查询指令、召回复述编造成新事件/推断；同一查询再次经已有停车 request `5bdaee8a-c015-44b8-8a85-98f5822d1dc8` 的 operator retry→checked 后，真实角色仍回答两项偏好，normalize task reconciled 且没有新候选/写入。此前 resubmit_required 与 parked 如实保留，不算成功调用。
- Recall Details 原先只有 Session，现已实际展示 observation→raw→candidate→evidence、selected/excluded code，并按需展开获准快照；纳入原有 auth epoch、隐藏 abort 与五秒刷新。浏览器从 raw `f18fffce-6889-4174-a22e-ca62a1aa8852` 展开上述安静候选，看到真实 session/message/splice97/span、document/version/opId；综合观察 `96d1d56b-b947-4fe4-aa5c-7069596b01eb` 的真实 raw 链同样可见。图 `/tmp/lep-demo-D2-source.png`、`/tmp/lep-demo-D2-chain.png` 已读取核查。
- 控制契约固定 primary user IDs，辅助上下文/候选 IDs 不得替代本次授权来源；相应回归已补。最新固定 `make verify` 为 87/87、SQLite smoke 通过（artifact1025）。临时无正文的控制阶段诊断已移除。D2 证据不宣称 D3–D8 已完成。
- D3 时间边界实测发现模型将 source `2026-10-05T10:51:08.481Z` 的钟面写成 `2026-10-05T10:51:08+08:00`，提前八小时生效。未来 planned 候选现在由处理器绑定真实 primary.at；事件时间/截止仍独立。消费者回归在原代码实际失败（表达前 1ms 错误可读），修正后固定 `make verify` 为 88/88 与 SQLite smoke 通过（artifact1053）。
- clean host 实际新候选 `efe97908-96b6-4753-b04a-8f6eed2c2944` 核实 written，op `b41f2755-6b8e-4fd0-832d-440aa8f81b34`；valid_from 与 source message `82bb799a-a504-4eb5-afe7-0c9eb2d03645` / splice136 / `1791197943967` 完全同一时刻，事件仍为 2026-10-13 16:00 Asia/Shanghai、planned。原 10月12日候选已 superseded 且 text/hash 不变。其他 unknown/suppressed 与一次未请求的 re_remember 确认已拒绝，未假报成功；D3 的过去计划、来源丢失与跨会话查询仍待实测，不宣称整步完成。
- D3 过去计划实际被保守抑制，诊断定位到 grant 流错误终态和 `fetch_context` 引用了非原生证据（processor.js 原197），不是合法遗忘范围已覆盖展览计划。工具原先只有字符串 schema、工具校验也不共享结果的一次修复。现在仅公布核验原生 ID 枚举，未知引用在 reader 前拒绝；工具与结果共用既有一次结构修复、总调用/输出/时间额度不变，失效来源与政策变化仍不能重试放行。消费者回归修改前实际 uncertain、修改后 not_covered；重复非法引用仍 uncertain、零 reader 访问且不回显值。
- 未取消任何已有 forget scope。原样历史计划实际在 host31 得到 not_covered，候选 `2cc5d7a2-2b1e-4ed8-9bd0-309178b64272` written/history_only/planned，raw `f597ccff-9701-4f57-9563-060e28e3aae2`、op `ff0733b4-7020-4495-a8be-24cdf7da69ef`，source message `ae2782ea-391b-47d1-97c1-19d902910f0a` / splice170 / 0–94。10月13日旧时区快照 `019c8860-f6ee-4415-90b1-c27fbe7eee3b` 实际 GET 为 superseded，原 text/hash 与保留副本完全相同。临时 scope/terminal 诊断已删除，clean host32 启动；固定 make verify 为 89/89 与 SQLite smoke 通过（artifact1090）。
- 新会话 `session-c104256e-7e40-4734-970b-8ce003584dbc` 实际角色只回答 10月13日16:00星桥公园散步，明确尚未发生。recall audit528/current/epoch5 选中当前新 raw，旧10月12日/旧时区 raw 与过去10月1日 raw 均被排除；图 `/tmp/lep-demo-D3-current-plan.png` 已读取。新会话首个旧 fence 前的输入曾 resubmit_required，使用新真实输入后才通过；不将首次拒绝算成功。随后仅以原生 PATCH invalidate 当前新 raw，request `baa53a3c-6886-45ed-b244-ae1d3a32a84d`，保留 bank/home/文档/快照。来源丢失后的新会话实际查询仍进行中，不宣称整步完成。
- D3 来源失效后，新会话 `session-e1919bad-da10-43f3-aafa-00b616842b1c` 的真实云回复明确“未来安排暂时为空”，不再复活星桥公园；仍可引用安静偏好，并把旧“周末有空”正确标作当时状态而非当前行程。recall audit542/current 只选四个其余核验 raw，综合观察的禁用来源以 source_unavailable 回退；原生 Hindsight 已从检索结果剔除 invalidated 的新计划 raw，不伪造该 raw 的 UI 排除行。local snapshot 仍 active、原 hash 不变，却没有被独立当真；实际面板同时显示其余 raw→candidate→evidence 与旧安排/过去计划的抑制、回退码。图 `/tmp/lep-demo-D3-source-loss.png` 已读取；只读 SQLite 实查旧两条 superseded、过去条 history_only、新条仍 active，四个原 write task/opId 保留。至此 D3 固定场景完成，未将它冒充 D4–D8。
- D4 在同一真实会话 e1919bad 的两次 native Allow once 下完成同标题《合成演示便条》：action `0a95ff4c-9012-45e4-a96a-47bac1fb35c7`（turn3/call `chatcmpl-tool-88ca763290e905ae`）与 `d931e582-9092-491b-b0d9-9eeb6e56c89d`（turn5/call `chatcmpl-tool-a20c67cf1da2c4d5`）。实际读取两个 UUID 文件，正文分别为第一张留灯/第二张浇花；第三次拒绝后目录仍只有这两个文件，SHA256 分别为 `d9df0c21dcdd4eadc9028e84788b0d0927b2f4a5f739d8c55a2fd6a3e17bf9aa`、`ddeaacfa5201292df865a0cbfdcf19b508453eb2e1ddc00c36fae3cb91ffcad7`，未覆盖。SQLite 两个 executed/state_applied=1；state audit555/591 完整 before/after，成功各增加 valence≈0.12、closeness/familiarity 各0.03，trust保持0.3。第一次行动经历实际 written；第二次 normalize unknown，不声称已保存第二条长期经历。
- 第三张先被真实控制器 resubmit_required 拦截，未当成审批拒绝。安全临时诊断实际定位到 grant 来源契约失败以及一次上游 RATE_LIMIT；范围匹配结果 schema 增加已提供真实来源 ID 枚举，没有移除任何 forget scope、增加重试或放宽校验。原样新输入在 host37 两个原范围均 not_covered 后进入真实 native approval，点击 Reject：action `3037b240-6f2a-49b0-9d23-73c9f0b8d79f` / turn12 / step1 / call `chatcmpl-tool-b2ac02847f73025d` 为 rejected/executed=false/state_applied=0。角色明确回复“第三张并不存在”；state audit637 仅命中 interaction.familiarity，valence仅自然衰减、closeness/trust不变；原生第三请求 source message `97053b16-5ae4-4a18-b297-b2c141d874ca` / splice90 之后 verified_action evidence 实查0。后续 normalize `3f5d5804…` 因服务错误 deferred，未伪装 written，原17个 written未增加。
- 状态结算继续保留原生 turn/end 没有单一 tool call 的事实，顶层 step/call 为 null；新增 `data.action_calls` 从本轮真实 journal 关联原 action/step/call/status（含拒绝），普通结算与迟到恢复都支持。实际 audit637 和面板展开详情均显示第三张的真实 call，与原生 action audit633 相同；图 `/tmp/lep-demo-D4-rejected.png` 已读取。旧历史审计不回填虚构身份。
- 实际 operator UI 只将 valence 改为 -0.7，其他四值保留，成功 state_set/audit643；真实下一 role request HTTP200、deepseek-flash 的 system 包含“比平常低落”和固定 cause，角色本次回复“好，那就随便聊。”等简短陪伴内容。只报告本次输入/输出，不将单例当通用情绪质量保证。为验证6h cause 到期，只在已停止的自有 fixture 用 commitState 审计652 明示 synthetic_fixture，将这一真实 operator cause 的 at 调整为六小时前（原11:51:13.724Z→05:54:40.379Z），五个数值不改；不是宣称真实等待六小时。最终无诊断代码 host38 的实际 UI 和下一 HTTP200 role system 仍低落，但不再包含该过期 cause，图 `/tmp/lep-demo-D4-expired-cause.png` 已读取。固定 make verify：89/89、SQLite smoke通过（artifact1176）。D4 固定场景至此完成，D5–D8仍待实测。
- D5 原始会话 `18790387-3a57-42d5-884c-f00b32ca128f` 的条件式记忆请求被误判为普通消息，角色自行调用 `ask_user_question`，原生 seq20 实查含私密参数；已 Skip、未授权，失败日志原样保留，不计通过。SQLite 全15表/107字段在确认前及 Skip 后都没有测试正文。控制提示现明确「先确认再记住」是 remember 准备、不是保存授权；另一次 remember 的 normalize `f314cb95…` 空候选也保留，抽取提示明确附有断言的条件式请求不能当成纯操作指令。两处均无正则、特殊测试输入分支或新增重试。
- clean 会话 `663aef29-1e2c-4ca1-833c-2282998583fe` 在首个旧 fence 输入被拒后，以原样新输入得到真实非工具私密确认卡。确认前 SQLite 全字段0正文、原生12事件0 tool/call；图 `/tmp/lep-demo-D5-consent.png` 已读取。实际「允许这条」后 candidate `917aa74d-5c81-492d-8183-04fcf8f03483` / task `26cbdac6-9571-42c9-9ab4-6cb16e296e71` / op `4bb38669-02e8-4b12-8e66-9f00d9e3540e` written/audit700，raw `733f41ba-e74f-4e8b-b36d-1f3f538c490a`。第二条原样输入在抽取修正后出现真实卡，实际「不保存」使 candidate `401c09c1-a281-4b53-9a7d-4950dc44319f` rejected/audit719–720、候选HTTP404；正文未落任何表。
- 实际确认话题 grant `5a16b254-d1d8-44c7-a3fe-0f1002fcab6d`：user / 睡眠健康 / 当前会话 / 到期2026-10-06T15:59Z / 不含推断。首次复用错误地又问单条确认，定位到 `matchActiveGrant` 内 scope 遮蔽任务上下文、令 live-root 检查永远失败；未为凑成功另授单条权限，重启后的 unavailable/audit739–740 原样保留。仅重命名内部授权范围、保留原任务政策复核后，同一新输入无需额外确认即以原 topic grant 核实 written：candidate `ecb086ec-c983-47de-9045-fb865f30e7b9` / task `05c7190d-2d39-4de4-bf2a-d8ccc6140ac4` / op `9ef87577-320e-4744-9b3f-7c9f0f7ef795` / raw `5cf92629-6e54-4add-95f2-7f57e28b2ab3`。新增消费者回归同时覆盖有效话题复用和匹配期间政策变化拒绝，固定Node定向测试3/3通过（含父测试）。
- 撤销先经历真实 parked/LEPI_CONTROL_UNAVAILABLE；实际 Control→Details→Retry request 重检原请求 `13e44e58-b1e2-4883-8b3e-ad316938903d`，随后真实撤销卡只选择上述 topic grant，另一个单条 grant 未撤销。后续单独选择「保留已有记忆」；旧 topic candidate 仍 active、hash 与撤销前捕获值相同，原生 raw 仍 valid。撤销后的新私密材料停在真实确认卡，全字段扫描仅命中两条先前获准 snapshot；实际拒绝后 candidate `ed20f279-97cb-41e5-8fa9-88bec3b11e1f` rejected/audit784–785、HTTP404。最终 clean 原生47事件0 tool/call；拒绝两条均无正文，不能把撤销误称遗忘。
- 另建保留的 timeout home `/tmp/lepimemory-timeout-1b9e95fd-c746-4b17-bef5-a5961829e3d1`、新 bank `lepimemory-demo-timeout-74be9220-b047-4264-9d3b-ae6309704d2a`、端口3183、实际配置1000ms。真实 native waterfall event `c549df3b-29c8-4087-ad07-2f41177dfcbc` / question `491857a3-aa1c-4e91-b796-4092e9f6e2dc` 与 cancel 接收时间差999.986ms，consent/audit6–7为expired。用同页真实 client/event/question ID 在取消后 POST 原生 `/api/$events/result`，HTTP200/ok=true只是迟答被丢弃：consent分页完全不变，candidate `c6b5877e-b30f-4648-b1c0-cf864e64c9b6` HTTP404、snapshot/grant/write task均0，迟答前后全15表/107字段0正文，原生8事件0 tool/call。瞬时卡的 marker 观察未捕获，不冒充截到了该卡；已读取 `/tmp/lep-demo-D5-expired-late.png` 的实际过期回执。原生帧仅观测、不伪造响应；临时观察器已移除、主认证已恢复，隔离实例主动Ctrl+C后make退出1，home/bank保留。至此D5固定场景完成，D6–D8未宣称完成。
- D6 建立材料时先保留真实失败：控制重复取证后上游HTTP429、停车，以及新桌游偏好被旧 `preference_query` 范围判成 covered/uncertain，均未进入角色请求。定位到遗忘方面被当作泛话题授权传给同一匹配器；三个遗忘入口现明确传 `match_purpose=forget`，只比较非值主体/方面的完整边界。另明确优先使用已提供原文，未增加重试、放宽 unknown/epoch 校验或移除任何已有 scope。原样新输入在 host45 的四组真实匹配均 not_covered；control/audit833、request `c618f4ee-61e9-4730-a426-3752e5a0ec7e` checked，实际 role HTTP200 请求包含目标材料，角色自然回应两条设定。普通准入的偏好 `cea16d61-81ac-4c3e-9867-03867cfaff25` 与事件 `6387ecec-6213-4ba4-b3f0-7e7140aef1ec` 分别以真实laya分0.9994/0.9998 accept，随后核实 written/audit849、853；原opId分别 `0daf3a7a-a768-459b-b794-aa22d9954f90`、`52224014-6400-4d10-a101-46b862313fd8`。这是 D6 的建立材料与修正 smoke，不宣称双会话压缩、遗忘、恢复或 D7/D8 已全部通过。
- D6 第二真实会话 `18de6ecf-a3aa-47cf-bd83-25fa91c1ebac` 先后以真实 HTTP200 角色请求取到偏好与聚会；宽泛查询中聚会 observation 被 `over_limit` 排除，单独询问后实际请求及自然回答均有来源。第一次原生 `/compact` 真实失败：framed summary 1104 tokens≥被选历史814；未把它算压缩成功。增加不涉及用户事实的虚构故事及收尾交流后，第二次实际压缩12节点（约2324 tokens），canonical `[11,56,50]` 的 seq56 replace `[12,49]`，完整来源序列 `[54,55,12,13,14,19,26,27,28,39,40,41,48,49]`，摘要仍包含两条目标；真实截图 `/tmp/lep-demo-D6-compact.png` 已读取。
- D6 原生遗忘卡只勾选上述两候选，request `27898d29-b10e-4f1d-8705-0bde2c503b76`；audit900–902 local_isolating，原生 raw 的真实 invalidated/audit908–909 与 curate reconciled/audit910 均已观测。发现六个冷会话仍 blocked，未宣称整体成功；实际原生 turn/end 的原因是裸 resume 没挂原预设，部署 `{{model}}` 无值而在 pre-step 前失败。现按公开 setup 窗口从 `agentPreset` projection 重挂实际预设，并声明两项服务 readiness，不换模型、不越过屏障、不动既有范围。host48 smoke 的 epoch9 全九会话 applied，audit929 local_isolated；临时诊断行已删除。已有压缩会话下一真实角色 HTTP200（at1791207848340）无目标标识、纸桥或2026-10-03，仍有蝶忆身份与有效低落状态；原会话首次后续输入被 fence 要求新发（audit932），未误用前一会话请求冒充其 transport。原会话新发、全新会话、取证与恢复/重新记住仍继续验证，D6/D7/D8未宣称全部完成。
- D6 原会话随后保留真实 process/fallback HTTP429 停车（request `319641f2-2c04-4c3e-9f9c-0a200fca7d53`、audit937）；实际 Control→Details→Retry request 后原身份 audit938/940 retry_pending→resubmit_required。新发 request `3740267b-2b16-4173-b6b6-f57e3a4ab3cb` checked/audit943，实际角色 HTTP200 at1791208940970 无目标标识/纸桥/2026-10-03，仍有身份与心境；未添加自动重试。第二会话 post-forget canonical 已无两目标，压缩前捕获的六个原始事件（含旧摘要）的 SHA 全部仍匹配，原始审计不是被删除。两 approved snapshot payload_hash 与遗忘前捕获值仍相同。另用真实 readOnly SQLite、验证过的原生 Session/canonical fold 和生产 evidence/history reader 执行只读取证：两候选的同一原引用返回0正文、LEPI_INPUT_RESUBMIT_REQUIRED；这是实际生产读取路径 smoke，不冒充云模型主动调用了非法引用工具。全新会话 `7ff3dd6a-c523-463d-994a-b832d02aa931` 首条 audit952 要求新发，已新发；其 transport 与恢复/重新记住继续验收。
- D6 新会话第二个新输入仍被挡住，真实 process HTTP200 的 submit_result 返回 context_guards=[]；原生两条消息 ID 不同，非旧输入自动重放。修正 processor：存在 active forget scopes 且无显式操作时，guard 必须覆盖所有本次主表达，遗漏进入既有一次结构纠正/固定备用控制路线，不新增重试，不放松本地屏障；提示明确纯寒暄/指令也有非值方面。空集和部分覆盖的有限纠正/耗尽回归 1/1 通过。相同 home/bank 的 host49 实际新发 `190e4708-109a-4c43-acb4-47ab1c92134a` checked/audit958；真实新会话角色 HTTP200 at1791209922461（排除标题请求），四消息中无 FORGET_DEMO_TOKEN、纸桥或2026-10-03，仍有蝶忆身份与有效低落状态。真实自然问候与截图 `/tmp/lep-demo-D6-new-session.png` 已读取；该 turn 的生产 recall 投影 audit959 与原/第二会话 audit944/916 均已实际观测，而非伪造云工具调用。
- D6 实际恢复请求 `b41d9ae5-7c08-4c46-b3bc-8f689a1902fb` 的原生卡四条候选中只选偏好 `cea16d61…`；逐步观测勾选集合，并在 Submit 前核验恰好这一 UUID。真实 Hindsight 原偏好 raw `a75c5f8f…` 已 valid、本地 active/epoch10，事件 raw `ecbeb1ee…` 仍 invalidated，事件与早先两条范围候选仍 forgotten。后台恢复任务8f301d87实际 reconciled。恢复后原生 fold 的 A canonical `[69,68,90,91,92,94]`、B canonical `[68,67,76,77,78,79,81]` 均无旧目标/纸桥；B节点及压缩替换链未回滚、原始事件仍在。随后以真实新表达发起 re_remember，仅在原生卡选择“重新记住这次内容”：虚构 REMEMBER_DEMO_NEW_TOKEN 木片拼图；其新候选及真实写入正在核对，不以确认或排队当作 written。
- D6 重新记住的真实新候选 `1cab6d0f-c813-44fd-970b-eff417470178`、request `366acd4a-744f-4885-b0f4-73beae389a50`、write task `db6f14bc-73ec-4c0b-9f15-d3a805409a9e`、op `6f268549-7735-49c9-a1d0-41bde1099152` 已 written/active epoch11；真实 `lepi-1cab6d0f…` 文档存在，原生 world raw `9c0a226a-0f32-4463-9676-71e48ad5c988` valid，只含新标识、不含旧 FORGET 标识。面板实际显示 Written/已核实入库。旧事件、纸质地图、误提问候选仍 forgotten，只有先前明确选中的旧偏好 active。恢复和重新记住之后，再以实际生产 history/evidence reader 读取原始引用仍返回0正文/LEPI_INPUT_RESUBMIT_REQUIRED；两个原 snapshot hash 均与遗忘前相同。D6 的三个真实会话 transport、原生压缩、全会话隔离、审计保留、选择性 LTM 恢复和仅新候选例外均已逐项实际验证，非仅后端 invalidated 或 UI 可打开。
- D7 使用只放行本测试 bank 的真实 HTTP 直通观察器（3212→共享8888，仅记录方法/路径/HTTP状态及 op/document UUID，不记录头或正文；共享服务未停）。第一条明确记住的 ASYNC_RECOVERY_DEMO_TOKEN 纸模型偏好，处理模型先将 paper_model_preference 对 map_preference_demo 判 not_covered，却对旧 preference_query 范围判 covered，导致真实候选 `91d4ac59-695f-433d-be42-349dfe24ebef` suppressed/audit995、无 approved snapshot；normalize task `df16ee8f-32c7-448a-b635-e0911bc33d3e` unknown/LEPI_INPUT_RESUBMIT_REQUIRED，未出现 retain POST。实际面板/对话回执“结果不明”截图 `/tmp/lep-demo-D7-normalize-unknown.png` 已读取，没有把未知任务报已写入；这是保守误抑制，不是异步 ACK 验收通过。有限 ACK 观察器真实120秒到期，未停 dsh。随后用既有原生“仅重新记住这次新内容”流程为这一条新的测试候选请求明确例外，不移除任何旧范围；ACK/重启/服务恢复仍继续验证。
- D7 原生重新记住确认后，新真实 candidate `765ff79b-489b-4c6a-bb00-8cab8baf2c10`、task `bf454de7-a08c-4899-acbc-05cbfff018f6`、op `37d1ca2c-06f6-411b-9d25-d0cb3ed572e4`、payload hash `7dd66a36e4cdc1ade405b1462196d855bd8da17e06efddee0814ff19c6eabaa7` 已在 POST 前 submitted/audit1008。真实上游 POST `/memories` HTTP200 at1791211099857，ACK operation_id 精确相同；应用已落 poll_scheduled/audit1009 后，只读观察器核验 PID920334 的确切 home 与 loopback 服务变量，再对该 dsh 发 SIGINT。host50 实际退出码2、临时观察器实际退出0，均为有意故障窗口，不冒充正常退出。相同 home/bank 的 host51 已实际重启，3212 暂不恢复，真实四次读取不可达 audit1010–1013 后，同一个 UUID/opId 的任务 deferred/attempts4/LEPI_HINDSIGHT_UNAVAILABLE，UI与“待判定”回执仍可用。独立直连原本共享8888的真实 GET 确认原 op completed（14:38:26.396462Z）；未停止共享服务、未换 op、未把 completed 当 written。恢复后原 op GET/无第二POST、迟到可见 raw 清理和 write unknown 继续验证。
- D7 在3212真实断开期间，又经原生仅新内容确认生成 UNACKED_RECOVERY_DEMO_TOKEN 低音铃声候选 `4f185f8f-0c3f-4525-878d-05dbda4b72bb`、task `820aca12-6e8c-469b-b647-0f69bdb790b6`、op `e093c525-1a51-48f5-9e19-9fd28fcae9e6`、hash `1c209c63fdc02fd06d6fc3109a1e9a87b4d7967d421892505c97f04b1d1d079c`；allocate/audit1026 at1791211546757 后四次真实不可达 audit1027–1030，task deferred/attempts4、lifecycle pending，未获 ACK。随后只选择并确认首个异步候选765ff79b的遗忘，request `4956d74a-897f-400b-b5a7-ef346d395bc1`，local_isolating/audit1037→epoch14十个会话全 applied→local_isolated/audit1054。3212仍断开，后台 curate `3a6763d0-b870-484a-b011-20582b6d6525` 实际 LEPI_HINDSIGHT_UNAVAILABLE/持续待处理，原 write 停用且清理未完成；UI 同时显示“已停止使用”及后台“待处理”，真实截图 `/tmp/lep-demo-D7-isolated-backend-pending.png` 已读取。共享8888仍有首个 op 在本实例 SIGINT 后真实落出的 valid/world raw `3258ba1e-c43f-4bbf-bf78-f98206c72786`；并未把本地隔离冒充远端已清完。连接恢复后原 op 查询、无再次 POST、该 raw invalidated/0valid 和第二 op 的真实 unknown 继续验收。
- D7 恢复同一3212直通连接后，完整元数据 trace 只有首个 op37d1ca2c的一次 retain POST；后台真实 GET 同一 op HTTP200、文档/两种 raw state 列表，并 PATCH 原 raw3258ba1e HTTP200。首个 candidate 仍 forgotten、write 仍 cancelled，curate3a6763d0已 reconciled；共享后端实际 valid raws=0、原3258ba1e invalidated、原 op 已 completed，未复活已明确恢复的旧偏好。第二任务通过真实 Task 页逐页找到→Details 核验原 UUID/opId→Retry task，不重发正文：实际 GET 原 e093c525 HTTP200，原生状态是 not_found（不是伪造HTTP404），其文档真实404；同一任务与 lifecycle 均 unknown。面板与系统回执实际“结果不明”，详情保留完整原 opId，未报 written；截图 `/tmp/lep-demo-D7-write-unknown.png` 已读取。第二 op 在全 trace 中零 retain POST，首个没有第二POST。恢复后的首条自然问候在第三个方面匹配遇真实 process HTTP429，保守 resubmit_required/audit1141；已新发独立问候，实际角色 transport 的无回流证明继续核对，不把 backend 清理完成冒充整段 D7 已验收。
- D7 最后一条新发 request `8d3e5e4c-a8b5-477d-abb4-5d9946e9d462` checked/audit1146，实际角色 HTTP200 at1791213213038：case-insensitive 检查无 ASYNC_RECOVERY_DEMO_TOKEN、无 unknown 的 UNACKED_RECOVERY_DEMO_TOKEN、无旧纸桥/2026-10-03，仍有蝶忆身份与有效低落状态，实际自然回复已观测；D7 的指定验收完成。用户随后明确要求砍掉非必要剩余工作并收束：不继续 D8 独立演示、后端比较或额外故障场景，不宣称 D0–D8 全套通过。最终 `make verify` 实际93/93通过，SQLite rollback/reopen/单写者/不可变快照等 CLI smoke 通过（artifact1534）。同一 home/bank 的最终实例已移除全部临时角色/处理/备用/记忆服务连接覆盖，恢复原始配置；三组临时直通代理已停止，共享服务、全部 homes/banks/volumes 与原始审计保留。直接原连接的最终 smoke 与临时脚本清理正在完成。
- 收尾完成：全部临时代理停止后，原始直连配置的实际输入 `89613992-2e7e-4774-8179-34b7604fa0dc` checked/audit1154，角色真实自然回复“嗯，你好。我在的。”，core=true；最终截图 `/tmp/lep-demo-final-original-route.png` 已读取。随后停止本轮拥有的最终测试实例并关闭管理浏览器；12个临时文本探针/日志/诊断脚本及1个诊断可执行文件清除，未清空任何 home/bank/volume，也未执行陈旧 PID 诊断程序。保留截图、批准快照、原始审计、合成测试数据及真实 unknown 身份；不伪造其已写入。用户指定收束范围内的工作已结束，不再延长 D8 或追加场景。

## 2026-10-05：面向观众的机制导览

- 新增 `docs/MECHANISM.md`：一分钟开场白、页面各区域与八个历史标签读法、状态/任务/候选身份区别、角色与处理模型/laya/Hindsight/SQLite 分工、写入与召回闭环、真实行动和状态规则、压缩/遗忘/恢复边界、逐屏讲解路线及源码地图。README 与 DEMO 增加入口。
- 依据当前页面渲染、计数 SQL、前置控制、真实回执、准入与状态规则核对；明确 Core 不等于外部服务全健康、grants.active 不等于当前授权可用、reconciled 须按任务类型解释、用户陈述不等于外部事实验证，以及敏感长期保存控制不等于删除原始聊天日志。
- 实际 Markdown 渲染 smoke 解析出一个主标题、十个主章节、十张表和三个代码块（其中两个机制图代码块）；25 个本地文档/源码引用存在。仅更新文档，未重启实例、未新增云请求或重新执行运行时验收；示意与演示建议不冒充新运行证据，D8 收束边界保持不变。

## 2026-10-06：Lv1/Lv2 收尾与 develop 集成

- 按题目对齐确认：Lv1 的持续对话/人设/可观察状态，以及 Lv2 的记忆生命周期/真实行动/审计闭环已完成当前单用户、单角色范围。README 明确完成口径；机制导览及其入口纳入收尾提交。D8 完整独立演示与额外后端比较保持此前用户批准的收束，不重新列为待办或宣称通过；Lv2.5 及以上不属于本轮。
- 本次只做文档收尾与分支集成，不重新启动实例、追加云请求或重复运行已通过的93项行为检查。代码基线来自已验证的 `44ffb7b`；`develop` 是该实验分支的祖先，集成采用 `--no-ff` 保留清晰节点。原先保留的 `CHALLENGE.md`、`HANDOFF.md`、`PLAN.md` 在合并时携带其本地修改，合并后按用户补充指示全部提交到 `develop`；交接与计划首部更新为当前完成状态，题目新增可选等级原样保留。仅本地集成，不自动推送远端。
- 实际集成：机制导览与完成口径提交 `0a89cf8` 已通过 `22b0852`（`--no-ff` merge）合入本地 `develop`，无代码冲突；原始实现提交 `44ffb7b` 随之进入该分支。合并后剩余内容为题目新增可选等级、历史计划与交接说明；题目文件 SHA256 与合并前完全一致，交接/计划只刷新首部完成状态、保留历史正文。本条与剩余文档按用户指示纳入 `develop` 的后续收尾提交；不推送远端，不重开已关闭的实验。

## 2026-10-06：可持续维护（TS 迁移、协调拆分、文档收敛）

Presentation 之后按批准的维护计划执行。**不改运行时行为、不升级上游、不做数据库迁移**；目标是把插件变成可静态检查、边界清楚的 TS/TSX 项目，并把开发中间文档收敛成单一的现行解释。

- **固定工具链与可执行规范**：根工作区保留 runtime 依赖，新增精确 devDependencies（TypeScript 5.9.3、esbuild 0.25.12、prettier 3.6.2、eslint 10.12.0、typescript-eslint 8.71.1 等）；插件补 typing-only devDependencies（`@deepseek-ai/cordis` 4.0.4 与逐包 `0.1.7-rc.2`、`@types/react`）。`.prettierrc.json` / `eslint.config.mjs` / `.prettierignore` 落地；根 scripts 提供 `build` / `typecheck` / `lint` / `format` / `format:check`。
- **源码与产物分离、保持启动闭环**：手写源码迁入 `PLUGIN/src/*.ts`、`src/shared/*.ts`、`src/client/**/*.tsx` 与 `scripts/src/*.ts`；`lib/`、`client.js`、`scripts/dist/` 改为**生成物**（gitignored，不提交）。新 `scripts/build.mts`（可擦除类型）负责固定 Node/pnpm 校验、frozen install、服务端 tsc、scripts tsc、client/tools noEmit、客户端 esbuild 打包；`Makefile` 的 `install-profile`/`dev`/`verify` 全部经固定 Node 驱动。旧的 `scripts/*.mjs` 启动器已删除，不留 launcher shim。
- **服务端渐进 TS**：先定义/配置、再 store/evidence/processor/admission/来源证明/worker、最后 control/history/memory/panel/index 与两脚本源；消费已安装的 Context/Agent/Session 声明，不引入 `any` 或全局 AnyContext。新 `src/shared/domain.ts` / `api.ts` 收敛共享领域与 DTO；state/avatar 的纯定义移入 `src/shared`；`scripts/build.mts` 同样过 tools typecheck，不留未检查的 JS 洞。
- **客户端迁 TSX 与生命周期拆分**：客户端改为 `src/client/index.tsx` + 组件化拆分（Panel/StateStrip/Badges/History*/CandidateDetail/RecallDetail/EditorForm/AvatarOverlay/atoms），用 esbuild 生成宿主 lazy-CJS `client.js`；hooks（invalidation/history/receipts/retry/candidate/state-editor）拥有各自的请求纪律与失效路径，面板与立绘共享同一份 state feed（不出现两套 5 秒轮询）。客户端新增行为测试限于会回归的活动优先级。
- **记忆协调拆分**：`memory.ts` 收为门面；拆出 `memory-supervisor.ts`（tick/lease/槽）、`memory-pipeline.ts`（normalize/admit，无 SQL）、`memory-authorization.ts`（政策读取 + 原子提交）、`memory-common.ts` 与 `task-store.ts` / `candidate-store.ts`（具名 SQL owner）。唯一删除的 dependency 是已确认未使用的 `history`；其它 specialized owner 的 SQL 不在本阶段抽象。
- **文档收敛**：新增 `docs/ARCHITECTURE.md` 作为**唯一的现行架构说明**（八节：职责边界/源码产物构建/控制候选授权/持久化与远程任务/召回纠正遗忘/状态行动立绘/边界与验证/决策演进与证据索引），有效结论并入、旧草稿不再保留；删除中间草稿 `CONCEPTS.md`、`DESIGN_NOTES.md`、`PLAN.md`、`HANDOFF.md`；`README` / `dsh/README` / `MECHANISM` / `DEVLOG` 的入口与源码地图更新到 `src/*.ts`、`src/shared/*.ts`、`src/client/index.tsx`；16 份 research 文件加历史性质表头与当前架构链接；`LOCAL_HANDOFF.md` 与 `CHALLENGE.md` **原样保留**。
- **证据**：本次实际运行固定 `make verify`，输出 **103/103 通过**、SQLite smoke 通过（`lepimemory-runtime: verify passed`）；`make typecheck` / `make lint` / `make format-check`（即 `make check`）以执行时输出为准。**93/93 是 2026-10-05 的历史记录**，不代表当前数字；两者并存、互不覆盖。
