# dsh/ — Lepimemory 的 DeepSeek Harness 资产

> 状态：Phase 1 实验期（草案）。机制与验证记录见 `docs/research/dsh-findings.md`。

## 结构

| 路径 | 说明 |
| --- | --- |
| `profiles/lepimemory/` | 项目 profile：模型接入 + 能力面裁剪（agent preset） |
| `plugins/dsh-lepimemory-state/` | 角色状态插件：持久化 JSON 状态（`state.json`）+ 事件驱动状态机 + 心境衰减 + 自有审计（`audit.jsonl`），每轮渲染为 system prompt section |

## 安装 / 使用

一键（交付形态）：`make dev` —— 会把 `profiles/lepimemory` 同步进 `DSH_HOME`，
并从 `.env` 注入 `GEEK_TECH_CLUB_API_KEY` / `LEPI_LLM_BASE_URL`（见 `.env.example`）。

手动（本机）：

```bash
cp -Rf dsh/profiles/lepimemory/. ~/.dsh/profiles/lepimemory/                          # 同步 profile
dsh plugin --profile lepimemory add link:<repo>/dsh/plugins/dsh-lepimemory-state        # 装插件（自动启用 bundle）
systemctl --user restart lepimemory-dsh
```

> **端点与 key 都只来自环境**（不进仓库）：`GEEK_TECH_CLUB_API_KEY`（凭据）+
> `LEPI_LLM_BASE_URL`（端点，profile patch 里经 `!!js` 读取；留空回落 `api.deepseek.com`）。
> systemd 实例需在 EnvironmentFile 里提供这两个变量。

一次性任务测试台（脚本化 A/B 用）：`dsh --profile lepimemory-headless "……"`（Phase 3 起改状态＝编辑 `$DSH_HOME/lepimemory/state.json`；此前仍可 `--patch` 叠加）。
注意：该 profile 是独立建的、不在本目录；换新 `DSH_HOME` 时需先创建——建法（2026-09-29 实测）：`--from-default-profile headless` 起步（只建不跑用 `--dump-config`）→ `package.json` 的 deps 加本插件 `link:`、bundles 追加本插件（patch 层留空）→ `dsh plugin --profile lepimemory-headless install`。本机样板：`~/.dsh/profiles/lepimemory-headless/`。

## 现状与待办

- **状态持久化（Phase 3 第一步）**：插件读 `<DSH_HOME>/lepimemory/state.json`（补丁层用
  `!!js dshHomePath('lepimemory/state.json')` 解析；未配置时插件兜底 `$DSH_HOME`/`~/.dsh`）。
  首次启动自动写入初始状态；每轮组装重读文件 → **手动编辑该文件即可改状态，无需重启**。
  坏 JSON / 坏字段会报错（含字段路径），不静默回落、不改写坏文件；运行中改坏则记日志并沿用上次有效状态。
- **状态机 v1（事件驱动 + 衰减 + 自有审计）**：插件订阅 `session/event`，在 `turn/end` 收尾时推进状态——
  - 规则是**显式数据**（`lib/machine.js` 的 `RULES`，纯函数 `(facts) => deltas`）；v1 只含 2 条机制验证规则（用户说话→熟悉度 +0.02；工具失败→心境 −0.08、信任 −0.02）；
  - **心境按 6h 半衰期向基线回归**，关系不衰减；
  - 每次变更写 `state.json` + 追加 `audit.jsonl`（`{时刻, 轮次, 命中规则, 维度前→后}`，人可读）。
  - ⚠️ **不往 session log 加自定义事件**（out-of-tree 会破坏会话重载，见 `docs/research/artifacts/session-event-spike.md`）——
    「效果」靠已落的 `system/message` Prompt Diff，「原因」靠自有 `audit.jsonl`（`CONCEPTS.md §5.3`）。
- **正式人设（Phase 1 占位债已清偿）**：profile 的 preset `persona` 行换成完整人设（身份内核 + 说话方式 + 边界），
  经 persona 包注册为 agent 作用域的 persona prefix/suffix（`suffix: ''` = 遮蔽全局后缀，不显示工作目录等）。
  A/B 实测：不再自称 AI/助手，也不再冒「工作目录/跑命令」的编码助手口吻（证据 `docs/research/artifacts/persona-injection.md`）。
  文本可直接改 `dsh/profiles/lepimemory/cordis.patch.yml`。
- **记忆桥（召回竖切）**：`agent/pre-step` 里按用户输入召回 Hindsight（`recall(trace)`）→ **归因筛选**（分数阈值 + 条数上限，入选/排除都留理由）→ 注入 `source:{kind:'lepimemory-recall', form:'recall'}` 的 user 消息（落库可回放）；失败**降级为无记忆回答** + `recall.jsonl` 审计。client 在 `lib/hindsight.js`，桥在 `lib/memory.js`；config 在 profile 的 `memory:`（`bank` / `baseUrl` / `minSemantic`）。
- **记忆写路径（v1.1）**：`turn/end` 收尾时对本轮**用户陈述**做写入判断（过短/**疑问**/**请求**/寒暄跳过 + 内容去重）→ Hindsight `retain`（`concise` 抽取）+ `trust:fact` 标签；**fire-and-forget**，审计 `retain.jsonl`（**recall 前台 3s / retain 后台 30s** 两套预算，retain 非幂等故**不重试**）。experience/推断档待接。
- **待办（Phase 3 后续）**：真实行动工具 + 审批；遗忘；规则集与量级实测；状态面板（client 插件）。
- 插件依赖用**仓库相对路径**（`link:../../../dsh/plugins/…`），由 `make dev` 的 `install-profile` 自动物化（`dsh plugin --profile lepimemory install`）
