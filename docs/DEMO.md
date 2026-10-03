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
tail -f .dsh/lepimemory/retain.jsonl    # 每轮写入：写了什么 / 跳过 / 失败
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

### 步骤 E — 遗忘（工具 + 审批，已可演示）＋ 真实行动（待实现）
- **遗忘**：说 **「忘掉团子」** →
  1. 模型**调用 `forget` 工具**；界面弹出**审批卡**（含将抑制的条目，如「Suppress N memories about "团子" (reversible).」）；
  2. 点 **Allow once** → 执行（底层 `invalidate`，**可撤销**）；点 **Reject** → 不执行。
- 落点：`forget.jsonl` + **`approval/asked` / `approval/decided`**；`:9999` 里该条转 `invalidated`。
- 设计要点：**确认前不会声称已经忘记**；只切与目标相关的记忆，避免误伤（已实测：忘「团子」不动「香菜」）。
- **真实行动**：产生**真实副作用**（非「我帮你记下了」）+ 审批 + 失败影响状态 —— **待实现**（见 §4）。

## 3. 审计要能回答的问题（题目口径）

| 题目问题 | 本 Demo 的落点 |
| --- | --- |
| 用了哪些上下文和记忆 | Trajectory 的 Prompt Diff + `recall.jsonl` |
| 内部状态是否变化 | `state.json` + `audit.jsonl` |
| 调用了哪些工具、输入结果 | Trajectory 的 Tools / `tool/*` 事件（dsh 原生） |
| 产生了什么语言或行为 | Chat / Trajectory |
| **为什么这样决定** | `recall.jsonl`（入选/排除理由）+ `audit.jsonl`（命中规则）+ 上述交叉引用 |

## 4. 现状与未实现（诚实清单）

已可演示：**人设注入**、**状态持久化 + 事件驱动状态机（含衰减）**、**记忆读写闭环（recall/retain）**、**遗忘（计划预览→确认→可撤销）**、**自有审计**。

**未实现（roadmap）**：
- **真实行动工具** + 审批（步骤 E 下半）——当前 preset 未挂行动工具；写路径也尚未收「经历（experience）」档。
- **遗忘工具化**（让用户可选子集）+ `ctx.approval`。
- **状态面板**（把 `state.json`/`audit.jsonl` 做成前端卡）。
- 规则集与量级仍在标定（单轮状态增量低于渲染阈值，需多轮或调参才「看得见」）。

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| 首次启动慢 / 健康检查未过 | 等 1–2 分钟；或 `docker compose logs -f hindsight` |
| 端口被占用 | `make dev PORT=3181` |
| dsh 起不来（本机 Nix Node） | 见 `docs/research/dsh-findings.md` §3.1 |
| 记忆像「没生效」 | 确认 Hindsight 在 `:8888` 健康；看 `recall.jsonl` 的 `degraded`；记忆服务不可达时会**降级为无记忆回答**（设计如此） |
| 想全清重来 | `make reset` |
