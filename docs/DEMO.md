# DEMO — 评委自助路径

> 目标：让你在几分钟内看到 —— **一个角色有稳定人设、会因经历而变、记得住你、且这条因果链可被审计**。
> 全部步骤都对应可观测的落点（对话 / Trajectory / 文件审计），不需要你读代码。

## 0. 运行

```bash
cp .env.example .env     # 可留空；填了模型 key 更完整（评委场景）
make dev                 # 首次启动请等待 1–2 分钟（Hindsight 经 hf-mirror 拉多语言模型）
```

- 打开 `make dev` 打印的入口链接（默认 `http://127.0.0.1:3080`；token 每次启动会变）。
- 本机 3080 被占用：`make dev PORT=3181`。
- 想从零再来：`make reset`（清 `./.dsh` 与 Hindsight 卷）。
- 零 key 也能看到前几步（Hindsight `chunks` 模式，无 LLM 成本）。

**审计文件就在你手边**（`make dev` 的 `DSH_HOME=./.dsh`）：

```bash
tail -f .dsh/lepimemory/recall.jsonl    # 每轮召回：候选/入选/排除理由
tail -f .dsh/lepimemory/retain.jsonl    # 每轮写入：写了什么 / 跳过 / 失败 / 经历（origin:character-action）
tail -f .dsh/lepimemory/action.jsonl     # 行动工具：写了哪个便条文件
tail -f .dsh/lepimemory/forget.jsonl     # 遗忘/恢复：抑制/恢复了哪些 id、结果
ls      .dsh/lepimemory/notes/           # write_note 真实落盘的便条
cat     .dsh/lepimemory/state.json       # 当前状态（数值 + reasons）
tail -f .dsh/lepimemory/audit.jsonl      # 状态变更：前值→后值 + 命中规则
```

## 1. 三个可观测面（先知道去哪看）

| 面 | 看什么 | 在哪 |
| --- | --- | --- |
| **对话** | 人设语气、是否记得、是否因状态而变 | Chat 面板 |
| **Trajectory** | **Prompt Diff**（模型实际看到什么变了）、工具调用、事件 | 会话页 Trajectory 标签 |
| **文件审计** | 状态变更原因、记忆读写明细 | `./.dsh/lepimemory/*.jsonl`；记忆本体在 Hindsight UI `:9999` |

## 2. 剧本

### 步骤 A — 人设：它是谁
问：**「你好呀，你是谁？」**
- 预期：自称「蝶忆」，不冒「AI / 编码助手 / 工作目录」之类底座口吻。
- 落点：Trajectory 的 **Initial System Prompt** 里有人设 prefix。

### 步骤 B — 记忆「写」：把一件事交给它
说一条具体的事，例如：**「跟你说个事，我下周三要去见一个重要的人。」**
- 预期：角色自然接住。
- 落点：`retain.jsonl` 出现一条 `{"type":"retain","ok":true,…}`；稍后 `:9999` 的 bank 里多出该事实。

### 步骤 C — 记忆「读」：换个会话还记得（跨会话）
1. **新建一个会话**（点左上「New session」）。
2. 问：**「我下周要见谁来着？提醒我一下。」**
- 预期：角色答出「10 月 7 日 / 下周三，一位重要的人」。
- 落点（三处互相印证）：
  - `recall.jsonl`：`candidates` / `picked` / `excluded`（含排除理由）；
  - Trajectory：多出一条 **`user/message` 注入**（来源标注 `lepimemory-recall`，`form: recall`）——**这句话被哪条记忆驱动，就写在这里**；
  - 回 `:9999` 可看记忆本体。

### 步骤 D — 状态「因事而变」
- 方式一（**直证、无需重启**）：打开 `./.dsh/lepimemory/state.json`，把 `mood.valence` 改成 `-0.6`、`relation.trust` 改成 `0.1`，**直接对同一个会话再发一句**——语气会变冷淡/简短。
- 方式二（自动）：多轮里发生工具失败等事件，状态机在 `turn/end` 自动推进。
- 落点：`audit.jsonl`（`{时刻, turn, 命中规则, 维度前→后}`）+ Trajectory 的 Prompt Diff（状态段变化）。

