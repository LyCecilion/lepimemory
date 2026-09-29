<!-- Lepimemory — 极创工作室第二次面试题 -->

# 蝶忆 Lepimemory

> 一个具有**持续状态、人格、长期记忆与真实行动**能力的角色 Agent —— 而且它的每一次变化都能被观测与审计。
> （极创工作室第二次面试题 · 形式：PPT + 公开仓库）

**状态**：Phase 0–2 已完成（架构决策 / dsh 状态注入验证 / Hindsight 记忆服务跑通）。
**Phase 3 进行中**：状态持久化 + 事件驱动状态机（含心境衰减与自有审计）+ 正式人设注入 + **记忆召回竖切**（Hindsight `recall`→归因→注入）均已落地；
待续：记忆**写路径**（`retain`）、规则集标定、`DEMO.md` 剧本——进度与证据见 `HANDOFF.md` 与 `docs/research/artifacts/`。

## 快速开始（评委自助）

前置：Docker（含 Compose v2）+ 官方发行版 Node（≥ 24，或 22.19+）+ curl。

```bash
cp .env.example .env     # 可选：填入模型 key；留空也能看到前几步
make dev                 # 起 Hindsight + dsh；首次启动需拉多语言模型（约 1–2 分钟）
```

然后打开 <http://127.0.0.1:3080>，按 `docs/DEMO.md` 的剧本走。

- ⏳ **首次启动**：Hindsight 首次会经 `hf-mirror` 拉两个多语言模型（约 1–2 分钟，视网速），缓存在卷 `hindsight-hf-cache`；之后启动约 16 秒。`make dev` 会等 Hindsight 健康检查通过。
- 🔌 本机 3080 被占用时：`make dev PORT=3181`。
- 🧹 想从零再来：`make reset`。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `dsh/profiles/lepimemory/` | dsh profile：模型接入 + 能力面裁剪 |
| `dsh/plugins/` | 自研插件包（Phase 1 起） |
| `docs/research/` | dsh 调研、Hindsight 实测报告与**实测数据附录**、组合树快照 |
| `docs/DEMO.md` | 演示剧本（评委自助） |
| `docker-compose.yml` · `Makefile` · `.env.example` | 部署脚手架 |

## 文档地图

- `CONCEPTS.md` — 已定的架构决策
- `DESIGN_NOTES.md` — 正在形成的判断（含未解项）
- `HANDOFF.md` — 推进计划与上下文交接
- `CHALLENGE.md` — 题目原文
