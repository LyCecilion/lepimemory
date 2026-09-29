# Phase 3 状态机 v1 证据 — 事件驱动 + 衰减 + 自有审计

- 日期：2026-09-29
- 分支：`exp/state-persistence`
- 插件：`@dsh-external/dsh-lepimemory-state`（`lib/index.js` 装配；`lib/state.js` schema/渲染/读写；`lib/machine.js` 状态机）
- 机制：订阅 `session/event`，在 `turn/end` 收尾时把本轮**结构事实**折算成状态增量 + 心境衰减，写 `state.json` 并追加 `audit.jsonl`。
- 本文件只记结论与实测输出（合成数据）。

## 规则（v1，显式数据；量级待实测）

`lib/machine.js` 的 `RULES`，纯函数 `(facts) => deltas`：

| 规则 id | 触发（事实） | 增量 | 为什么 |
| --- | --- | --- | --- |
| `interaction.familiarity` | 本轮 `user/message` 且 `source.kind==='user'` | `relation.familiarity +0.02` | 用户说过话 → 熟悉度累积（关系不衰减） |
| `tool.failure.dampen` | 本轮有 `tool/result.isError` | `mood.valence −0.08`、`relation.trust −0.02` | 失败作为「经历」进入状态机（CONCEPTS §4.4） |

**衰减**：`mood` 按 **6h 半衰期**向基线回归；`relation` 不衰减。

## 事实采集（结构事件，模型文本不写状态）

`turn/start` 建账 → `user/message`（仅 `source.kind==='user'` 计数）/ `tool/result`（仅 `isError`）累加 → `turn/end` 结算。

## 模块级模拟（harness，`/tmp/lep-machine-test.mjs`）

| 场景 | 结果 |
| --- | --- |
| 用户轮 | `familiarity 0.1→0.12`；audit：`{"turn":1,"rules":["interaction.familiarity"],"changes":{"familiarity":[0.1,0.12]}}` |
| 仅合成注入轮 | **无变化、无 audit 行** ✅（只有真·用户消息计数） |
| 工具失败轮 | `valence 0→-0.08`、`trust 0.3→0.28`；写入 reason「刚才有个操作没成。」；audit 落对应行 |
| 12h 后（＝2 个半衰期） | `valence 0.8→0.2`、`arousal 0.9→0.525`（正好 ¼ 靠向基线）✅ |
| `state.json` / `audit.jsonl` | 数值四舍五入到 4 位，人可读 |

## 实机（headless，隔离 home `/tmp/lep-headless`）

```bash
DSH_HOME=/tmp/lep-headless dsh --profile lepimemory-headless \
  --patch /tmp/leptest/machine.yml "你好，随便说一句话。"      # stateFile → /tmp/leptest/state-machine.json
```

结果：

```
# /tmp/leptest/state-machine.json
"relation": { "trust": 0.3, "closeness": 0.2, "familiarity": 0.12 }

# /tmp/leptest/audit.jsonl
{"at":"2026-09-29T04:30:01.409Z","turn":1,"rules":["interaction.familiarity"],"changes":{"familiarity":[0.1,0.12]}}
```

## 结论与边界

- ✅ 机制跑通：**结构事件 → 规则 → 状态文件变更 → 自有审计**（跨进程持久；每轮组装重读 → 无需重启即影响渲染）。
- ⚠️ **量级待实测**：单轮 +0.02 熟悉度、−0.08 心境都低于渲染分档阈值（`|Δ|≥0.10`），单轮不会改变语气——这是刻意的「慢变」；演示范例需多轮或调量级（DESIGN_NOTES §1.7）。
- 未做：规则集扩充（如关系类事件、情绪极性冲突）、衰减参数标定、正式人设注入、记忆召回。
