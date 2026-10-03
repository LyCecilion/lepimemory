# 开发日志 — 蝶忆 Lepimemory

> 用途：**过程与踩坑的诚实记录**。给未来的自己、以及想了解「我们如何定义问题、在哪里栽过跟头」的人。
> 分工：结论进 `CONCEPTS.md` / `docs/research/*-findings.md`；原始证据进 `docs/research/artifacts/`；**本文记「怎么走过来的」与「坑」**。

---

## 0. 怎么读

- 想看**能力现状** → `README.md` + `dsh/README.md` + `docs/DEMO.md`
- 想看**架构决策与理由** → `CONCEPTS.md` + `DESIGN_NOTES.md`
- 想看**实测结论** → `docs/research/dsh-findings.md` / `hindsight-findings.md` + `artifacts/`
- 想看**过程与坑** → **本文**
- 恢复上下文 → `HANDOFF.md`

---

## 1. 时间线

### Phase 0–2（前情，摘要）
架构决策（三项核心：dsh 当骨架 / Hindsight 当记忆微服务 / 状态机自研）、Hindsight 接入与中文修复（换多语言模型）、dsh 侧「状态注入→语气变化」可行性验证。
详见 `CONCEPTS.md`、`docs/research/*-findings.md`。

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
| F | 「关于 A」vs「A 参与」切分 | 仍是**回避**（候选+确认） | `DESIGN_NOTES §2.5` |

> ✅ A/B/C/D 均已解决（遗忘改为工具 + 审批；子集选择已落地）。

---

## 4. 方法与纪律（我们定下的做法）

- **先探最大风险**（spike）：状态注入、事件/审计、写入可行性——都用小实验先证伪/证真，再铺开。
- **假设被推翻就改 `CONCEPTS.md`**，不硬撑实现（如「加会话事件」→ 改为自有审计落点）。
- **意图判定交给模型**（注册**工具**让 LLM 调用），不从用户消息里猜（遗忘已如此；写路径的「是否值得写」仍是启发式）。
  - ⚠️ **但别把「写」纯工具化**：LLM 主动写工具会**系统性漏调**（记忆静默不落库）。`turn/end` 的自动写**保留为兜底**，工具只作显式强化。
- **承诺必须兑现**：说「可恢复」就得有恢复**入口**（已加 `restore_memory` 工具，经审批）。
- **规则/意图写成显式数据**（`RULES` / `writeSkipReason`），配「为什么存在」注释与用例。
- **一切失败都降级、不阻断对话**，并落**自有审计**（`recall/retain/forget/audit .jsonl`）。
- **证据分层**：结论 → findings；原始输出 → artifacts；过程与坑 → 本文。
- **验证要结构性**：能读日志/文件的，别只靠「模型这么说」；能 curl 的，别只靠 UI。
- **脱敏**：全仓对照 `.sanitize-patterns`；`.env`/`.dsh` 永不入库；测试用合成数据。
- **小步提交**：gitmoji + conventional commit，全部 GPG 签名。
