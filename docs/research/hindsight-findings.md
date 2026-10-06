# Hindsight 接入与行为实测报告

> **历史证据 · 非当前工作流**：本文是 2026-09-28 的 Hindsight 接入实测结论（运行版 0.10.0），原始数字见 `hindsight-measurements.md`，按当时原样保留。当前架构见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) §4–§5。
> ⚠️ 与现状的差异：早期「遗忘＝`invalidate` 可无损 revert」与「observation 一律按 fact、不衰减」都已被取代；现行遗忘/来源语义见 ARCHITECTURE §5。

> 整理：Agent 会话，2026-09-28。基于本机 Fedora 实机验证。
> 运行实例 API **0.10.0**，参考仓库 `/home/lycecilion/Workspace/external/hindsight` 为 **0.10.1**（有轻微版本差）。
> 关联：当前架构见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) §1、§4、§5。
> 本文只写**结论与决策**；**原始实测数字**见 `docs/research/hindsight-measurements.md`。
> ⚠️ 本文不含真实个人记忆内容；所有示例均为合成测试数据（bank 名 `lepi-test` / `qingning` 等）。

## TL;DR

1. Hindsight 已从裸 `docker run` 迁到**仓库 `docker-compose.yml` 管理**；LLM 走 OpenAI 兼容端点（地址与 key 由 `.env` 提供）；既有 bank 数据无损（180 facts）。
2. 部署两个硬约束（都不是镜像默认，必须显式给）：`HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1`；以及 compose 卷名要固定成 `hindsight-data` 才能复用既有数据。
3. 行为实测通过：retain 五档、observation 的 refine-not-overwrite、`prefer_observations`、`invalidate ↔ revert`、`min_scores` 弃权。
4. **三个影响设计的发现**：① 聚合站有 **HTTP 429 限流**（偶发 500）；② 本地 embedding/reranker **分数饱和**，基于分数的「宁缺勿滥」不可靠；③ **BM25 中文臂返回 0**。

---

## 1. 部署（本机已验证）

### 1.1 迁移前后

| | 之前 | 现在 |
| --- | --- | --- |
| 管理 | 裸 `docker run --env-file ~/.hindsight.env` | 仓库 `docker-compose.yml` |
| LLM | `deepseek / deepseek-v4-flash` + 个人 key（已超时失效） | `openai` 兼容 / `deepseek-flash` @ `.env` 提供的端点 |
| 数据 | 卷 `hindsight-data` | 同一卷，原样保留 |
| 健康 | — | `healthy`，约 16s 起来（PG + 模型都在） |

### 1.2 两个必须显式设置的变量

- **`HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1`**：两个本地模型（`BAAI/bge-small-en-v1.5`、`cross-encoder/ms-marco-MiniLM-L-6-v2`）**已烘进镜像**，但 `SentenceTransformer` 默认会去 HuggingFace 在线校验；容器内无外网/代理时会卡死并 `Application startup failed`。设这两个变量即走缓存。**它们不是镜像 ENV，必须由部署方传入。**
- **卷名固定为 `hindsight-data`**（compose 顶层 `volumes.<name>.name`）：本机已有同名卷，直接复用；全新机器则自动创建。用默认项目前缀（`lepimemory_hindsight-data`）会接不上既有数据。

### 1.3 冒烟

```bash
docker compose up -d --wait      # 健康检查打 /health
curl -s localhost:8888/health/ready
```

`--wait` 首次可能超过 300s（若模型需下载）；模型已烘进镜像时 ~16s。

---

## 2. API 语义要点（照打）

### 2.1 写入控制是 **bank 级配置**，不是请求体字段

`retain_mission` / `retain_extraction_mode` / `retain_custom_instructions` / `retain_default_strategy` / `retain_strategies` 全部通过
`PATCH /v1/default/banks/{bank_id}/config`，body `{"updates": {...}}`（键可用 Python 字段名或 `HINDSIGHT_API_*` 环境变量名）。

- 请求体内 **item 级**可覆盖的只有：`strategy`、`observation_scopes`、`update_mode`、`timestamp`、`context`、`metadata`、`entities[]`、`tags[]`。
- 优先级：`item.strategy` > `bank.retain_default_strategy` > 解析后的 bank/global 配置。
- `POST /memories/dry-run-extract` **零写入**，可直接传 `retain_mission` / `retain_extraction_mode` / `retain_custom_instructions` / `strategy` 做预演——调抽取参数的首选工具。

### 2.2 retain_extraction_mode 五档（语义）

