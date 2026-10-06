# Phase 3 第一步验收证据 — 状态从硬编码换成持久化存储（路 B）

> **历史证据 · 非当前工作流**：本文是 2026-09-29「路 B：`state.json`」的验收证据，按当时原样保留。当前架构见 [docs/ARCHITECTURE.md](../../ARCHITECTURE.md) §4.1。
> ⚠️ 与现状的差异：现行状态落**单一 SQLite**（`state` 表 + 同事务审计），**不再读写 `state.json`**；本文描述的路径/文件与补丁写法已不适用。

- 日期：2026-09-29
- 分支：`exp/state-persistence`
- 插件：`@dsh-external/dsh-lepimemory-state`（`dsh/plugins/dsh-lepimemory-state/`）
- 机制：插件读一份持久化 JSON 状态（`<DSH_HOME>/lepimemory/state.json`），
  在**每次 prompt 组装**时经 `section.text(context)` 函数形式重读并渲染（无数值、情境化）。
- 状态文件路径：补丁层 `!!js dshHomePath('lepimemory/state.json')`；插件内兜底 `$DSH_HOME`/`~/.dsh`。
- 本文件只记结论与实测输出；不含个人数据（用 /tmp 合成状态、合成对话）。

---

## 1. 首次启动自动写入（不需要模型）

**命令**：全新 home + **真启动** dsh（`--dump-config` 只组合、不 mount，验不了这条）。

> ⚠️ **link 坑（实测踩到）**：仓库版 profile 用相对 `link:../../../dsh/plugins/…`，**只在
> `DSH_HOME=<repo>/.dsh` 时**才三跳到 `<repo>/dsh/plugins`；换成外部 home（如 `/tmp/lep-smoke`）
> 会指向不存在的 `/tmp/dsh/plugins/…`——`dsh plugin install` 报 `cannot resolve profile bundle`，
> 运行期 cordis 对解析不到的模块**只走 logger、不崩** → 插件静默缺席、不写 `state.json`。
> 故外部 home **必须用绝对 link**：本例直接拷**常驻 profile**（`~/.dsh/profiles/lepimemory`，
> 其依赖是绝对 `link:<repo>/dsh/plugins/…`），**不是** `make dev DSH_HOME=/tmp/…`（那条会踩坑）。

```bash
cp <resident>/profiles/lepimemory → /tmp/lep-smoke/profiles/lepimemory   # 拷常驻版（绝对 link，才解析得到）
DSH_HOME=/tmp/lep-smoke dsh plugin --profile lepimemory install
DSH_HOME=/tmp/lep-smoke dsh --profile lepimemory --no-open --port 3099   # 起来后 Ctrl-C
cat /tmp/lep-smoke/lepimemory/state.json
```

**结果**：文件被自动创建，内容为初始状态（＝基线），web 正常起来（打印 token 入口）。

```json
{
  "mood": { "valence": 0, "arousal": 0.4, "updatedAt": "2026-09-29T03:15:57.691Z" },
  "relation": { "trust": 0.3, "closeness": 0.2, "familiarity": 0.1 },
  "reasons": []
}
```

**日志（说明，非实测输出）**：插件在 apply 里经 `ctx.logger('lepimemory-state').info` 发出
`lepimemory-state: 已写入初始状态：/tmp/lep-smoke/lepimemory/state.json`；
但 **stock app 未挂 console exporter → stdout 看不到**（与 §5 同因）。上面 boot 输出确实只有
`all_proxy` 警告 + token 行——该 logger 行**未被观测到**，此处只记「代码会发」，不当作「实测打出」。

---

## 2. ① 状态文件 → 语气（headless A/B，隔离）

状态文件 `/tmp/leptest/state-a.json`、`state-b.json`；A/B `--patch` 只把该行 `stateFile` 指向对应文件。
**全程用 `/tmp/lept-headless` 独立 home，不碰 `~/.dsh`。**

```bash
DSH_HOME=/tmp/lep-headless dsh --profile lepimemory-headless \
  --patch /tmp/leptest/ab-a.yml "今天过得怎么样？随便聊两句吧。"
```

| | 渲染出的状态文本（已核验进入 session log 的请求） | 回答（尾部） |
| --- | --- | --- |
| A（valence −0.6、trust 0.1） | `心境: 比平常低落；比平常略疲软` / `对用户: 信任略低于平常` / `行为倾向: 语气更简短；有所保留；更愿保持安静` | “还行，就是普通的干活节奏。今天主要在 lepimemory 这个工作目录里待着……倒是你，今天怎么样？” |
| B（valence +0.6、trust 0.9） | `心境: 比平常轻快` / `对用户: 信任明显高于平常；亲近感明显高于平常` + `原因: 她上次说「下次还来找你」` / `行为倾向: 更愿意分享；语气更放松；更愿意靠近对方` | “挺好的，今天手头没什么压着的事儿，整个人比较松弛。……我更想听你的：你今天怎么样？” |

