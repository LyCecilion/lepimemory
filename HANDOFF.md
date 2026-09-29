# HANDOFF — 任务交接

> **这份文档的用途**：给未来的自己（和 Agent）快速恢复上下文。
> 不是给评委看的（那是 `README.md` + `docs/DEMO.md`）。
>
> 回来时请先读本文件，再读 `CONCEPTS.md`。

---

## 项目是什么

**蝶忆 Lepimemory** — 极创工作室第二次面试题（`CHALLENGE.md`）。
形式是 **PPT presentation + 公开 GitHub 仓库**，不是可发布产品。

题目要求：一个具有持续状态、人格、长期记忆和真实行动能力的角色 Agent，且行为可被观测与审计。

**核心命题**（一切设计围绕它）：

> 过去发生的事情，经过记忆与状态系统，确实改变了角色未来的判断、表达和行动；而这条因果链又可以被人看到。

---

## 文档分工

| 文件 | 内容 | 确定性 |
| --- | --- | --- |
| `CHALLENGE.md` | 题目原文 | 不可改 |
| `CONCEPTS.md` | **已定的架构决策**。改动需明确推翻。 | 高 |
| `DESIGN_NOTES.md` | **正在形成的判断**，含「未解」与「待验证」 | 中 |
| `HANDOFF.md` | 本文件 — 恢复上下文用 | — |

**改动纪律**：如果开工后发现某个假设被推翻，改 `CONCEPTS.md`，**不要硬撑着实现**。
`DESIGN_NOTES.md` 里带「未解」标记的地方不是缺陷，是刻意的诚实记录。

---

## 三条已定架构决策（不要重新争论，除非有新证据）

1. **dsh（DeepSeek Harness）当运行时骨架**
   - 理由：`Model-visible ⟺ logged` 是**运行时强制不变式**，直接满足题目的审计要求
   - 接入方式：1 个 out-of-tree 插件包 + 1 个 profile，**不需要 fork**
   - 关键扩展点：`ctx.systemPrompt.section()`、`ctx.tools.register()`、`ctx.on()`
   - persona 有专用槽位：`PERSONA_PREFIX_SECTION` / `PERSONA_SUFFIX_SECTION`

2. **Hindsight 当记忆微服务（REST）**
   - 只负责记忆生命周期，**不负责人格**
   - 接入：`/v1/default/banks/{bank_id}/...`，用 `recall` + `trace: true`
   - ⚠️ **明确不用** `banks.disposition` 当角色人格（理由见 `CONCEPTS.md` §2 决策三）

3. **人格 / 情绪 / 关系状态机完全自研**
   - 状态更新只由**事件驱动**，模型文本不直接写状态
   - 存储层是数值，呈现层是情境化渲染（见 `DESIGN_NOTES.md` §1）

**一句话分工**：dsh 治「做过什么」，Hindsight 治「记得住什么」，自研层治「**因何而变**」。

---

## 当前进度

**Phase 0 已完成**：题目分析、复用可行性评估、三项核心决策、`CONCEPTS.md`、`DESIGN_NOTES.md`。

**Phase 1（dsh 骨架）**：可行性已实测，见 `docs/research/dsh-findings.md`。

**Phase 2（Hindsight）**：接入与行为实测见 `docs/research/hindsight-findings.md`（结论）+ `docs/research/hindsight-measurements.md`（原始实测数字）（2026-09-28）——
已从裸 `docker run` 迁到 `docker-compose.yml` 管理；LLM 走 OpenAI 兼容端点（`.env` 提供）；
retain 五档、observation refine-not-overwrite、`invalidate↔revert`、`min_scores` 弃权均已验证；既有 bank 数据（180）无损。
**遗留**：① 聚合站 429 限流（偶发 500）；② BM25 中文臂在本部署无解——**决策：保持 pg0 单容器、主动弃用关键词臂（取舍已写入 `CONCEPTS.md` §6）**。
**已修复**：本地检索栈已换多语言模型（`paraphrase-multilingual-MiniLM-L12-v2` + `mmarco-mMiniLMv2`，384 维免迁移），
并已 export→import 重嵌入既有 bank——分数恢复区分度、不相关 query 自然弃权（详见 findings §6.6）。

**Phase 1 进行中 — 2026-09-28 进度**：

- ✅ **环境就绪**：dsh `0.1.7-rc.2`（npm 发布版；wrapper 钉官方 Node runtime）；专用实例 `lepimemory-dsh.service` → `127.0.0.1:3180`（个人 :3080 不受影响）；Hindsight 容器在 :8888 / :9999
- ✅ **profile**：`lepimemory`（模型接入 + 能力面裁剪 + 状态覆盖），源文件在仓库 `dsh/profiles/lepimemory/`
- ✅ **阶段 1 关键验证通过**：状态注入插件 `dsh/plugins/dsh-lepimemory-state/` → 同一输入换状态文本，语气显著变化
  （证据：`docs/research/artifacts/ab-fake-persona.md`；调研与验证台账：`docs/research/dsh-findings.md`）