| 档 | 行为 | LLM | 备注 |
| --- | --- | --- | --- |
| `concise`（默认） | 选择性抽取，摘要式 fact（五维 what/when/where/who/why） | 是 | 会过滤寒暄/填充 |
| `verbose` | 全量细节，逐条五维，启用因果链接 | 是 | 最慢最贵，含填充内容 |
| `custom` | 用 `retain_custom_instructions` **整体替换**抽取指引（无示例） | 是 | 仅 mode=custom 时该字段生效 |
| `verbatim` | 每 chunk 一条 unit，`text` = 原文；LLM 只抽 entities/时间 | 是 | |
| `chunks` | **零 LLM**，每 chunk 原文入库，无实体/时间抽取 | 否 | `provider=none` 时强制此档并关观察 |

- `retain_mission` 作为 per-request user message 的「RETAIN MISSION」前导，**窄化不替换**；对 concise/verbose/verbatim/custom 有效，**chunks 下忽略**。
- `retain_strategies` **无内置名**，是用户自定义的 `name → 字段override` 字典；item 用 `{"strategy": name}` 调用。

### 2.3 recall + trace 的字段树（实测）

```
trace = { query, retrieval_results[], rrf_merged[], reranked[], entry_points[], visits[], summary, final_results[] }
  retrieval_results : 按 method(semantic/bm25/graph/temporal) × fact_type(world/experience/observation) 分组
                      {rank, node_id, text, context, event_date, fact_type, score, score_name, duration_seconds}
                      score_name: similarity | bm25_score | activation | temporal_score
  rrf_merged        : {node_id, text, rrf_score, source_ranks:{semantic_rank, bm25_rank, graph_rank}, final_rrf_rank}
  reranked          : {node_id, text, rerank_score, rerank_rank, rrf_rank, rank_change,
                       score_components:{cross_encoder_score, cross_encoder_score_normalized, rrf_score,
                                         rrf_normalized, temporal, recency, proof_norm, combined_score}}
  summary.phase_metrics : 逐阶段耗时（实测 reranking 占大头）
```

`include`：`entities`（默认开）、`chunks`（传 `{}` 开）、`source_facts`（传 `{}` 开，仅 types 含 observation）。

### 2.4 min_scores（分数弃权）

四字段，两个层级：`semantic` / `keyword` 只压各自**检索臂 SQL**（不是结果谓词）；`reranker` / `final` 是**per-result 硬谓词**（>=）。用 `reranker` 或 `final` 做弃权（全清不过 → 返回空列表）。

### 2.5 遗忘（无单条硬删路由）

- 单条「遗忘」= `PATCH /memories/{id}` body `{"state":"invalidated","reason":"..."}`：行从 `memory_units` **结构性移入** `invalidated_memory_units` 冷归档，recall/consolidation/graph 天然不可见；依赖它的 observations 前后各扫一遍删除，其余共同来源重置待重算；**可无损 revert**（`{"state":"valid"}`，重算 embedding、重连 causal edges）。
- 只有 `world`/`experience` 可 PATCH；对 **observation PATCH → 400**（派生，自动重算）。
- `DELETE /memories/{id}/observations`：删以该 memory 为源的观察。
- 批量：`DELETE /memories?type=world|experience|observation`（无 type = 清 bank，慎用）；`DELETE /observations`（全清观察）。
- **选择性清理的首选**：按 `document_id` 走 `DELETE /documents/{id}`（级联该文档的 memory units + 观察重算）。

### 2.6 observation（refine-not-overwrite）

- 后台 consolidation 把新 facts 与既有 observation 对比，产出 creates/updates/deletes；规则 1 = **PREFER UPDATE OVER CREATE**，`ONE OBSERVATION PER DISTINCT FACET`，状态变化重写为演进（"previously … but has now …"）。
- UPDATE 时 `source_memory_ids` = 旧 ∪ 新（去重），时间边界 LEAST/GREATEST 扩宽，变更史进 `observation_history`。
- scope = consolidate 时的精确 tag 集合；更新用 all_strict 匹配（scope 间严格隔离）。
- 触发重算：retain/import、文档重摄/删除、invalidate/edit/revert、手动 `POST /consolidate`。

---

## 3. 实测记录（隔离测试数据，证据）

均在同一 bank 内用带 `lepi-test` 标签的**合成数据**完成，测后已文档级联删除，`fact_count` 回到 180。

