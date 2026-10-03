# Phase 3 记忆写路径（retain）—— 证据

- 日期：2026-09-29
- 分支：`exp/state-persistence`
- 模块：`lib/memory.js`（写路径）+ `lib/hindsight.js`（client.retain）
- 机制：`session/event` 的 `turn/end` 收尾时，对**本轮用户说过的话**做最笨的「写入判断」→ Hindsight `retain`（concise 抽取）→ 自有审计 `retain.jsonl`。
- 合成数据（bank `lepimemory`）。

## 三层判断（v1，朴素）

| 层 | 判定 | 落点 |
| --- | --- | --- |
| ① 不写 | 过短 / **疑问句**（含 `？`）/ **请求句**（`提醒我…`）/ 寒暄 | 审计记 `skipped` + `reason` |
| ② experience | **待接**（本步未做；角色暂无「行动/工具结果」类经历） | — |
| ③ fact / preference | 其余**用户陈述** → `retain`（Hindsight `concise` 负责过滤填充语、抽成事实） | `trust:fact` 标签 |

- `tags: ["origin:user-turn", "trust:fact"]` 标来源与信任等级（CONCEPTS §4.2 的「事实/推断/经历」先落 fact 档）。
- **去重**：同一内容（归一化）不重复 `retain`。
- **冲突/过期**：走 Hindsight 原生 **observation refine-not-overwrite / supersede**，我们不做特殊处理。

> ⚠️ **v1.1 修复（实测复现的过度写入）**：初版层①**只按长度**过滤 → 把用户的**提问**也写进了记忆
> （`{"turn":2,"ok":true,"content":"我下周要见谁来着？提醒我一下。"}`），Hindsight 随即抽出近重复事实 →
> turn2 的 recall **候选 8 条、picked 4 条近重复**。
> 已修：层①加「疑问/请求句排除」（`writeSkipReason`，纯函数，10/10 用例过）+ 源头内容去重。

## 健壮性

- **fire-and-forget**：不阻塞对话；失败/退避耗尽 → 审计 `degraded`。
- **retain 非幂等 → 不重试**（网络错重试会造成**重复记忆**）：`retain` 走 `maxRetries:0`；recall 才用退避重试（幂等读）。
- **预算分开**：recall 是**前台的**（pre-step 里，`deadlineMs` 默认 3s，超时就降级无记忆）；retain 是**后台的**（`deadlineMs` 默认 **30s**）。
  - ⚠️ 初版误用 3s 预算跑 retain → LLM 抽取常 >3s → client 超时、审计假报 `degraded`（**服务端其实成功**）。已改为 retain 独立 30s 预算。

## 实测（web `lepimemory` profile）

| 步骤 | 结果 |
| --- | --- |
| 说「我养了只猫叫团子，三岁了」 | `retain.jsonl` 初版假 `degraded: timeout`，但 bank **4→6**、`recall("猫叫什么名字")` → 「用户养了一只猫，名叫团子，三岁了。」 |
| 修预算后再发「我是做插画的，平时在家工作」 | `retain.jsonl`：`{"type":"retain","ok":true,"chars":20,"items":1,"content":"顺便说一句，我是做插画的，平时在家工作。"}`；bank **6→8** |
| recall 校验 | `recall("插画")` → 「用户从事插画工作，平时在家工作。」；`recall("用户做什么工作")` → 同上 |

审计样例：

```json
{"type":"retain","at":"...","session":"...","turn":2,"ok":true,"chars":20,"items":1,"content":"顺便说一句，我是做插画的，平时在家工作。"}
```

## 坑与备注

1. **headless 一次性进程抓不到 fire-and-forget**：进程在 retain 完成前就退出 → 写路径测试须用**常驻服务（web / resident）**。
2. 写入判断仍是**朴素版**：靠长度门槛 + 交 Hindsight `concise` 抽取；**未**做「模型级推断/经历」判断，也没有「用户确认后写入」的协商。
3. experience（角色行动/工具结果）与 inference 档**未接**——待「行动工具」落地后再补（CONCEPTS §4.2 / §4.4）。
4. 端到端「埋信息 → 换会话 → 被问起」的完整演示，留给 `DEMO.md` 剧本阶段。

## 结论

- ✅ 写路径闭环：**对话中说的话 → 抽取成长期事实 → 可被后续 recall 命中**；噪声跳过、失败有审计。
- 待续：experience/推断档、遗忘（用户要求忘记的实际效果）、`DEMO.md` 剧本。
  **2026-10-03 更新**：experience 档（角色成功动作→`origin:character-action`）、遗忘工具化+审批+子集、`DEMO.md` 剧本**均已落地**；仅**推断档**待接。