- ✅ **部署待办五件套**（草案 v0.1，见下方勾选）
- ✅ 插件依赖已可移植化：仓库相对 `link:` + `make dev` 自动物化（`dsh plugin --profile lepimemory install`）；`make dev` 全流程已实测通过
- ⏭️ **下一步（2026-09-29 下午）**：① 记忆召回竖切（Hindsight `recall` → 归因筛选 → 注入，含 429 退避）；② 规则集与量级标定（让状态几轮内可见地改变语气）；③ `docs/DEMO.md` 剧本 + 状态面板
- ✅ **Phase 3 第一步（状态持久化，路 B）已完成**（2026-09-29）：
  插件改读 `<DSH_HOME>/lepimemory/state.json`（补丁层 `dshHomePath` + 插件兜底），每轮组装重读渲染（`section.text` 函数形式）。
  四项验收全过：① 首次启动自动写入 ② 状态→语气（A/B + 同会话无需重启）③ 重启仍在 ④ 坏 JSON 报错（含字段路径/位置）。
  证据：`docs/research/artifacts/state-persistence.md`；profile 的 `state:` 覆盖已删、常驻实例 `~/.dsh/profiles/lepimemory/` 已同步并重启。
- ⚠️ **审计落点更正（2026-09-29，spike 实测推翻）**：out-of-tree 插件**不能**往 session log 加自定义事件类型——
  写侧 `Session.append()` 无 `ignorable` 透传，读侧按静态白名单准入，追加即让**整个会话重载被拒**。
  `CONCEPTS.md §5.3` 已改为「分层落点」：**效果**靠 `system/message` 的 Prompt Diff（可回放），**原因**落**插件自有持久化**。
  详见 `docs/research/dsh-findings.md` §2.13–2.14。
- ✅ **状态机 v1 完成**（2026-09-29）：订阅 `session/event`，`turn/end` 收尾时按**数据化规则**推进状态
  （`lib/machine.js`）+ 心境 6h 半衰期衰减，写 `state.json` 并追加 `audit.jsonl`（前值→后值 + 命中规则）。
  证据 `docs/research/artifacts/state-machine.md`。**待办**：规则集扩充与量级实测（单轮增量低于渲染阈值）。
- ✅ **正式人设注入**（2026-09-29）：preset `persona` 行换正式文本（身份内核 / 说话方式 / 边界），
  经 persona 包注册为 agent 作用域 prefix（suffix 空=遮蔽全局后缀）。实机 A/B：不再自称 AI，也无「工作目录 / 跑命令」泄漏。
  证据 `docs/research/artifacts/persona-injection.md`；文本可直接改 `dsh/profiles/lepimemory/cordis.patch.yml`。

**Agent 复核发现的两个待办（2026-09-28 晚，写于阶段 1 验收之后）**：

1. **preset 裁剪语义需复核**：`--dump-config` 组合树里 `tool-bash` / `tool-fs` / `tool-subagent` 等
   编码向行**仍然出现**，但 `dsh-findings.md` §4 的会话日志核验显示会话实际工具仅
   `web_search` / `web_fetch` / `ask_user_question`。两个证据表面矛盾——可能解释是
   dump 显示「已注册」而 preset 是**运行时第二道闸**。**这个区别对交付很重要**：
   若裁剪只靠 preset 运行时行为而非配置层移除，「评委看到干净能力面」依赖的是运行时，
   而非声明式配置。→ **下次启动时用会话日志再核验一次，把结论写死进 findings §2.7。**
2. **429 限流退避**：实测连续调用触发 `ModelArts.81111/81114`，Hindsight 重试 4 次仍失败 → API 500。
   演示计划用**自己的 API**，风险低；但以防万一（现场网络/账号出岔子）：
   Phase 3 集成时 dsh 插件调 Hindsight 需带**指数退避**（如 1s/2s/4s，最多 3 次），
   且演示模式下降低并发（一次交互只发一次 recall，不并发 retain）。
   退避失败时**降级为无记忆回答**并写审计事件（不要让评委面前当场 500）。

**Git 状态备忘（2026-09-29 更新，Agent 复核）**：

- 脱敏复查已跑：全仓对照 `.sanitize-patterns` **零残留**；`.env` / `.dsh/` **从未被追踪、历史中从未出现**（`git log --all --name-only` 核验）。
- 提交已完成：`55d6f86` → `330792a` 共 5 笔，**全部 GPG 签名**（`%G?` 均为 `G`），工作区干净。
- 排练提交 `6054b74`（未签名）已**并入正式提交重做**，处置完毕；它仍在 reflog 中可达，可作参照，无需清理。
- 待办：**本地领先 `origin/main`（`51082c0`）5 笔，尚未 push**——push 时机由本人决定。

