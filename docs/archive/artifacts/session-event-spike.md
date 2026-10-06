# Spike 证据 — out-of-tree 插件能否追加自定义会话事件？

> **历史证据 · 非当前工作流**：本文是 2026-09-29 的 spike 记录，结论（out-of-tree 不能追加自定义会话事件）**仍成立**，按当时原样保留。当前架构见 [docs/ARCHITECTURE.md](../../ARCHITECTURE.md) §4.1。

- 日期：2026-09-29
- 分支：`exp/state-persistence`
- 目标：验证「每轮往 session log 追加一条自定义持久化审计事件（计划名 `persona/state-diff`）」是否可行。
- 结论：**不可行**（追加成功，但会让**整个会话在重载时被拒绝解读**）。

## 方法

临时在 `dsh-lepimemory-state` 的 `apply` 里加一段**受环境变量开关**控制的监听（做完即撤）：

```js
if (process.env.LEPI_SPIKE_APPEND === "1") {
  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    agent.session.append("persona/state-diff", { turn, note: "spike" })
  })
}
```

`agent/turn-stopping` 是 serial 钩子（`{ agent, turn, signal }`），在轮次关闭**之前**运行 → 处于开放轮次内，允许追加。

## 观察

1) **追加成功**：会话日志里出现该事件（`/tmp/lep-web` 的 `session.v4.jsonl.zstd`）：

```json
{"type":"persona/state-diff","seq":64,"time":1790655604230,"data":{"turn":5,"note":"spike"}}
```

注意：**没有 `ignorable` 字段**（`Session.append()` 无该透传入口）。

2) **重启进程、重开会话 → 整档被拒**（web 界面原文）：

```
Failed to load history: failed to observe session "session-955f5783-…":
session "…" contains event type "persona/state-diff" (seq 64) unknown to this harness
and not marked ignorable; refusing to interpret the log — it was likely written by a
newer harness (raw log: …/session.v4.jsonl.zstd) (gateway/internal)
```

## 依据（源码）

- 读侧白名单：`packages/core/session/src/known-event-types.ts`（GENERATED；注释明确「out-of-repo 插件事件永不在此表」）。
- 读侧准入：`packages/session/session-persistence/src/storage-contract.ts`（未知且无 `ignorable` → 拒绝解读整条日志）。
- 写侧签名：`packages/core/session/src/index.ts:722`（`append(type, data, ...opts)`，无 `ignorable`）。
- 官方插件实践：`preset/agent-preset/skills/cordis-plugin-development/references/practices.md` ——「**不要用新事件类型 append**；改用从既有事件派生或插件自有存储」。
- 设计记录：`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`。

## 写路径定论（穷举，2026-09-29）

| 路径 | 能写 `ignorable: true`？ | 结论 |
| --- | --- | --- |
| **热路径**：`agent.session.append(type, data[, surfaceOpts])` | ❌ 无该参数（`core/session/src/index.ts:722`） | 写出的外部事件无标记 → 重载整档拒绝（上文实测） |
| **冷路径**：`ctx.sessionPersistence.open(id,'write')` → `SessionHandle.append(events)` | ✅ 接受完整事件（含 `ignorable`，`session-persistence/src/handle.ts`） | **但拿不到写句柄**：seam 单写者，活会话的写句柄已被 agent-loop 持有 |
| **官方插件规范** | — | 明令「**不要用新事件类型 append**」（`…/cordis-plugin-development/references/practices.md`） |

**冷路径探针实测**（`/tmp` bench，临时探针，做完即撤）：

```
sessionPersistence present: true
open(id,'write') FAILED: SessionAlreadyOwnedError: session "session-…" is already owned by an active write handle
```

→ **定死**：本版本外挂插件**没有任何受支持的活写路径**能把 `ignorable: true` 写进信封；新增会话事件类型 = 破坏重载。

---

## 影响 / 决策

- 审计落点随后改写为**分层落点**（现见 [docs/ARCHITECTURE.md](../../ARCHITECTURE.md) §4.1）：
  - **效果**（模型看到什么）→ dsh 原生 `system/message` 的 Prompt Diff（已可回放）；
  - **原因**（为何变化）→ **插件自有持久化**（`<DSH_HOME>/lepimemory/audit.jsonl`）。
- 原计划四个自研事件（`memory/recall` / `memory/retain` / `persona/state-diff` / `decision/attribution`）全部作废。
- 记录于 `docs/archive/dsh-findings.md` §2.13–2.14。

## 附：可复用结论

- 订阅会话事件：`ctx.on('session/event', (session, event) => …)`（回调拿到 live Session）。
- 在**开放轮次内**追加既有类型事件：`agent.session.append('<known-type>', data)`（范例：`deliverables/workspace-changes`）。
- 但新增类型 = 破坏会话重载；**不要做**。
