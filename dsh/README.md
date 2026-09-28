# dsh/ — Lepimemory 的 DeepSeek Harness 资产

> 状态：Phase 1 实验期（草案）。机制与验证记录见 `docs/research/dsh-findings.md`。

## 结构

| 路径 | 说明 |
| --- | --- |
| `profiles/lepimemory/` | 项目 profile：模型接入 + 能力面裁剪（agent preset）+ 状态覆盖 |
| `plugins/dsh-lepimemory-state/` | 最小「状态注入」插件（Phase 1 实验）：注册一个 system prompt section |

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

一次性任务测试台（脚本化 A/B 用）：`dsh --profile lepimemory-headless "……"`（可加 `--patch` 叠加改状态）。
注意：该 profile 是独立建的、不在本目录；换新 `DSH_HOME` 时需先创建。

## 现状与待办

- 状态文本目前是**占位**（Phase 2 由状态机动态提供；section 机制不变）
- 插件依赖用**仓库相对路径**（`link:../../../dsh/plugins/…`），由 `make dev` 的 `install-profile` 自动物化（`dsh plugin --profile lepimemory install`）