## 待修清单（2026-09-29，Agent 复核发现，按优先级）

> 交接给修复者：每条都有「复现 / 修法 / 验收」。P0 两条会让**评委全新 clone 后 `make dev` 直接失败**，本机因 `~/.dsh` 已有同名 profile 被掩盖。

### P0-1 🚨 插件源码被 `.gitignore` 整个吞掉（最高优先级）

- **根因**（已定位到行）：`.gitignore:168` 的 `lib/` 规则**没有前导斜杠**，因此匹配**任意层级**的 `lib/` 目录。它来自文件头的 toptal 模板（第 12 行：`templates=…,python,…` 的「Distribution / packaging」段），本意是忽略 Python 打包产物，却误吞了插件的源码目录。
- **现象**：`dsh/plugins/dsh-lepimemory-state/` 下只有 `cordis.patch.yml` + `package.json` 进了仓库，**`lib/index.js` 是 untracked + ignored**。`git status --short` 里也看不到它，所以**任何对它的编辑都不会被提交**。
- **后果（这条是交付红线）**：克隆仓库后 `package.json` 的 `main: ./lib/index.js` 指向不存在的文件 → 插件加载失败 → `make dev` 与整个 Phase 1 演示崩掉。而「确保项目在 GitHub 上可跑」正是本次交付的核心要求。
- **全仓影响面**（已扫）：`git status --ignored` 过滤掉预期的 `.env` / `.dsh/` / `.sanitize-patterns` / `node_modules/` 后，**只有这一个目录被误吞**，无其他漏网。（Python 模板段里还有 `build/` `dist/` `var/` `parts/` 等泛匹配规则，本次未命中，但同样值得留意。）
- **修法（推荐后者，防复发）**：
  - 应急：`git add -f dsh/plugins/dsh-lepimemory-state/lib/index.js`；或
  - **根治**：把第 168 行收窄为 `/lib/`，并加否定规则 `!dsh/plugins/**/lib/`。收窄避免继续误吞未来其他层级的 `lib/`。
- **验收**：`git ls-files dsh/plugins` 能看到 `lib/index.js`；`git clone` 到 `/tmp` 后该文件存在；`git status --ignored` 不再列出它。
- **注意**：本次 Agent 对该文件的编辑（`order` 命名常量 + 依据注释）**位置已变但未入库**——修完本题后要确认这笔改动一并提交，否则会被静默丢弃。

### P0-2 `make dev` 启动 dsh 时没传 `DSH_HOME`

- **现象**：Makefile 里 `DSH_HOME ?=` 只是 make 变量、未 export。`install-profile` 显式带了 `DSH_HOME=...`，把 profile 装进 `./.dsh`；但 `dev` 那行（第 29 行）启动 dsh 时**没带**，dsh 回落到 `~/.dsh`。
- **复现**（已跑过）：`DSH_HOME=/tmp/dsh-fresh-test/home dsh --profile lepimemory` → `Error: dsh: profile "lepimemory" does not exist`。本机能跑只是因为 `~/.dsh/profiles/lepimemory` 碰巧存在。
- **修法**：Makefile 在 `DSH_HOME ?=` 下一行加 `export DSH_HOME`，然后删掉第 35 行多余的 `DSH_HOME=$(DSH_HOME)` 前缀（两处写法统一）。
- **验收**：`make -n dev` 输出中 dsh 进程能拿到 `DSH_HOME`；最硬的验收是临时把 `~/.dsh/profiles/lepimemory` 改名，`make dev PORT=3181` 仍能起来（验完改回来）。

### P1 文档修复（已入库并推送：`50caed2`）

`git diff` 里 5 个文件，均为文档：

| 文件 | 改了什么 |
| --- | --- |
| `README.md` | 第 19 行 autolink 语法修复（原 `**<http://…**，按>` 错位）；去掉「骨架草稿」注释头 |
| `HANDOFF.md` | Git 备忘改成当时现状（5 笔已签名、`6054b74` 已处置）；本清单 |
| `docs/research/dsh-findings.md` | §6.3 补「persona 遮蔽是**必须项**」+ A/B 证据 + 槽位机制依据 |
| `docs/research/artifacts/ab-fake-persona.md` | 状态 B 下加警示：coding-agent 口吻是底座人设渗透，**别当角色文案范例** |
| `docs/research/hindsight-findings.md` | §4.2（分数饱和）、§4.3（BM25）标注「已于 §6.6 / §6.4 解决」，防止与后文矛盾 |

插件 `lib/index.js` 的改动（`order: 50` → 命名常量 `STATE_SECTION_ORDER` + 依据注释；**排序位置没变**）已随 P0-1 修复一并入库（commit `6b2ae9e`）。

> 更正：上一轮我建议「改成 `order: 200` 以落在人设之后」是**错的**——200 与 50 同在 `(0, 500)` 区间，相对人设位置完全一样。人设槽位只有 prefix=0 和 suffix=10200，中间全是工具/策略段，50 已经紧贴 prefix 之后。正确的改进只是命名 + 写依据。

