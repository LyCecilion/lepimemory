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
|---|---|---|
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

**下一步是 Phase 1**（详见 `CONCEPTS.md` §7）。三个阶段的具体任务：

### 阶段 0：环境（半天，无代码）

```bash
# 1) dsh 跑起来（用 npm 发布版，不构建全仓）
npx @deepseek-ai/dsh web --no-open        # → http://127.0.0.1:3080

# 2) 配自定义模型端点
#    Settings → Models → "Add a custom model API"
#    Provider ID / baseURL / 协议 / 凭据 / 至少一个模型
#    可用的 key（本机环境已设置）：
#      GEEK_TECH_CLUB_API_KEY / KIMI_CN_API_KEY / MINIMAX_CN_API_KEY / XEMAPI_KEY
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

### 阶段 1：dsh 里注入「假人格」（1–2 天）⭐ 关键验证

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

---

## 待办：部署相关（Phase 1 之前或并行）

- [ ] `docker-compose.yml`（Hindsight + 健康检查 + 卷）
- [ ] `.env.example`（**绝不提交真 key**）
- [ ] `Makefile`：`make dev` / `make clean` / `make reset`
- [ ] `README.md`（写清启动时间：「第一次启动请等待 X 分钟」）
- [ ] `docs/DEMO.md`（评委自助路径 + 演示剧本）

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
|---|---|---|
| 用户打断 Agent 如何处理 | **未定**，需实测 dsh cancellation 语义 | `CONCEPTS.md` §8 |
| 「关于 A」vs「A 参与」的自动切分 | 当前用「机器候选 + 用户确认」**回避** | `DESIGN_NOTES.md` §2.5 |
| 情绪的极性冲突（又亲近又防备） | 单标量做不到，需「维度 + 矛盾标记」 | `DESIGN_NOTES.md` §1.7 |
| 各层上下文的 token 预算 | 需实测 | `DESIGN_NOTES.md` §3.4 |