| 验证项 | 结果 |
| --- | --- |
| `dry-run-extract` 五档 | concise/verbose/verbatim/chunks/custom 行为与上表一致；mission 窄化后只留偏好+计划（4→2 facts） |
| 冲突 supersede | 先写「计划去杭州 + 喜欢冷萃咖啡」，再写「改去南京 + 戒咖啡只喝茶」→ 自动合成两条 observation：`曾特别喜欢…现在只喝茶`、`原计划…现改为…`（**保留了旧理解**） |
| `prefer_observations` | `false` 同时返回 observation + 原始 world；`true` 仅返回 observation（被覆盖的原始事实被回填去除） |
| `min_scores` 弃权 | `reranker:0.9999` → 0 条；`final:5.0` → 0 条；地板过低则不过滤 —— **参数本身工作正常**（见 §4 的校准问题） |
| `invalidate → revert` | 失效后该 fact 不再被召回（0 命中）；revert 后恢复命中（1）；PATCH observation → 400 |
| 文档级联删除 | `DELETE /documents/{id}` 删 2 units/文档，统计归零 |

---

## 4. 影响 Lepimemory 设计的发现（重要）

1. **聚合站限流（HTTP 429）**：`deepseek-flash` 在连续多次调用后触发 `ModelArts.81111/81114`，Hindsight 重试 4 次仍失败 → API 返回 500。演示与压测必须**控速/退避**，或换限速更宽的模型。这条会让「评委自助演示」偶发失败，需在 README 里给预案。
2. ~~**本地 embedding/reranker 分数饱和**~~ → ⚠️ **已于 §6.6 修复，本条结论作废**：
   根因是镜像烘的英文模型（`bge-small-en-v1.5` + `ms-marco-MiniLM-L-6-v2`）在中文库上失效。
   换多语言模型并重嵌入后，不相关 query 自然弃权（63 条 → 0 条），**基于分数的弃权现已开箱可用**。
   保留本条作为「修复前的病态表现」记录；当前有效结论见 §6.6。
3. **BM25 中文臂返回 0**：`bm25` 对 world/experience/observation 三组全返回 0 条，实际检索只靠 `semantic + graph`。
   ⚠️ **已于 §6.4 定位为「本部署无解」并决策弃用**（内嵌 pg0 无 CJK 分词扩展）——见 `CONCEPTS.md` §6。本条保留为原始实测记录。
4. **`final` 分不是 0–1 区间**（实测 ≈1.09），`reranker` 虽 0–1 但饱和。
5. **`GET /memories/{id}` 不返回 `proof_count`**（实测为 `null`）；观察的「被多少来源支撑」目前只能从 `source_memory_ids` 长度推。（0.10.1 是否补需再验。）
6. **版本差**：运行 0.10.0 < 参考 0.10.1。本文行为以实测 0.10.0 为准。

---

## 5. 与 `DESIGN_NOTES.md` §4 待验证清单的对应

| # | 待验证 | 本文结论 |
| --- | --- | --- |
| 1 | 情境化渲染是否产生行为差异 | 不涉及（自研层） |
| 2 | 衰减时间常数 | 不涉及（自研层） |
| 3 | 「关于 A」/「A 参与」自动切分 | Hindsight 有 entities/`memory_links`/scope，但无现成自动切分 → 仍需自研候选 + 用户确认 |
| 4 | 观察级联重算消除「无源信念」 | ✅ 验证：删除/失效来源后 observation 会被 sweep + re-consolidate |
| 5 | 三层预算 token 实耗 | 部分：`budget`/`max_tokens`/`recall_budget_*` 可配，实测 mid 预算召回 ~1.9s |
| 6 | 情绪门控（召回偏置）是否可被感知 | 不涉及（自研层）；但召回排序可被 `prefer_observations`/`min_scores` 影响，门控需自研后接 |

---

## 6. 中文不适配：根因与修复（深挖 2026-09-28）

### 6.1 现象

- 不相关 query 的 `semantic` 仍 0.70–0.84；`reranker`(归一化) 全压在 0.995–0.9996；`final`≈1.09。
- `bm25` 臂对 world/experience/observation **全返回 0 条**。

### 6.2 根因：一套**纯英文**的本地模型 + **英文**全文分词器，跑中文库

镜像只烘了两个模型，都是英文的：

| 组件 | 实际模型 | 在中文上的表现（实测） |
| --- | --- | --- |
| Embeddings | `BAAI/bge-small-en-v1.5` (384d, **en**) | 相关 cos=0.959 / **不相关 0.815**，区分度仅 **0.14** |
| Reranker | `cross-encoder/ms-marco-MiniLM-L-6-v2` (**en**) | 相关 sigmoid=0.999 / **「完全无关」=0.9914**（比"不相关"还高）→ 几乎无区分 |
| BM25 | native `to_tsvector('english', …)` | PG 默认 parser **不切中文**（整串=1 token）→ 查询永不匹配 |

