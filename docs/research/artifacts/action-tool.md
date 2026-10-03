# Phase 3 行动工具 `write_note` — 证据（真实副作用 + 审批 + experience + 失败进状态）

- 日期：2026-10-03
- 分支：`develop`
- 模块：`lib/action.js`（新，`write_note` 工具）+ `lib/index.js`（状态机收 `actionSuccesses`）+ `lib/memory.js`（experience 写路径）+ `lib/machine.js`（`action.success.brighten` 规则）
- 意图：角色能执行一个**产生真实副作用**的动作（写一个真实文件），经 `ctx.approval` 确认；成功进「经历」写路径与状态机，失败进状态。

## 工具定义（照 `forget` 的形状）

```js
ctx.tools.register({
  name: "write_note",
  description: "把一段文字写成一张真实便条（落盘为文件）。执行前会请求用户确认。当用户明确要你“记下来/写下来/记一张便条”时调用。",
  parameters: { type:"object", additionalProperties:false, required:["title","body"],
                properties:{ title:{type:"string",description:"便条标题"}, body:{type:"string",description:"便条正文"} } },
  output: { schema:{ type:"object", additionalProperties:false,
                     properties:{ path:{type:"string"}, title:{type:"string"}, outcome:{type:"string"} },
                     required:["path","title","outcome"] },
            render: (_a,v) => [{ type:"text", text: renderNote(v) }] },
  execute: async (args, exec) => { /* 校验 → approval → 落盘 → 审计 */ },
})
```

- **副作用落点**：`<DSH_HOME>/lepimemory/notes/<slug>.md`（插件自有目录，**不越权写用户项目**）。slug = 标题的非字母数字折叠成 `-`，截断 60。
- **确认**：`ctx.get('approval').request({ agent, toolName:'write_note', callId, reason, displayReason:{zh,en}, signal })`；非 `allowed-once` → 返回 `{path:"",title,outcome}`（`rejected`/`cancelled`/`unavailable`），**不落盘**。
- **失败**：落盘异常**直接抛** → 工具 `isError:true`（见「失败进状态」）。审计 best-effort 写 `action.jsonl`。

## 状态机收「行动成功」事实（`lib/index.js`）

- `turns` 账本加 `actionSuccesses`。
- `tool/call` 且 `name ∈ ACTION_TOOLS` → 记 `__pendingActionCalls.set(callId)`。
- `tool/result` 命中该 callId 且 `!isError` → `actionSuccesses += 1`。
- ⚠️ **字段名核对（关键）**：会话格式为 **V4** 时，`tool/result.message` 是 first-class tool-role 消息，`toolCallId` / `isError` 在 **message 顶层**。（旧 V2 的「user 消息里嵌 tool-result 块」是历史格式；磁盘上 `session.jsonl.zstd` 可能是 V2 遗留、`session.v4.jsonl.zstd` 才是当前。详见 `docs/DEVLOG.md` 踩坑。）

## experience 写路径（`lib/memory.js`）

- 与「用户陈述」的 retain 缓冲并列、互不干扰：`turn/end` 时对每个成功动作
  `client.retain([{ content:`我写了张便条：${title}`, context:"角色做过的事", tags:["origin:character-action","trust:experience"] }], {deadlineMs:30000, maxRetries:0})`（fire-and-forget），审计 `retain.jsonl` 带 `origin:"character-action"`。

## 实测（web `lepimemory` profile，bench `DSH_HOME=/tmp/lep-web`）

1. **工具可见**：会话 `request/header.tools` = `['ask_user_question','forget','restore_memory','web_fetch','web_search','write_note']`。
2. 说「帮我写张便条：明天买菜」→ 审批卡 **「Write a note titled "明天买菜". / Reject / Allow once」** → **Allow once**。
3. **真实副作用**：`/tmp/lep-web/lepimemory/notes/明天买菜.md` 存在：

```
# 明天买菜

明天记得去买菜。
…
```

4. 审计：

```
action.jsonl  {"type":"action","tool":"write_note","title":"明天买菜","path":"…/notes/明天买菜.md","outcome":"allowed-once","at":"…"}
retain.jsonl  {"type":"retain","origin":"character-action","…","content":"我写了张便条：明天买菜"}   ← experience 档
             {"type":"retain","…","skipped":true,"reason":"请求句（不写入长期记忆）","content":"帮我写张便条：明天买菜"}  ← 用户请求句被正确跳过
audit.jsonl   {"turn":1,"rules":["interaction.familiarity","action.success.brighten"],"changes":{"valence":[0,0.12],"closeness":[0.2,0.23],"familiarity":[0.1,0.13]}}
```

5. **失败进状态**：`chmod 0500` notes 目录 → 再写便条 → 审批后落盘 `EACCES`：

```
tool/result  isError=true  "Error: EACCES: permission denied, open '…/notes/失败测试.md'"
audit.jsonl  {"turn":8,"rules":["interaction.familiarity","tool.failure.dampen"],
              "changes":{"valence":[0.1174,-0.0035],"trust":[0.3,0.26],"familiarity":[0.31,0.34]}}
state.json   reasons: ["刚才有个操作没成。", "刚刚帮你把事办成了。"]
```

## 结论

- ✅ 「用户要求写 → 模型调 `write_note` → 结构化审批 → **真实落盘** → 审计」闭环成立；副作用在**插件自有目录**，不越权。
- ✅ 成功 → `action.success.brighten`（心境/亲近）**跨渲染阈值**；experience 档 `origin:character-action` 自动 retain。
- ✅ 失败（execute 抛错 → `isError`）→ 既有 `tool.failure.dampen` 命中，心境下降**跨阈值**、reason 入 `state.json`。
- 备注：`write_note` 是「行动」的**最小可审计样例**；通用 shell/fs 仍不放开（见 profile preset 裁剪）。
