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
- ⏭️ **下一步**：竖切闭环（阶段 3，把 recall 接进 dsh）＋ 自研状态机（状态注入接到 `dsh-lepimemory-state` 的 section 上）

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

**Git 状态备忘（2026-09-28 23:10，Agent 记录）**：

- 今晚 22:56–23:05 完成公开前脱敏与「工作区纪律」建制（见下方专节）；全仓对照 `.sanitize-patterns` 扫描**无残留**；端点与 key 全部收进 `.env`。
- 22:59 曾有一次**提交排练**：`6054b74`（12 个基础设施文件，未 GPG 签名），38 秒后 reset 回工作区。**处置待确认**——建议：并入文档改动重做一笔完整提交（并 GPG 签名）；`6054b74` 留在 reflog 可作参照。
- 当前 `HEAD`=`816ee5e`（未推送）；`origin/main`=`51082c0`；**全部工作未提交、未推送**。
- 明天顺序建议：① 脱敏复查（命令见「工作区纪律」）② 确认提交安排 ③ 提交（GPG 需本人在场解锁）④ push 到 GitHub。

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
- [x] `README.md`（写清启动时间：「第一次启动请等待 X 分钟」）— 骨架草稿，待定稿
- [x] `docs/DEMO.md`（评委自助路径 + 演示剧本）— 骨架草稿，待定稿

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
