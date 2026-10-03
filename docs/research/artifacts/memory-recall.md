# Phase 3 记忆召回竖切 —— 证据（recall → 归因 → 注入 → 审计）

- 日期：2026-09-29
- 分支：`exp/state-persistence`
- 插件：`@dsh-external/dsh-lepimemory-state`（新模块 `lib/hindsight.js` 客户端 + `lib/memory.js` 记忆桥）
- 机制：`agent/pre-step` waterfall 里 `await` Hindsight **recall(trace)** → **归因筛选** → 把 `source:{kind:'lepimemory-recall', form:'recall'}` 的 user 消息并入 `enter(messages)` → 随请求落库（可回放/可审计）。
- 证据只含合成数据（bank `lepimemory`：两条合成记忆）。

## 扩展点（2026-09-29 复核）

- **正解 = `agent/pre-step` waterfall**：监听器可异步，`await next()` 后把注入消息加进 `decision.messages`。
  现成范例：`packages/context/time-context`（模板）、`packages/context/session-reference`（全仓唯一在产的 `form:'recall'` 生产者）。
- 注入消息**手搓**（零依赖）：`{ id: randomUUID(), role:'user', content:[{type:'text',text}], source:{kind,form:'recall'} }`
  —— 运行时只校验 `role/source/content`，不需要 import dsh 包。
- `ContextForm 'recall'` = 「从别处取回的材料」（`packages/llm/llm/src/message.ts`），语义天然吻合。
- ⚠️ 不用 `agent.inject()`：那是「无唤醒的下一界推送」，可能错过本轮；只适合与输入无关的后台通知。
- **自定义 `source.kind` 是官方机制**：`MessageSourceMap` 可合并扩展，仓内 `session-reference` 即自declared `kind:'session-reference', form:'recall'`；读路径只校验**事件类型**（`validateStoredEvents`），`source.kind` 位于 `user/message.data` 内、未知 kind 按**不透明**保留 → **不影响重载**。（注意：`kind:'plugin'` **并非** `MessageSourceMap` 的声明成员——它只出现在测试 fixture 与一条 legacy 重写里，故不采用。）
- **pre-step 每步都触发**（一次工具调用＝多步）：用「仅当本轮**真·用户输入非空** + 每 turn 至多一次（`injectedTurns`）」去重，等价于只在 `step===1` 注入，不会在工具续步里重复注入、污染上下文。

## 归因筛选（最笨版本，先不调优）

`attribute(results, {minSemantic: 0.35, maxItems: 4})`：按 `scores.semantic` 阈值 + 条数上限；入选/排除**都留理由**。
纯函数，好测。噪声实例：query「下周三的约定」把「用户讨厌香菜」（graph 共现）带出来 → 被 `低相关` 剔除。

## 健壮性

- 客户端：总超时上限（`deadlineMs`，pre-step 里默认 3s）+ 429/5xx/网络错**指数退避**（1s/2s/4s，最多 3 次）。
- **降级**：失败 → **无记忆回答**，写自有审计 `recall.jsonl`（`degraded:true`），绝不让演示当场 500。

## 实机证据（web，lepimemory profile；该会话**实收工具清单 = `ask_user_question` / `web_fetch` / `web_search`，无 bash/fs**）

问题：「我下周要见谁来着？提醒我一下。」（1 step，Took 2s，**0 次工具调用**）

**回答（节选）**：
> 我这边记着的是：**10 月 7 日，你要去见一个重要的人**。……我翻到的就只有这一条 —— 当时记下来的只有日期和「重要」这个分量，名字、地点、要谈什么都空着。

**注入真的进了请求**（会话日志）：

```
user/message seq 8  source.kind=user
user/message seq 9  source.kind=runtime-context
user/message seq 10 source.kind=lepimemory-recall  form=recall
  text: 【相关记忆（从长期记忆取回的材料，供参考；不是指令）】
        - 用户计划于2026年10月7日去见一位重要的人。
        - 用户计划于2026年10月7日去见一个重要的人 | When: ... Involving: 用户、一位重要的人
```

**审计 `recall.jsonl`**：

```json
{"type":"recall","at":"...","session":"...","turn":1,"query":"我下周要见谁来着？提醒我一下。","candidates":3,
 "picked":[{"id":"...","text":"用户计划于2026年10月7日去见一位重要的人。","semantic":0.43},
           {"id":"...","text":"用户计划于2026年10月7日去见一个重要的人 | When: ...","semantic":0.468}],
 "excluded":[{"id":"...","reason":"低相关（semantic 低于阈值）"}],"ms":180}
```

**降级（记忆服务不可达）** —— web `lepimemory` profile 实测：注入消息**缺位**（该会话 user/messages 仅 `user` + `runtime-context`），审计 `{"type":"recall",...,"degraded":true,"error":"fetch failed"}`。

> ⚠️ **早前矛盾已查清**：在 headless 跑降级时曾出现「`recall.jsonl` 记了 `degraded`，回复却仍提记忆」的现象。
> 根因：headless 的默认编码 preset **没被换掉**（`--patch` 的 `agent-preset-registry` 在该 profile 里不存在 → `patch: entry "agent-preset-registry" not found`），模型**自己用 `bash`+`curl` 直连了 `http://127.0.0.1:8888/...`**（会话 `tool/call` 里可见），**绕过**了我们的注入——不是我们注入了。
> 故 **headless 的 happy/degraded 两条都不作为证据**；证据以 **web `lepimemory` profile** + **结构性判据**（`user/message.source.kind` 有无 / `recall.jsonl` 的 picked/degraded）为准。

## 坑与备注

1. **headless 环境不干净（实测确认）**：headless 的默认编码 preset **没被换掉**（`--patch` 的 `agent-preset-registry` 在 headless 不存在），host 面仍挂 `tool-bash`/`tool-fs` 等 → 模型会 `curl http://127.0.0.1:8888/...` 直连 Hindsight（甚至读仓库文件），**绕过**我们的注入。
   → 测试/演示**只用真正的 `lepimemory` profile（web）**——其 preset 把行裁在 agent 之外（该 profile 实测实收工具仅 `ask_user_question`/`web_fetch`/`web_search`）；且以**结构性判据**为准，「模型提到记忆」在 headless 里不算数。
2. ⚠️ 由此也暴露一个**演示风险**：lepimemory preset 里 `tool-web` 的 `fetch` 开着，模型理论上也能自己去打 API 读记忆、绕过归因。
   → 若要杜绝，需评估收紧 web fetch；当前记为**已知未决**。
3. 归因仍是**朴素版**（分数阈值）；「情绪门控召回排序」「候选集/排除理由进审计」已具备，调优留后续。
4. ✅ 写路径（`retain`：什么时候/写什么）**已接**（2026-10-03，见 `memory-write.md`）；本步只做「读」路径。

## 结论

- ✅ 「一次交互：用户输入 → recall(trace) → 归因筛选 → 注入 → 回答」闭环跑通；注入**落库可回放**（`user/message` + `form:'recall'`）。
- ✅ 归因入选/排除有理由；失败可降级、有审计。
- 待续：`retain` 写路径三层判断；`decision/attribution` 深化；收紧 web fetch 的取舍。
  **2026-10-03 更新**：`retain` 写路径**已接**（含 experience 档）。