> 状态渲染**不出现数值**：它把偏离最大的至多 3 项 + 原因 + 行为倾向写进提示词（见 Trajectory 里的「【内部状态…】」段）。

### 步骤 E — 遗忘（工具 + 审批）＋ 真实行动（已可演示）
- **遗忘**：说 **「忘掉团子」** →
  1. 模型先调 **`forget`（不带 ids）**：列出候选清单（**不弹审批**），问你只忘哪几条；
  2. 你选好后，模型再调 **`forget`（带 ids）** → 弹出**审批卡**（如「Suppress N memories about "团子" (reversible).」）→ 点 **Allow once** 才执行（底层 `invalidate`；**只抑制选中的 id**，不动其他）。
  3. **反悔**：说 **「恢复团子」** → 模型调用 **`restore_memory`** → 审批 → 允许 → 记忆回来。
- 落点：`forget.jsonl`（`forget` / `restore`）+ **`approval/asked` / `approval/decided`**；`:9999` 里该条在 invalidated / valid 间切换。
- 设计要点：**确认前不会声称已经忘记**；只切与目标相关的记忆，避免误伤（已实测：只抑制选中的那条，其余保持 `valid`）。
- **真实行动**：说 **「帮我写张便条：明天买菜」** → 模型调用 **`write_note`** → 审批卡（`Write a note titled "…"`）→ 允许 → **真实落盘** `.dsh/lepimemory/notes/明天买菜.md`。
  - 落点：`action.jsonl`（写了哪个文件）；成功让状态上扬（`audit.jsonl` 命中 `action.success.brighten`）；`retain.jsonl` 追加一条 `origin:character-action` 的**经历**。
  - **失败也进状态**：写不进去（如目录只读）→ 工具报 `isError` → `audit.jsonl` 命中 `tool.failure.dampen`、心境下降。

### 步骤 F — 状态面板（实时可见）
- composer 上方有一条**状态面板**，实时显示当前状态（读宿主的 `/lepimemory/state`）：一行摘要（`心境 v/a · 信任 t · 时间`）+ 渲染文本（如「心境: 比平常略轻快 / 原因: 刚刚帮你把事办成了。」）。
- 每 5s 自动刷新：聊几句 / 办成一件事 / 写失败 → 面板随轮次变化（对应 `audit.jsonl`）。
- 点面板里的 **「▸ History」** 可展开**历史账本**：**审计 / 召回 / 写入 / 遗忘 / 行动** 五个标签页，**最新在前**，可翻页（每页 10 条；显示「第 p/q 页 · 共 n 条」）。
- 想看原始数值：`cat .dsh/lepimemory/state.json`（面板口径与之一致；面板不显示数值、状态段也不显示）。

### 步骤 G — 上下文管理（保留 / 压缩 / 筛选 / 重组）
- **自动**：长会话把请求压力推过阈值时，dsh 自动把最老的一段历史**摘要**成一条 checkpoint，保留近期原文（本部署阈值为生产值，演示一般到不了；机制见 `docs/research/artifacts/context-management.md`）。
- **手动**：在对话框输入 **`/compact`** → 立即压缩一次（绕过阈值）。
- **落点**：会话页 Trajectory 出现「自动生成的 checkpoint」消息（历史被折叠）；会话日志出现 `compaction/start` / `compaction/summary` / `compaction/end`。
- **注意**：状态段（system 提示词节点 0）**永不被压**；被压的旧「召回注入」只是冗余副本（记忆真源在 Hindsight，每轮重新召回）。