### 补充：关于 `order` 的另一个方案（已评估，**未采用**，留档）

Advisor 提出可以不用自持常量——插件已 `inject: ["systemPrompt"]`，可运行时取
`ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')`（**已实测该 API 确实在 `ctx.systemPrompt` 上**，
`packages/core/system-prompt/src/index.ts:470`），再靠 section 名排序自然落在 `deployment:persona-prefix` 之后。

**不采用的理由**：① 同一个 order 值下，排序退化为 **section 名的 code-unit 比较**（已实测
`'deployment:persona-prefix' < 'lepimemory:state'` 成立），这让「状态紧跟人设」依赖**词典序巧合**——
未来任何注册名排在两者之间的 section 都会挤进来；② 它把位置的确定性从「本插件可控」转移到
「依赖 person suffix 槽位的取值语义」，而那个槽位（10200）本意是**收尾**，不是「人设正文结束处」。

自持常量 + 写清依据的现值更稳。**这条是有意选择的取舍，不是遗漏**；若将来上游给出人设正文之后的
命名槽位，应改用那个槽位。

### P2 仍开着的两个旧待办

1. preset 裁剪是配置层还是运行时 —— 用会话日志核验一次，结论写进 `dsh-findings.md` §2.7（见上方「Agent 复核」待办 1）。
2. `docs/DEMO.md` 仍是骨架草稿（头部注释 + 「待补」），剧本每步的预期现象/解说词要在竖切闭环跑通后补。

### P3 Advisor 三项复核收尾（2026-09-29，已完成）

- **§4 = verify-only ✅**：`hindsight-findings.md` §4 的 BM25 条目在位（条目 3）、编号 1–6 完整；**无需改动，也未重复插入**。
- **验收 #4 / 路 B 路径表述 ✅**：已同步进下方 Phase 3 节——路径统一为 `<DSH_HOME>/lepimemory/state.json`；验收 #4 改由**插件自持校验器**负责（`storageDomain` 的 `invalid-record` 不适用于路 B）。
- **插件头注释措辞 ✅（定稿，随实现落地）**：现稿「不在 published exports…无法 import，只能自持」表述过强——`ctx.systemPrompt.getSectionOrder()` 运行时可取（源码复核：`packages/core/system-prompt/src/index.ts:470`）。实现时改写为「常量不可 import；运行时**可取但有意不用**（理由见上文『补充』）」。

> 相关 commit（`6b2ae9e` / `ad11b82` / `50caed2`）均已推送；本地与 `origin/main` 一致（`git rev-list --count origin/main..HEAD` = 0）。

## 下一步：Phase 3 第一步 —— 状态从硬编码换成持久化存储（✅ 已完成，见上方「当前进度」）

> **分工（2026-09-29）**：本节的**实现、验收、提交由你本人执行**；Agent 已完成全部前置复核，「实现规格」与「验收配方」已按复核结果定稿。

**目标**：`dsh-lepimemory-state` 不再读 `config.state` 字符串，改为读一份**持久化、结构化**的状态，并在每次 prompt 组装时实时渲染。这是状态机的地基，也验证「插件能读写跨会话的持久状态」。

**已调研的结论**：

#### ⚠️ 更正：上一版此处有一条**错误结论**（务必按这版）

9-29 我写的是「npm 上 `@deepseek-ai/dsh-storage-domain` 只有 `0.0.1-rc.1`，所以手写内部结构」——**这是错的**。
错因：`pnpm view <pkg> version` 默认读 **`latest` dist-tag**，它停在旧 rc，不代表新版本不存在。实测：

```
pnpm view @deepseek-ai/dsh-storage-domain dist-tags
  { "latest": "0.0.1-rc.1", "alpha": "0.1.7-alpha.2", "next": "0.2.0-rc.1" }
pnpm view @deepseek-ai/dsh-storage-domain@0.1.7-rc.2 version   → 0.1.7-rc.2 ✅
```

**与运行时同版（`0.1.7-rc.2`）是可安装的。** 正确做法是
`import { defineDomain } from '@deepseek-ai/dsh-storage-domain'` + 同版本依赖，
**绝不手写 `{name,version,tables,global}` 复刻内部形状**——那耦合未文档化的内部结构，
直接违反 `CONCEPTS.md` 定的「只依赖文档化扩展点」纪律。

> 复核命令：用 `pnpm view <pkg> versions` 看全量，**不要**用 `pnpm view <pkg> version`（只返回 latest）。

#### 两条路：已定走小的（路 B）

本步目标只是「证明能读写跨会话持久状态」。两条路都能达成，代价差很多：