配置来源：`DEFAULT_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-small-en-v1.5`（config.py:1209）；
`DEFAULT_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE="english"`（config.py:1456）；
reranker 默认 `ms-marco-MiniLM`。**镜像内只烘了这两个模型**（`~/.cache/huggingface/hub`）。

### 6.3 修复验证（一次性容器 + `HF_ENDPOINT=https://hf-mirror.com`，不动运行实例）

| 候选 | 维度 | 相关 | 不相关 | 差值 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `bge-small-en-v1.5`（现状） | 384 | 0.959 | 0.815 | +0.14 | ❌ 病根 |
| `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | **384** | 0.918 | **-0.100** | **+1.02** | ✅ **最佳 drop-in（免改 schema）** |
| `BAAI/bge-small-zh-v1.5` | 512 | 0.756 | 0.183 | +0.57 | ✅ 检索更专用，但**需改 schema** |
| `intfloat/multilingual-e5-small`（带 query:/passage: 前缀） | 384 | 0.939 | 0.802 | +0.14 | ⚠️ 分数高基线、分离差 |

Reranker：`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`（多语言 mMARCO）→ 相关 **0.81** / 不相关 **0.0000** / 完全无关 **0.0001** ✅（同样 H384，drop-in）。

### 6.4 两个硬约束

1. **维度写死在迁移里**：`sa.Column("embedding", Vector(384))`（`alembic/versions/5a366d414dce_initial_schema.py:272`）→ 本地 embedding 模型**必须是 384 维**，否则要改 schema。故首选 `paraphrase-multilingual-MiniLM-L12-v2`。
2. **BM25 中文在本部署里基本无解**：内嵌 pg0 的 `pg_available_extensions` **没有** zhparser / pgroonga / pg_search / vchord，换后端走不通。→ 关键词臂只能弃用，检索靠 `semantic + graph`。
   **决策（2026-09-28）**：保持 `pg0` 单容器，**主动停用关键词臂**——理由与替代路径见 `CONCEPTS.md` §6。

### 6.5 落地配方（建议）

```yaml
environment:
  HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
  HINDSIGHT_API_RERANKER_LOCAL_MODEL: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
  HF_ENDPOINT: https://hf-mirror.com     # 容器连不上 huggingface.co，但连得上 hf-mirror
```

- **模型缓存要持久化**：默认缓存在容器可写层，重建容器即丢（本次踩过：删旧容器 → 模型没了）。挂一个卷到 `/home/hindsight/.cache/huggingface`。
- **既有数据必须重嵌入**：换模型后旧向量（英文空间）不可用。走 **export → import**——文档明确「re-embeds with the target bank's embedding model，**不调用 LLM**」，比 `reprocess`（会重跑抽取）安全。

> 官方文档 `hindsight-docs/docs/developer/multilingual.mdx` 与本节结论一致，并给出推荐模型表（`bge-m3` / `e5-large` 为 1024 维、受 `Vector(384)` 限制不可用；本轮采用官方列的 lighter 档）。

### 6.6 已应用（2026-09-28）

已在运行实例落地（compose env + 模型缓存卷 `hindsight-hf-cache`），并对既有 bank（合成演示数据）执行 export→import 重嵌入：

```
export  → bank-documents.zip (49KB, 13 docs + observations)
import  → on_conflict=replace: facts_imported=100, observations_imported=80, docs=13   (fact_count 仍 180，无重复)
```

| query | 修复前 | 修复后 |
| --- | --- | --- |
| 相关（bank 内实体的名字类查询） | 分数全挤 0.99 | semantic 0.30–0.75 / reranker **0.004–0.998**，top-5 全切题 |
| 不相关（换轮胎） | 63 条、semantic 0.70+ | **0 条**（默认 semantic 地板 0.3 自然弃权） |
| 弃权 `reranker≥0.5` | 无效 | **0 条** |


副作用：BM25 仍 0（本部署无解，见 6.4）。**「宁缺勿滥」现在开箱可用**——不必再自造逐条 LLM 判定。

---

## 7. 变更记录

- 2026-09-28 v0.3：§6.6——多语言修复已落地运行实例并重嵌入既有 bank（含前后对比）。
- 2026-09-28 v0.2：新增 §6 中文适配根因与修复（英文模型/英文 FTS 根因 + 免改 schema 的 384 维修复方案）。
- 2026-09-28 v0.1：初稿（部署迁移 + 语义提取 + 行为实测 + 设计影响）。
