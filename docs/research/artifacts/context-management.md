# 上下文管理（Lv1）——设计、取舍与实测

> 2026-10-03。补上 Lv1 唯一缺口：随历史增长，「上下文如何被保留 / 压缩 / 筛选 / 重组」。
> 结论：**复用 dsh 的 compaction 后端（不重复造轮子），并把「为什么安全」的边界写死。**
> 关联：`CONCEPTS.md` §3、`dsh-findings.md`；profile 改动见 `dsh/profiles/lepimemory/cordis.patch.yml`。

## 1. 问题

Lv1 要求：多轮交流时，过去对话要影响之后回答；「随着历史不断增长，你需要考虑上下文如何被保留、压缩、筛选或重新组织，但具体方法不限」。

改前状态：profile 把 `@deepseek-ai/dsh-compaction-basic` 标了 `disabled: true`——也就是说**历史只增不减**，长会话会让每次请求线性膨胀。这是 Lv1 必答题里唯一的洞。

## 2. 调研（dsh 0.1.7-rc.2 的 compaction 子系统）

只读侦察 + 源码核对（`packages/compaction/**`）得到三条决定性事实：

1. **`compaction-basic` 是唯一摘要式后端**，region 选择**纯位置化**：从第一个非 system 的 surface 节点起选，按 token 预算保留**近期尾部原文**，其余最老的一段交给 LLM 摘要，替换成一条 `compact-checkpoint` 消息（`surfaceOp: replace`）。被替换的原事件仍留在 append-only 日志里。
2. **不看 `ContextForm` / `source.kind`**：没有任何按来源保护/排除消息的机制。**唯一文档化定制缝**是 `summarize()` 子类钩子（`README.md:109`）。
3. **system 提示词永不被压**：region 起点跳过 surface 节点 0 的 `system/message`（`region.ts:131`）。触发有三条路径：压力自动（`agent/pre-step`，用 `ctx.tokenMeter` 度量**上一份 durable 路由请求包络**）、溢出恢复、手动 `/compact`。
4. `compaction-tool-result-pruner` **只处理 `tool/result`**（超长工具输出裁头尾），绝不碰 user 消息；但它**无独立触发器**，只被 `compaction-basic` 在压缩前调用——单独挂载等于死代码。

## 3. 决策

**启用 `compaction-basic` + `tool-result-pruner` + `command-compact`**，理由与边界：

| 事实 | 结论 |
| --- | --- |
| 状态段是 `ctx.systemPrompt.section()`，渲染进 `system/message` 节点 0 | **永不被摘要**，人格/状态锚安全 |
| recall 注入是普通 `user/message`，滑出保留尾部会被摘要 | 可接受：我们**每轮重新召回注入**，Hindsight 才是记忆真源，被压的旧 recall 只是冗余副本 |
| our 每轮注入时序（`agent/pre-step` prepend + `await next`） | 压缩发生在本轮消息落库**之前**，当轮注入不受影响 |
| 上游默认阈值 = `floor(min(W×0.8, W−O−B))`；本部署 W=262144、B=65536、O=32768 | 默认阈值 ≈163840、保留尾部 ≈36700——**生产安全值**，短演示不会误触发 |

> 旧稿的禁用理由（「避免把注入的记忆内容摘要掉」）**被推翻**：真正会被摘要的只有旧的 recall 副本，代价可忽略；收益是上下文有界。

## 4. 踩坑（关键）

**PRESET 里挂压缩服务必须放进 `isolate` realm。** 直接把 `compaction-basic` / `tool-result-pruner` 列进 preset 的 `plugins` 会被 registry 拒绝：

```
agent-preset/invalid: Preset services require isolate realms: compaction, toolResultPruner
```

正解照上游 web-app 的 standard preset——用一个 `cordis:group` 包住，并声明 `isolate`：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: "@deepseek-ai/dsh-compaction-basic"
    - id: command-compact
      name: "@deepseek-ai/dsh-command-compact"
    - id: tool-result-pruner
      name: "@deepseek-ai/dsh-compaction-tool-result-pruner"
```

（host 面那几行被 web-app 标了 `disabled`，压缩后端由 preset 拥有——所以必须走上面这条。）

## 5. 验证（实测）

bench：`DSH_HOME=/tmp/lep-web` + 仓库 profile（绝对 link）+ `--patch <machine>`；为**逼出压缩**，bench 覆写激进阈值（`thresholdRatio 0.004`、`retainTokens 300`、`maxTokens 1500`；**仓库草稿保持生产默认**）。

- **结构**：`--dump-config` 见 `cordis:group` + `isolate` + 三个压缩行；启动无插件错误；会话成立（`session/create → agentPreset: lepimemory`）。
- **运行**：一段 6 轮的长对话后，会话日志出现
  `compaction/start` → `compaction/summary`（含 `shadowedSeqs`）→ `compaction/end`，
  并落一条 **`source.kind: 'compact-checkpoint'`** 的替换 `user/message`（内含 `<compacted-summary>…`）；此后 `contextPressure.pressureTokens` **平台化**（不再随轮次增长）。
- **收缩校验确实生效**：激进配置下多次出现 `summary is not smaller than the shadowed content` / `summarization truncated at the token cap` ——被正确拒绝、不写脏数据（生产保留尾部大，不会遇到）。
- **手动 `/compact`（DEMO 步骤 G 的唯一现实路径）已端到端验证**：`commands/execute` 发 `/compact` → 会话日志出现
  `command/run(compact)` → `compaction/start` → `compaction/summary`（`shadowedSeqs` 23 条）→ `compaction/end` → `command/done`，
  并落一条 3320 字的 `compact-checkpoint`；返回 `{kind:"success", text:"Compacted 23 history items (~1706 tokens)."}`。
  命令**确实注册、可执行、走同一压缩引擎**（隔离验证时把 `auto` 关掉、只走 `/compact`，排除自动路径干扰）。
- **状态段未被压**：压缩后 `system/message` 仍在、后续轮次照常注入状态。

## 6. 诚实边界

- 自动触发读的是**上一份** durable 包络，故「本轮刚变长」要到下一轮才可能触发——这是上游语义，不是我们的 bug。
- 生产阈值（≈163k tokens）很高，**正常演示不会自然触发**；要看效果用 `/compact`（已随 `command-compact` 挂载）或 bench 激进阈值。
- 我们**没有**自研 region 选择器（不可插拔）；若将来要「保护特定消息不被摘要」，官方缝是覆写 `summarize()`（把 form:'recall' 原文并入 checkpoint），需受父类收缩校验约束。