**核验（Model-visible ⟺ logged）**：解压 `session.v4.jsonl.zstd` 后，两轮请求里都能 grep 到对应的
`【内部状态……】` 文本与差异（A：`比平常低落`；B：`比平常轻快` / `信任明显高于平常`）。→ 状态**确实进了模型请求**。

> ⚠️ 同 `ab-fake-persona`：headless profile 未挂 persona 遮蔽，底座 coding-agent 口吻仍渗透
> （“工作目录/跑命令”）。本步只证「状态→语气」，人设遮蔽是另一条待办。

---

## 3. ② 无需重启（同一会话两轮之间编辑状态文件）

`/tmp/lep-web` 独立 home + web 界面，同一会话内：

| 轮次 | state.json | 回答 |
| --- | --- | --- |
| #1 | 基线（启动自动写入） | “我这个‘今天’其实过得挺零碎的……**没有什么情绪起伏，但也谈不上无聊。**” |
| #2 | 轮间手动写入 B（未重启） | “而且说实话，**今天心是轻的**。……**你上次那句‘下次还来找你’，我记住了。**” |

- 第 2 轮直接引用了状态里的 `reason` 文本 → 状态（含原因）实时进了 prompt。
- Trajectory 面板出现**一次** `System Prompt Updated` 的 diff：`- 与基线相比无明显偏移。` →
  `+ 心境: 比平常轻快 / + 对用户: 信任明显高于平常…… / + 原因: …`。
  （**只有一次**是正确的：整段会话里状态只变化过一次［基线→B］；#3/#4 保持 B，故不再产生 diff。）

---

## 4. ③ 重启后仍在

同一 `/tmp/lep-web` home 停进程 → 重启：

- `state.json` 内容与 mtime **完全未变**（`updatedAt` 仍是轮间写入的 `03:30:00Z`，`trust: 0.9`）——
  apply 仅在文件**不存在**时写初始状态，不覆盖既有文件。
- 重启后新一轮（会话历史也被保留）回答：“……**今天安静，轻，心里有点余温，就这些。**”
  → 语气与重启前一致。

---

## 5. ④ 坏 JSON 报错

**启动时（headless，`--patch` 指向坏文件）**：

```
(i) 语法坏：
lepimemory-state: 状态文件 JSON 解析失败（/tmp/leptest/broken-syntax.json）：
Expected double-quoted property name in JSON at position 30 (line 2 column 29)

(ii) 字段坏（"valence": "high"）：
lepimemory-state: 状态字段 "mood.valence" 无效：期望 -1~1 数值，实际 "high"（…/broken-field.json）
```

- 报错**含文件路径与解析位置 / 字段路径**；插件 apply 抛出 → dsh 记
  `warning: 1 entry did not activate`；**不静默回落、不改写坏文件**。
- 另验（模块级）：未知键 → `状态字段 "mood.joy" 无效：未知字段`；越界 → `relation.trust … 实际 1.5`。

**运行中改坏（web，不重启）**：把 `state.json` 截断成 `{ "mood": { "valence": 0.9, ` 后发下一轮：

- 回复仍为上次有效状态（“挺轻的，像有人来过又没走远。”），**进程不崩、不 500**。
- 插件在 `text` 回调里 `ctx.logger('lepimemory-state').error('状态重读失败，沿用上次有效状态：%s', …)`
  （同错去重）。该 `.error` 调用已在带 exporter 的模块级 harness 中实测触发。
  ⚠️ **注意**：stock `dsh web` 的 bundle **未挂 console logger exporter**，故这行在 web stdout 上看不到——
  这是 dsh 的日志装配选择，不是插件未发。后续接 429 退避时，可观测性应走 **durable 审计事件**而非仅 console。

---

## 6. 结论

- 四项验收全部通过：首次写入 / 状态→语气 / 无需重启 / 重启仍在 / 坏 JSON 报错。
- 「插件能读写跨会话的持久状态」成立；`text` 函数形式（每轮重读）是「无需重启」的机制依据。
- 遗留（本步不做，Phase 3 后续）：状态**更新规则**（事件驱动状态机）、衰减、`persona/state-diff` 审计事件。
- 未决/取舍：stock web 无 console exporter（见 §5）；persona 遮蔽**已落地**（2026-09-29，见 `persona-injection.md`）。