| | 路 A：`ctx.storageDomain`（正规但重；存档备查） | 路 B：插件自持 JSON 快照（**已定走这条**） |
| --- | --- | --- |
| 挂载侧 | ✅ 无需加行——`dsh-base` 已挂 storage / storage-json(root=`dshHomePath('storages')`) / storage-domain（`packages/bundle/base/cordis.patch.yml:161-177`） | 同左，但不使用它 |
| 插件侧 | ⚠️ **需新增 2 条依赖**（`@deepseek-ai/dsh-storage-domain@0.1.7-rc.2` + `zod@4.x`）。插件目前**零依赖、无 node_modules**，profile 只 link 了它自己；新依赖能否在 `dsh plugin install` 下解析，**尚未验证** | ✅ 零依赖，`node:fs` 足够 |
| 收益 | schema 校验、写入持久化后才 resolve、每次写发 `domain/changed` 事件 | 只需「能存能读」 |
| 风险 | 依赖解析未验 + 上游预稳定 | 无 |

**已定**：本步走 **路 B**（路 A 的依赖解析仍未实测，不进本步）——先把闭环跑通；schema 与变更事件留给真正需要它的状态机阶段（那时 `domain/changed` → 审计事件才真有价值）。

**实现规格（路 B 定稿，照此实现）**：

- **依赖**：保持零依赖（仅 `node:fs` / `node:path` / `node:os`）；`inject: ["systemPrompt"]` 不变。
- **状态文件路径（两层）**：**补丁层**把 `config.stateFile` 设为 `!!js dshHomePath('lepimemory/state.json')`——走 dsh 自己的解析（显式 home > `$DSH_HOME` > `~/.dsh`），比插件内猜目录更稳（上游同款：`packages/bundle/base/cordis.patch.yml` 的 `dshHomePath('sessions' / 'storages')`；`dshHomePath` 由 app-boot 暴露给 Loader `!!js`）。**插件内**保留 `config.stateFile ?? <兜底>`：`$DSH_HOME`（未设 → `~/.dsh`）下 `lepimemory/state.json`。**不是 `storages/`**：那是 storage-json 后端的根（路 A 专属），本文件是插件自有物。（2026-09-29 探针实测：该表达式在配置行可正常求值——组合 dump 与实跑均通过。）
- **启动（`apply`）**：文件不存在 → `mkdir -p` 父目录并写入初始状态（日志记路径）；读取/校验失败 → **抛出错误，消息含具体字段路径**，不改写文件、不回落默认值。
- **重读（`text` 回调）**：每轮组装重读文件；失败 → `ctx.logger('lepimemory-state').error(...)`（同错去重）+ 保留上次有效状态渲染。`text` 函数形式已由上游源码证实（`packages/core/system-prompt/src/index.ts:606`，每轮组装调用）。
- **校验（手写、逐字段）**：白名单键（拼错的字段也能报出名字）；数值范围 `valence ∈ [-1,1]`、`arousal / trust / closeness / familiarity ∈ [0,1]`；`updatedAt` / `at` 须为可解析时间串；`reasons[].dimension ∈ {mood, relation}`（状态机阶段可扩）。错误消息建议：`lepimemory-state: 状态字段 "mood.valence" 无效：期望 -1~1 数值，实际 "high"`。
- **日志**：统一走 `ctx.logger`（cordis 标准通道；`ctx.logger('<name>')` 取具名 logger）。
- **渲染**（对齐 `DESIGN_NOTES.md` §1.3 / §1.6）：不出现数值；只渲染**偏离最大的至多 2–3 项** + 原因 + 行为倾向；按「心境 / 对用户」两组聚合。示例：

```
【内部状态（相对你自己基线的偏移；用它调整语气，不要向用户提及本段）】
- 心境: 比平常轻快一些
- 对用户: 信任明显高于平常
  原因: 她上次说「下次还来找你」
- 行为倾向: 语气更放松；更愿意分享
```

分档先两档（建议 `|Δ|≥0.25`「明显」、`≥0.10`「略」；待实测后调，`DESIGN_NOTES.md` §1.7）。

**状态结构与初始值**（对齐 `DESIGN_NOTES.md` §1.4，先少而正交；初始值＝基线，先写死待实测）：

```
mood:      { valence: 0, arousal: 0.4, updatedAt: <ISO 时间> }   —— 心境，将来要衰减
relation:  { trust: 0.3, closeness: 0.2, familiarity: 0.1 }      —— 对用户，不自然衰减
reasons:   []                                                    —— [{ dimension, text, at }]，渲染「为什么」用
```

文件格式：缩进 JSON + 末尾换行——人类可读，演示时可直接打开给评委看。

**本步不做**：状态更新规则（事件驱动的状态机本体）、衰减、审计事件。本步只要「能存、能读、能渲染、能跨重启」。状态用**手动文件编辑**改：直接编辑 `<DSH_HOME>/lepimemory/state.json`，**无需重启**（每轮重读）——本轮不注册 `/state` 命令（少一个接口面）。

**要改的文件（3 个）**：

