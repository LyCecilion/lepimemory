# Phase 3 遗忘（forget）—— 证据（工具 + 审批，取代正则）

- 日期：2026-09-29（工具化改造：2026-10-03）
- 分支：`exp/state-persistence`
- 模块：`lib/memory.js`（`forget` 工具）+ `lib/hindsight.js`（`invalidate`/`revert`）
- 机制：注册 **`forget` 工具**（**由模型调用**：用户要求忘记时，模型决定调它）→ 先 recall 出**将受影响的记忆** → 经 **`ctx.approval`** 做**结构化用户确认**（fail-closed，落 `approval/asked`+`approval/decided`）→ 同意才 `invalidate`（**可 revert**）。

> **为何不用正则**：早期版本在用户消息上跑正则识别「忘掉 X / 确认 / 取消」——hacky，且会误伤
> 「我永远不会忘记你」「别忘记我们的约定」，还会把「嗯……对了」误判为确认。**改为工具后**：意图判定交给模型，确认交给 dsh 审批 seam，**两类误判从根上消失**。

## 工具定义（零依赖原始 ToolDefinition）

```js
ctx.tools.register({
  name: "forget",
  description: "把某个对象从长期记忆里“忘掉”（检索抑制，可恢复）。会先列出将受影响的记忆并请用户确认，只有用户同意后才执行。当用户明确要求忘记某人/某事时调用。",
  parameters: { type: "object", additionalProperties: false, required: ["target"],
                properties: { target: { type: "string", description: "要忘掉的对象（人名 / 事物 / 说法）" } } },
  output: { schema: { type: "object", additionalProperties: false,
                      properties: { target:{type:"string"}, planned:{type:"number"}, executed:{type:"number"},
                                    outcome:{type:"string"}, memories:{type:"array",items:{type:"string"}} },
                      required: ["target","planned","executed","outcome","memories"] },
            render: (_a, v) => [{ type: "text", text: renderForget(v) }] },
  execute: async (args, exec) => { /* recall → 目标过滤 → approval → invalidate */ },
})
```

- **切分**：朴素 S1 —— 只取**文本确实提到目标**的候选（避免误伤；`related`）。
- **确认**：`ctx.get('approval').request({ agent: exec.agent, toolName:'forget', callId: exec.callId, reason, displayReason:{zh,en}, signal: exec.signal })` → `allowed-once | rejected | cancelled | unavailable`；**非 `allowed-once` 一律不执行**（fail-closed）。
- `displayReason` 带「将抑制 N 条：<列表>」，审批卡直接展示计划。

## 恢复工具 `restore_memory`（与 forget 对称）

承诺「可恢复」就必须有**入口**（否则模型只能口头假装）。故注册对称工具：

- 从自有审计 `forget.jsonl` **读回**「该目标被抑制过」的 ids → `ctx.approval.request`（同 forget）→ 同意才 `client.revert(id)`（`PATCH state=valid`）。
- outcome：`no-record` / `unavailable` / `rejected` / `cancelled` / `allowed-once`；审计写 `{"type":"restore",…}`。

实测：说「恢复团子」→ 审批卡 **「Restore 1 suppressed memories about "团子". / Allow once」** → 点允许 → `recall("团子")` 回到 **2 命中**。

## 实测（web `lepimemory` profile）

1. **工具可见**：会话 `request/header.tools` = `['ask_user_question','forget','web_fetch','web_search']`。
2. 说「忘掉团子」→ 模型**调用 forget** → 审批卡：**「Suppress 1 memories about "团子" (reversible). / Reject / Allow once」**（只 **1 条**，香菜未被卷入）→ 点 **Allow once**。
3. 审计：

```
approval/asked   {"id":"…","toolName":"forget","callId":"…","reason":"抑制 1 条关于「团子」的记忆"}
approval/decided {"id":"…","outcome":"allowed-once"}
forget.jsonl     {"type":"forget","tool":"forget","target":"团子","planned":1,"executed":1,"outcome":"allowed-once","ids":["…团子…"]}
```

4. 效果：`recall("团子")` → **0 命中**；`recall("香菜")` → **2 命中**（未误伤）。
5. **恢复**：说「恢复团子」→ `approval/asked{toolName:"restore_memory"}` → Allow once → `forget.jsonl` 追加 `{"type":"restore","restored":1,…}` → `recall("团子")` 回到 **2 命中**。

## 工具化过程中踩的坑（已修）

1. **`output.schema` 的 `required` 写法**：必须是**对象级数组** `required:[...]`，逐属性 `required:true` 会被 `assertSupportedJsonSchema` 拒绝（leaf 不支持）。
2. **`parameters` 必须是显式 object 节点**：裸属性表会被 provider 判为 `type: null` → `Invalid schema for function 'forget'`。用 `{type:'object', properties:{...}, required:[...], additionalProperties:false}`。
3. **工具可见性**（曾误判）：一度以为 host（bundle）注册的工具进不了 preset 会话。**实测推翻**——注册表是「全局层 + per-scope 层」合并，**runtime 在根上下文注册的工具会到达每个 agent**（此会话 `request/header.tools` 含 `forget` 即证）；之前会话没有 `tool-bash/fs` 是 web bundle 把那些**行 `disabled`** 了，不是 preset 挡的。

## 坑与备注

- **子集仍不可选**：一次调用抑制「与目标相关」的全部候选（`related`）；「只清这条」需工具再带 `ids` 参数。列为升级项。
- 意图完全交给模型：若模型该调未调（或不该调而调），是**模型判断**问题，非正则误伤；可用描述微调。
- 「关于 A / A 参与」语义切分仍是**回避**（候选 + 确认）；`DESIGN_NOTES §2.5`。
- 撤销：`client.revert(id)` 已具备（演示里撤销过误伤）；**尚未接**「用户说恢复」的工具化入口。

## 结论

- ✅ 「用户要求忘 → **模型调 forget** → 结构化审批 → 抑制 → 可撤销」闭环成立；审批**成对落审计**；无关记忆不被误伤。
- 相比正则版：**无消息级误判**、确认走 fail-closed 审批、计划与确认均在结构化通道。
