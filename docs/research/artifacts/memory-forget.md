# Phase 3 遗忘（forget）—— 证据（工具 + 审批，取代正则）

- 日期：2026-09-29（工具化改造：2026-10-03）
- 分支：`exp/state-persistence`（2026-10-03 并入 `develop` → `main`）
- 模块：`lib/memory.js`（`forget` 工具）+ `lib/hindsight.js`（`invalidate`/`revert`）
- 机制：注册 **`forget` 工具**（**由模型调用**：用户要求忘记时，模型决定调它）→ 先 recall 出**将受影响的记忆** → 经 **`ctx.approval`** 做**结构化用户确认**（fail-closed，落 `approval/asked`+`approval/decided`）→ 同意才 `invalidate`（**可 revert**）。

> **为何不用正则**：早期版本在用户消息上跑正则识别「忘掉 X / 确认 / 取消」——hacky，且会误伤
> 「我永远不会忘记你」「别忘记我们的约定」，还会把「嗯……对了」误判为确认。**改为工具后**：意图判定交给模型，确认交给 dsh 审批 seam，**两类误判从根上消失**。

## 工具定义（零依赖原始 ToolDefinition）

```js
ctx.tools.register({
  name: "forget",
  description: "把某个对象从长期记忆里“忘掉”（检索抑制，可恢复）。两段式：先不带 ids 调一次 → 返回候选清单（计划）；再把选中的 ids 带上调一次 → 经用户确认后执行抑制。当用户明确要求忘记某人/某事时调用。",
  parameters: { type: "object", additionalProperties: false, required: ["target"],
                properties: { target: { type: "string", description: "要忘掉的对象（人名 / 事物 / 说法）" },
                              ids: { type: "array", items: { type: "string" },
                                     description: "只抑制这些记忆 id（来自上一次调用的候选 ids）；省略则仅返回候选计划" } } },
  output: { schema: { type: "object", additionalProperties: false,
                      properties: { target:{type:"string"}, planned:{type:"number"}, executed:{type:"number"},
                                    outcome:{type:"string"}, ids:{type:"array",items:{type:"string"}},
                                    memories:{type:"array",items:{type:"string"}} },
                      required: ["target","planned","executed","outcome","ids","memories"] },
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

## 子集选择：两段式（plan → ids，2026-10-03）

早先「一次抑制全部相关候选」对用户/模型不友好（「只清这条」做不到）。改为**两段式**：

- **第一段（缺省 `ids`）**：`recall(target)`（`prefer_observations:false`）→ `attribute(minSemantic 0.3, maxItems 20, applyDecay:false)` → `related = 文本含 target 的候选` → **只返回候选计划** `{ target, planned, executed:0, outcome:"plan", ids:[…], memories:[…] }`，**不请求审批、不执行**。
- **第二段（带 `ids`）**：`selected = related.filter(m => args.ids.includes(m.id))` → 空则 `no-match`；否则 **`ctx.approval` 确认 → 仅对选中 id `invalidate`**。
- `renderForget` 的 `plan` 分支**把每条候选的 id 一并渲染给模型**（`· [<id>] <文本>`），模型才能把选中的 id 回传。

> ⚠️ **坑（已修）**：`output.render` 才是**模型可见**的工具结果；工具**返回的 `value`（含 ids）默认不给模型**。
> 初版 `plan` 渲染文案写「ids 见结果」但没把 ids 打进 render → 模型**拿不到 id、第二段无法发起**。
> 处置：`plan` 分支逐条渲染 id。**结论：模型要用的字段，必须出现在 `render` 里。**

实测（web `lepimemory` profile；先经 REST 往 bank 播种 ≥2 条含「团子」记忆）：

1. 说「把团子相关的记忆列出来」→ 模型调 `forget({target:"团子"})` → 工具结果列出 **7 条候选（带 id）**；**无审批卡**（`forget.jsonl` 不存在，无 `approval/asked`）。
2. 回「只忘掉这一条：`8918be6d-…`（团子喜欢在午后晒太阳）」→ 模型调 `forget({target:"团子", ids:["8918be6d-…"]})` → 审批卡 **「Suppress 1 memories about "团子" (reversible). / Allow once」** → 允许。
3. 审计：`forget.jsonl` `{"type":"forget","planned":1,"executed":1,"outcome":"allowed-once","ids":["8918be6d-…"]}`；`approval/asked {toolName:"forget",reason:"抑制 1 条关于「团子」的记忆"}`。
4. 效果：`8918be6d` → `state=invalidated`；同标的其他记忆（如 `95cfeef3 团子是一只橘猫`）仍是 `state=valid`。**只抑制选中项。**

## 坑与备注

- ✅ **子集可选**：两段式（计划 / ids）已落地；`ids` 只作用于「确实提到目标」的候选，避免「全量抑制」与模型陈述不符。
- 意图完全交给模型：若模型该调未调（或不该调而调），是**模型判断**问题，非正则误伤；可用描述微调。
- 「关于 A / A 参与」语义切分仍是**回避**（候选 + 确认）；`DESIGN_NOTES §2.5`。
- 撤销：`client.revert(id)` 已具备；「用户说恢复」的**工具化入口已接**（`restore_memory`，2026-10-03，见上「恢复工具」一节）。

## 结论

- ✅ 「用户要求忘 → **模型调 forget** → 结构化审批 → 抑制 → 可撤销」闭环成立；审批**成对落审计**；无关记忆不被误伤。
- 相比正则版：**无消息级误判**、确认走 fail-closed 审批、计划与确认均在结构化通道。