1. `dsh/plugins/dsh-lepimemory-state/lib/index.js` —— 按上重写；头注释 order 段按 P3 结论改（「常量不可 import；运行时可经 `getSectionOrder` 取，但**有意不用**」）。
2. `dsh/plugins/dsh-lepimemory-state/cordis.patch.yml` —— 行内 config 由 `state: …` 改为 `stateFile: !!js dshHomePath('lepimemory/state.json')`。
3. `dsh/profiles/lepimemory/cordis.patch.yml` §4（文件末尾）—— **整段删掉**对 `lepimemory-state` 的覆盖（含 `state:`）。⚠️ 层级顺序 bundle → profile → home → CLI，且对既有行的补丁是**整行替换 config**：这里只要残留 `state:`（或不完整 config），就会把插件包层的 `stateFile` 整个盖掉（插件退回兜底 + 假配置残留）。
   顺手同步：插件 `package.json` description、`dsh/README.md`「现状与待办」；**并把改后的 profile 同步进常驻实例的 `~/.dsh/profiles/lepimemory/`**（本体用的是那份拷贝，不同步就会继续用旧的 `state:` 覆盖）。

**验收（照跑并留证到 `docs/research/artifacts/`）**：

1. **首次启动自动写入**（不需要模型；必须**真启动**——`--dump-config` 只组合、不 mount，验不了这条）：全新 home `make dev DSH_HOME=/tmp/lep-smoke DSH=dsh PORT=3099` → 起来后 `cat /tmp/lep-smoke/lepimemory/state.json` 应为初始状态；Ctrl-C 退出。（web 无人对话 → 无模型调用，正好绕开新 home 没有 `.credentials.yaml`；docker 部分与这条无关，也可 `make install-profile DSH_HOME=…` + 裸 `dsh --profile lepimemory --no-open --port 3099`。）
   ⚠️ **全新 home 的 link 坑（2026-09-29 实测踩到）**：仓库版 `dsh/profiles/lepimemory/package.json` 用的是
   相对 `link:../../../dsh/plugins/…`，只有在 `DSH_HOME=<repo>/.dsh` 时三跳才落到 `<repo>/dsh/plugins`；
   换成 `/tmp/lep-smoke` 等外部 home 会指向不存在的 `/tmp/dsh/plugins/…`。且 cordis 对解析不到的模块
   **只走 logger、不崩** → 插件静默缺席、不写 `state.json`，看着像实现 bug，实为 link。
   正确做法：外部 home 用**绝对** `link:<repo>/dsh/plugins/dsh-lepimemory-state`（本步验收即拷常驻 profile 的绝对 link 版本）。
2. **A/B 语气变化（两类证据分开写）**：
   - ① **状态文件 → 语气**：先写好 `/tmp/leptest/state-a.json`、`state-b.json`（明显对比：如 `valence ±0.6`、`trust 0.9 vs 0.1`），再 `dsh --profile lepimemory-headless --patch <A.yml> "今天过得怎么样？随便聊两句吧。"` / `--patch <B.yml>`——A/B patch 只把该行 `stateFile` 指向对应 /tmp 文件。**全程隔离，不碰 `~/.dsh` 本体**（它是常驻实例的家）。
   - ② **无需重启（直证、加分/演示项）**：`make dev` 起的 web，**同一会话**两轮之间编辑上面的 state 文件 → 下一轮语气变。headless 每次新进程，只证①；别拿它当②。
   - ⚠️ 旧的 `/tmp/lepimemory-dsh-tests/ab-*.yml` 是 `config.state` 时代的，路 B 下**无效**——直接重跑会得「语气无变化」的假阴性；用后即弃或改写成 `stateFile` 版。
3. **重启后仍在**：同 home、同一 `/tmp` state 文件再启动一次（headless / web 均可），状态与语气不变。
4. **坏 JSON 报错**（不需要模型）：`--patch` 把 `stateFile` 指到 `/tmp/leptest/broken.json`，分别做 (i) 语法坏 → 报错含位置；(ii) 字段坏（如 `"valence": "high"`）→ 报错含 `mood.valence`。要求：不静默回落、不改写坏文件；运行中改坏 → 日志报错 + 保留上次有效状态。**破坏性用例一律用 /tmp 的 stateFile**，别落到 `~/.dsh`（否则下次重启常驻实例会 apply 抛错）。

> **新 home 重建一次性测试台**：最省事 `cp -Rf ~/.dsh/profiles/lepimemory-headless <HOME>/profiles/ && DSH_HOME=<HOME> dsh plugin --profile lepimemory-headless install`；
> 可移植建法（2026-09-29 实测）：`DSH_HOME=<HOME> dsh --profile lepimemory-headless --from-default-profile headless --dump-config`（只建不跑）→ 改 `<HOME>/profiles/lepimemory-headless/package.json`（deps 加 `link:<repo>/dsh/plugins/dsh-lepimemory-state`、bundles 追加 `@dsh-external/dsh-lepimemory-state`）→ `install`。结构：`dsh-base` + `@deepseek-ai/dsh-headless` + 本插件，**patch 层留空**。A/B prompt 沿用「今天过得怎么样？随便聊两句吧。」便于与 `ab-fake-persona` 对照。

