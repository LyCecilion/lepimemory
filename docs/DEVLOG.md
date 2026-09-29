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

### Phase 3（本阶段详录；分支 `exp/state-persistence`）

> 全程用 `exp/` 分支；提交带 gitmoji 的 conventional commit；每条改动都留 `docs/research/artifacts/` 证据。

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
7. **host 注册 ≠ 会话可见** `[未决，做行动工具前必查]`
   现象怀疑：bundle（host 面）注册的工具未必进入 preset 会话的工具面（findings §2.7：web 会话能力面由 preset 决定）。
   处置：做「行动工具」前，先验证 host 注册的工具是否出现在会话 `request/header.tools`；否则要**新增 preset 级插件行**。

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
11. **遗忘误抑制 + 言行不一** `[已修]`
    现象：v1 把 recall 候选**全**抑制 → 连带「讨厌香菜」被删，而角色嘴上说「只抑制第 1 条」。
    处置：只抑制**文本提到目标**的候选；把 `selected` 写进计划与审计。
12. **遗忘确认渠道** `[已修]`
    现象：角色倾向用 `ask_user_question` 工具确认，而工具答案**不是**普通用户消息 → 我们收不到确认。
    处置：计划 notice 明确「在普通回复里问确认，别用提问工具」。

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
| A | **遗忘确认匹配过宽**：以 `好/嗯/可以/行/ok` 开头即判「同意」 | 「嗯……对了，还有件事」会被误判为确认并 `invalidate` | 收窄为**明确整句**（如「确认忘掉」「确认执行」）；预览写明「可恢复（soft delete）」；给 `revert` 出路 |
| B | **`FORGET_RE` 任意位置匹配「忘记/忘掉」** | 「我永远不会忘记你」「别忘记我们的约定」→ 被当遗忘请求、挂起 pending，下一句「好」就可能真删 | 要求**祈使/指向性**（句首「忘掉/把 X 忘掉」或前置「请/给我/帮我」），排除前置否定（不会/永远不/不能/别） |
| C | **遗忘子集不可选**：confirm 对 `pending.ids` 全量执行 | 用户/模型只想删其中一部分时**过度删除**、模型陈述失实 | ①确认时回传所选 id/序号按选执行；②收紧候选门槛（现 `minSemantic 0.2` 偏松） |
| D | **工具可见性未验**（见坑 7） | 行动工具可能注册了但模型看不见 | 做行动工具前先验 `request/header.tools`；必要时加 preset 行 |
| E | 意图/确认仍是**正则** | 复杂表述识别不到 | 演示用直白措辞；长期工具化 |
| F | 「关于 A」vs「A 参与」切分 | 仍是**回避**（候选+确认） | 见 `DESIGN_NOTES §2.5` |

> ⚠️ **演示前务必处理 A/B**：一次口误/一句深情话就可能「删」记忆（虽可 revert）。优先级最高。

---

## 4. 方法与纪律（我们定下的做法）

- **先探最大风险**（spike）：状态注入、事件/审计、写入可行性——都用小实验先证伪/证真，再铺开。
- **假设被推翻就改 `CONCEPTS.md`**，不硬撑实现（如「加会话事件」→ 改为自有审计落点）。
- **规则/意图写成显式数据**（`RULES` / `writeSkipReason` / `detectForgetIntent`），配「为什么存在」注释与用例。
- **一切失败都降级、不阻断对话**，并落**自有审计**（`recall/retain/forget/audit .jsonl`）。
- **证据分层**：结论 → findings；原始输出 → artifacts；过程与坑 → 本文。
- **验证要结构性**：能读日志/文件的，别只靠「模型这么说」；能 curl 的，别只靠 UI。
- **脱敏**：全仓对照 `.sanitize-patterns`；`.env`/`.dsh` 永不入库；测试用合成数据。
- **小步提交**：gitmoji + conventional commit，全部 GPG 签名。