### 步骤 H — 角色自己的推断（`remember`）
- 说：**「你对我应该有些自己的判断了吧？把重要的一条记成你自己的推断。」**
- 预期：模型调用 **`remember`** 工具 → `retain.jsonl` 落 `origin:character-inference`。
- 落点：`:9999` 该条带 `metadata.trust=inference`（推断档，会随时间衰减）；召回时若衰减到阈值以下会被**排除**（`recall.jsonl` 有理由）。

### 步骤 I — 记忆更新 / 冲突（冲突取最新）
- 先给一条事实（如「我最喜欢的颜色是靛蓝」），再说一条与之相关的新信息。
- 预期：Hindsight 把矛盾信息合成一条**观察**（「之前…现在…」），下次召回**只返回更新后的版本**（`prefer_observations`）。
- 落点：`recall.jsonl` 出现 `superseded: true`、入选 `type: "observation"`（注入文本标「综合印象（已更新）」）。

## 3. 审计要能回答的问题（题目口径）

| 题目问题 | 本 Demo 的落点 |
| --- | --- |
| 用了哪些上下文和记忆 | Trajectory 的 Prompt Diff + `recall.jsonl`（每条入选含 `type`/`trust`，并记 `superseded` 是否取用了更新版） |
| 内部状态是否变化 | `state.json` + `audit.jsonl` |
| 调用了哪些工具、输入结果 | Trajectory 的 Tools / `tool/*` 事件（dsh 原生） |
| 产生了什么语言或行为 | Chat / Trajectory |
| 上下文如何被裁剪/压缩 | Trajectory 的 checkpoint 消息 + 会话日志 `compaction/*` 事件 |
| **为什么这样决定** | `recall.jsonl`（入选/排除理由，含推断档衰减理由）+ `audit.jsonl`（命中规则）+ 上述交叉引用 |

## 4. 现状与未实现（诚实清单）

已可演示：**人设注入**、**状态持久化 + 事件驱动状态机（含心境衰减与量级标定）**、**记忆读写闭环（recall/retain）**、**记忆更新/冲突（冲突取最新：Hindsight observation supersede + `prefer_observations`）与三档信任等级（fact / experience / inference）+ 推断衰减**、**遗忘（工具 + 审批，支持子集/单条）与恢复**、**真实行动工具 `write_note`（审批 + experience + 失败进状态）**、**角色推断工具 `remember`**、**上下文管理（长历史保留/压缩/筛选：dsh compaction + `/compact`）**、**状态面板（client 插件）**、**自有审计**。

**未实现（roadmap）**：
- **面板只读**：历史分页**已做**（`/lepimemory/history`：审计/召回/写入/遗忘/行动，最新在前、可翻页）；但面板不提供写操作（改状态仍走编辑 `state.json` 或 `write_note`），真实 Remote 未接。
- **规则集仍精简**：三条（熟悉度 / 行动成功 / 工具失败）+ 心境 6h 半衰期衰减；更细的关系 / 情绪事件未接。
- **记忆更新无显式工具**：新旧矛盾走 Hindsight 原生 observation（refine-not-overwrite），我们只做「取最新 + 审计」；未提供「手动把 A 改成 B」的显式工具。
- **衰减仅作用推断档**：fact / experience 不衰减；observation 按事实处理（被 consolidation 吸收＝已确认）。
- **上下文自动压缩阈值高**：生产默认阈值 ≈163k tokens，正常演示不会自然触发；看效果请用 `/compact`。

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| 首次启动慢 / 健康检查未过 | 等 1–2 分钟；或 `docker compose logs -f hindsight` |
| 端口被占用 | `make dev PORT=3181` |
| dsh 起不来（本机 Nix Node） | 见 `docs/research/dsh-findings.md` §3.1 |
| 记忆像「没生效」 | 确认 Hindsight 在 `:8888` 健康；看 `recall.jsonl` 的 `degraded`；记忆服务不可达时会**降级为无记忆回答**（设计如此） |
| 想全清重来 | `make reset` |