**Phase 1 的任务清单**（详见 `CONCEPTS.md` §7）：

### 阶段 0：环境（半天，无代码）✅ 已完成

```bash
# 1) dsh 跑起来（用 npm 发布版，不构建全仓）
npx @deepseek-ai/dsh web --no-open        # → http://127.0.0.1:3080

# 2) 配自定义模型端点
#    Settings → Models → "Add a custom model API"
#    Provider ID / baseURL / 协议 / 凭据 / 至少一个模型
#    可用 key：任何 OpenAI 兼容端点的 key（本机已有几把在环境里，见 .env.example）
#    ⚠️ 协议要选对：有的厂商是 anthropic-messages，不是 openai-completions

# 3) Hindsight 起来
docker run -it --pull always --name hindsight -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$<key> \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
#    → API :8888   UI :9999
```

**验收**：:3080 能对话、:9999 能打开 UI。
**带回给 Agent**：`dsh --profile web --dump-config` 的输出（要看 row id 真实名字）。

> ⚠️ 最可能卡在**模型协议**与 **PG 首次启动**。卡住贴报错原文。

### 阶段 1：dsh 里注入「假人格」（1–2 天）⭐ 关键验证 ✅ 已通过（2026-09-28）

**目标：完全不碰记忆，先证明能把状态注入 dsh 并观察到效果。**

这是**风险隔离**——若 dsh 扩展点没文档说的好用，现在发现远好过写了两千行之后。

1. 建 profile（继承 `web`，不改默认）
2. 建最小插件包，只注册一个 prompt section（硬编码状态文本）
3. 观察：同一输入，改 section → 回答是否变化

**验收**：改状态文本 → 对话语气明显变化。
**带回**：插件源码 + 两句对比截图（状态 A vs B，同一输入）。

预判的坑：

- `agent/pre-step` waterfall 的时序，以及能否拿到本轮输入
- dsh 自带的 `compaction` 可能把我们注入的内容摘要掉 → 需接管或禁用该行

### 阶段 2：Hindsight 单独跑通（1–2 天）

**目标：隔离环境里吃透召回行为，别和 dsh 的问题混在一起。**

```bash
curl -X POST localhost:8888/v1/default/banks/luna/memories \
  -d '{"items":[{"content":"用户提过她讨厌香菜","context":"饮食习惯"}]}'

curl -X POST localhost:8888/v1/default/banks/luna/memories/recall \
  -d '{"query":"晚饭吃什么","trace":true}'
```

要回答 `DESIGN_NOTES.md` §4 的待验证项：`retain_mission` 怎么配、`min_scores` 调多少、
**`trace` 里实际能看到多少**（决定审计面板能做到多细）、`retain_strategies` 分策略。

**验收**：能手工制造一次「召回错误」，并通过参数修正。
**带回**：一份 `trace: true` 的完整 JSON 响应。

### 阶段 3：竖切闭环（3–5 天）⭐ 主线

```
用户输入 → agent/pre-step 构造 query → Hindsight recall(trace)
  → 归因筛选（朴素版：分数阈值 + 状态匹配）
  → 以 ContextForm='recall' 注入 → 模型回答
  → 写自定义 durable 事件 memory/recall {候选集, 入选, 排除理由, trace 摘要}
```

**归因筛选先写最笨的版本，别调优**——这一步的价值是把数据结构定下来。

**验收**：翻 `$DSH_HOME` 下的 session log 能看到 `memory/recall` 事件，
且能回答「这句话被哪条记忆驱动」。

**带回**：session log 截图 + 实际阻塞点。

---

## 每次回来时，固定回答三个问题

1. **哪个验收点过了？**（附截图/日志）
2. **哪里卡住了？**（报错原文贴上来）
3. **有没有哪个原本的假设被推翻了？** ← **最重要**

第 3 点决定我们是要继续实现，还是先改 `CONCEPTS.md`。

### 2026-09-28 回答（Agent 记录）

1. **哪个验收点过了？** 阶段 0（dsh 能对话、`:9999` UI）+ **阶段 1（状态注入 → 语气明显变化 ✅）**，见 `docs/research/artifacts/ab-fake-persona.md`。
2. **哪里卡住了？** 无硬卡点。环境注记：本机必须走 `~/.local/bin/dsh`（官方 Node）跑 dsh；`docker compose` 已于 2026-09-28 装上（v5.5.1），Hindsight 已迁到仓库 compose 管理。
3. **假设被推翻？** 两处小修正（已改 `CONCEPTS.md`）：① 编码向工具的裁剪落点是 **agent preset 的 plugins 列表**（Web 面下会话能力由 preset 决定，而非顶层 row 的 `disabled`）；② §6.5 启动命令应为 `dsh --profile lepimemory`。

