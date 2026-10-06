# 记忆更新 / 冲突 与 信任档衰减（Lv2）——设计、取舍与实测

> **历史证据 · 非当前工作流**：本文是 2026-10-03 记忆更新/冲突与三档信任衰减的实测，源码位置为**当时位置**（现为 `src/trust.ts` 等），采样按原样保留。当前架构见 [docs/ARCHITECTURE.md](../../ARCHITECTURE.md) §5.1–§5.2。

> 2026-10-03。补齐 Lv2 记忆生命周期里两处缺口：**「更新 / 冲突」**（题目点名的「除了记住，还要考虑忘记和更新」）与**「事实·推断·经历」三档信任等级与差异化衰减**。
> 关联：当时实现见 `lib/trust.js` / `lib/hindsight.js` / `lib/memory.js`（现为 `src/trust.ts` 等）。

## 1. 更新 / 冲突：用 Hindsight 的原生 supersede，我们只做「取最新」+ 可观测

**机制（上游，已实测）**：Hindsight 的 consolidation 把新 facts 与既有观察（observation）对比，**refine-not-overwrite**——「先喜欢冷萃咖啡」+「改喝茶」会被合成一条
`用户曾…，现在…` 的观察，**保留旧理解**（`hindsight-findings.md` §2.6 / §3）。

**我们接的部分**：
- 读路径 recall 带 **`prefer_observations: true`**：冲突时**只返回观察（当前有效版本）**，不返回被它取代的原始事实——落地 `DESIGN_NOTES` §3.3「冲突取最新」。
- 审计 `recall.jsonl` 每条入选标注 `type`（world/experience/observation）与 `trust`，并记 `superseded: true`（本轮是否返回了「已更新的综合版本」）。
- 注入文本对观察标 **「（综合印象（已更新））」**，让角色知道这是更新后的版本。
- `forget` 的候选召回**相反**：`prefer_observations:false`——要看见被观察覆盖的原始事实，才能抑制它。

**实测证据**：
- 隔离 bank：写「我下周三去见一个重要的人」→「哦不对，改成下周五」→ consolidation 产出观察
  `用户计划于10月9日（下周五）去见一个重要的人（原计划为10月7日，已改期）。`
  `prefer_observations:true` 的召回**只返回这条观察**；`false` 时同时返回两条原始 world 事实（各带 `metadata.trust`）。
- 端到端：bench 会话里 `recall.jsonl` 出现 `superseded: true`，入选项 `type=observation`，注入的是观察正文。

## 2. 三档信任等级 + 差异化衰减

**档位**（`lib/trust.js`）：

| 档 | 来源 | 写入处 | 衰减 |
| --- | --- | --- | --- |
| `fact` | 用户明说 | `turn/end` 自动写（`origin:user-turn`） | 不衰减 |
| `experience` | 角色亲历（行动成功） | 行动工具成功后自动写（`origin:character-action`） | 不衰减 |
| `inference` | 角色自己的推断/印象 | **`remember` 工具**（模型调用，`origin:character-inference`） | **半衰期 14 天** |

写入时把档位写进 item 的 **`metadata.trust`**（Hindsight 的 `MemoryItem` 支持 `metadata`）；读取时 `trustOf()` 优先读 `metadata.trust`，缺失则按 `fact_type` 兜底（`experience`→experience，`world`/`observation`→fact）。

**为什么推断要衰减**：推断是模型产物，可信度低于「明说」与「亲历」；不复盘的旧推断会伪装成事实污染判断。衰减让被后续证据反复确认的推断（会被 consolidation 吸收成观察＝稳定）留存，孤立旧推断自然退场。

**读路径落地**（`attribute()`）：按档算**有效分** `semantic × decayFactor`（仅 inference 衰减，`mentioned_at` 起算），衰减后低于阈值 → 排除并记理由「推断档已衰减（×…）至阈值以下」；入选按有效分排序。`forget` 取候选用 `applyDecay:false`（要能看见目标记忆）。

**`remember` 工具**：由**模型**判断「这是一条我自己的推断」并调用；不是用户明说（那些自动记），符合「意图判定交给模型」的项目纪律。

## 3. 踩坑

**Hindsight 抽取以「用户视角」读内容**。角色写「我猜她压力大」会被抽取重写成「**用户**猜测她压力大」——因为 retain 语义默认是「用户告诉 agent 的事实」。修法：`remember` 让模型**用角色名成句**（「蝶忆觉得…」），抽取才忠实（实测：「蝶忆觉得她…」→ `这是蝶忆的推断`）。工具在 `content` 未含角色名时会兜底前缀。

**`metadata` 在观察上会丢、但 `tags` 会留**。原始 unit（world/experience）带 `metadata.trust`；consolidation 产出的观察 `metadata` 为空但**继承 tags**。我们的语义正好不依赖它：观察＝已确认的当前版本 → 按 fact 处理（不衰减）。

## 4. 验证（实测）

- **纯函数单测**（`trust.js` + `attribute()`，21 项全过）：档位解析、半衰期（14d→0.5、28d→0.25）、fact/experience 不衰减、推断老化被排除且理由正确、`applyDecay:false` 保留、`renderRecall` 标注（综合印象（已更新）/我的推断/我做过的事）。
- **Hindsight 集成**：真实客户端写 fact / inference，`metadata.trust` 往返正确；`type=world trust=inference` 的原始推断可被按档处理。
- **端到端**：bench 里模型实际调用 `remember`（`tool/call` 名 = `remember`，工具结果 `isError:false`）→ `retain.jsonl` 落 `origin:character-inference | OK`，内容即角色的推断（「蝶忆觉得…」）。
- **工具面**：会话 `request/header.tools` 含 `forget / remember / restore_memory / write_note`。

## 5. 诚实边界

- 推断档的**衰减演示**是靠合成的时间戳做的纯函数单测（无法等 14 天）；集成侧只证「立即写入 + 被判为 inference」。
- 三档里 **experience 档**沿用既有行动写路径（未新增代码），仅把 tag 迁到 `metadata` 并统一到 `trust.js`。
- 观察（observation）的档位一律按 fact（不衰减）——**这是刻意的**：被 consolidation 吸收即「被确认」。
