# dsh/ — Lepimemory 的 DeepSeek Harness 资产

> 状态：Phase 1 实验期（草案）。机制与验证记录见 `docs/research/dsh-findings.md`。

## 结构

| 路径 | 说明 |
| --- | --- |
| `profiles/lepimemory/` | 项目 profile：模型接入 + 能力面裁剪（agent preset） |
| `plugins/dsh-lepimemory-state/` | 状态注入插件：读一份**持久化 JSON 状态**（`mood` / `relation` / `reasons`），在每次 prompt 组装时实时渲染为 system prompt section |

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
- **待办**：状态**更新规则**（事件驱动状态机本体）、衰减、审计事件尚未实现（Phase 3 后续）。
- 插件依赖用**仓库相对路径**（`link:../../../dsh/plugins/…`），由 `make dev` 的 `install-profile` 自动物化（`dsh plugin --profile lepimemory install`）