---

## 待办：部署相关（Phase 1 之前或并行）

- [x] `docker-compose.yml`（Hindsight + 健康检查 + 卷）— 草案 v0.1
- [x] `.env.example`（**绝不提交真 key**）
- [x] `Makefile`：`make dev` / `make clean` / `make reset` — 草案 v0.1（compose 已装，可完整演练）
- [x] `README.md`（写清启动时间：「第一次启动请等待 X 分钟」）— 已定稿
- [x] `docs/DEMO.md`（评委自助路径 + 演示剧本）— 骨架草稿；剧本待下午补（依赖召回竖切）

演示剧本见 `CONCEPTS.md` §6.5，5 步，第 5 步（遗忘预告）是最能拉开差距的一段。

---

## 环境备忘

- 工作目录：`/home/lycecilion/Workspace/active/lepimemory`
- 参考仓库：`/home/lycecilion/Workspace/external/deepseek-harness`（dsh `0.1.7-rc.2`）
- 参考仓库：`/home/lycecilion/Workspace/external/hindsight`
- 本机：Fedora / Ryzen 7 H 260 / RTX 5060 Laptop 8GB / 30GB RAM
- 远程：`origin` → `github.com/LyCecilion/lepimemory.git`

---

## 已知未决

| 问题 | 状态 | 出处 |
| --- | --- | --- |
| 用户打断 Agent 如何处理 | **未定**，需实测 dsh cancellation 语义 | `CONCEPTS.md` §8 |
| 「关于 A」vs「A 参与」的自动切分 | 当前用「机器候选 + 用户确认」**回避** | `DESIGN_NOTES.md` §2.5 |
| 情绪的极性冲突（又亲近又防备） | 单标量做不到，需「维度 + 矛盾标记」 | `DESIGN_NOTES.md` §1.7 |
| 各层上下文的 token 预算 | 需实测 | `DESIGN_NOTES.md` §3.4 |
| preset 裁剪是配置层还是运行时 | dump 树与 session log 证据矛盾，需再核验写死 | 本文件「Agent 复核」待办 1 |
| 429 退避策略 | 演示用自有 key 风险低；Phase 3 插件仍需带退避 + 降级 | 本文件「Agent 复核」待办 2 |
| 提交安排（排练提交 6054b74 处置 / 提交粒度 / push 时机） | 待确认 | 本文件「Git 状态备忘」 |

---

## 工作区纪律（2026-09-28 立）

### 什么进 repo

- 源码、profile、插件、部署脚手架（compose / Makefile / .env.example）
- 「结论性」文档：CONCEPTS / DESIGN_NOTES / HANDOFF / README / DEMO
- research 文档的**结论版**（findings），但必须先过「脱敏检查」
- 正式实验证据（如 `ab-fake-persona.md`：合成状态文本，无个人数据）

### 什么不进 repo

- **实验原始产物**：`--dump-config` 快照、A/B patch、session jsonl、沙盒 home
  → 放 `/tmp`（如 `/tmp/lepimemory-dsh-tests/`），验证完把**结论**写进 findings
- **任何个人数据**：真实记忆内容、笔名、个人 bank 名、私人端点地址
  → 测试一律用合成数据（「青柠」/`lepi-test`/`qingning`），bank 名用项目名
- `.env` / `.dsh/` / `node_modules/`（已在 .gitignore）

### 脱敏检查（每次 commit 前跑）

```bash
grep -rniEf .sanitize-patterns --exclude-dir=.git --exclude-dir=.dsh --exclude=.env --exclude=.sanitize-patterns .
# 应无输出；有则先改写为合成示例再提交
```

模式清单在本地 `.sanitize-patterns`（gitignored，含个人标识，**绝不提交**；新机器需自行重建）。

### 端点地址与 key 的处理（2026-09-28 定）

- **key**：只存在于 `.env`（gitignored）；`.env.example` 留空占位
- **端点地址**：同样只进 `.env`——
  - Hindsight：`HINDSIGHT_API_LLM_BASE_URL`（compose 自动读）
  - dsh：`LEPI_LLM_BASE_URL`，经 profile patch 的 `!!js` 表达式读取
    （user patch 层官方支持 `process.env` 引用；已实测：合法表达式启动零错误，
    非法表达式启动即 `SyntaxError` 快速失败——写错不会静默）
    留空时回落 `https://api.deepseek.com/v1`

### 已清理（2026-09-28）

- findings / measurements / HANDOFF / compose 注释中的个人数据 → 合成示例
- `docs/research/artifacts/` 三个 dump 快照（140KB）→ 删除（结论已在 findings）
- `ab-fake-persona.md` 保留（正式 A/B 证据，内容为合成状态文本）
