# Hindsight 实测数据（原始记录 · 附录）

> **历史证据 · 非当前工作流**：本文只存 2026-09-28 的原始实测数字，供复盘/引用，采样按当时原样保留。当前架构见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) §4–§5。

> 配套文档：`docs/research/hindsight-findings.md`（结论与决策）、`dsh-findings.md`。
> 本文件**只存实测数字**，供日后复盘/写 PPT 引用。日期：2026-09-28，本机 Fedora。
> ⚠️ 不含真实个人记忆内容；示例均为合成测试 bank（`lepi-test` / `qingning`）。

---

## 0. 环境基线

| 项 | 值 |
| --- | --- |
| Hindsight 运行版本 | API **0.10.0**（`/version`） |
| 参考仓库 | `external/hindsight` = **0.10.1**（pyproject） |
| 镜像 | `ghcr.io/vectorize-io/hindsight:latest`，`image.version=0.10.0`，built `2026-09-14`，rev `5d46f9c8…` |
| 镜像大小 | 3.64 GB |
| docker compose | v5.5.1（`docker-compose-0:5.5.1-1.fc44`，dnf 装） |
| 端口 | `127.0.0.1:8888`（API）/ `:9999`（UI） |
| PG | 内嵌 pg0（`/home/hindsight/.pg0`） |
| 镜像烘入模型 | `BAAI/bge-small-en-v1.5`、`cross-encoder/ms-marco-MiniLM-L-6-v2`（**均英文**） |
| 内嵌 PG 可用扩展 | `amcheck…vector`（标准集）；**无** zhparser / pgroonga / pg_search / vchord；已装：`plpgsql, vector, pg_trgm` |
| schema 维度 | `sa.Column("embedding", Vector(384))`（`alembic/…/5a366d414dce_initial_schema.py:272`）→ 本地 embedding **必须 384 维** |

---

## 1. 部署 / 启动（时间）

| 场景 | 结果 |
| --- | --- |
| 旧裸容器 LLM | `deepseek / deepseek-v4-flash`；`dry-run-extract` → **47.06s 超时**（key 已失效） |
| 新容器（英文模型已烘入 + `HF_HUB_OFFLINE=1`） | `docker compose up -d --wait` → **healthy ≈ 16s** |
| 新容器（无 offline，尝试连 HF） | 启动 **~2min 后 `Application startup failed`**，根因 `SentenceTransformer` 走 HF 网络（容器内不可达） |
| 新容器（换多语言模型，首次经 hf-mirror 拉） | **healthy ≈ 64s**（含下载 2 个模型） |
| 容器内网络 | `huggingface.co` → **unreachable(errno 101)**；`hf-mirror.com` → **200**；LLM 端点（`.env` 提供）→ 401（需 key） |

**资源（首次加载日志）**：`Embeddings dim=384, device=cpu`；`Reranker device=cpu, max_concurrent=4`；reranker 有一条无害告警：`copied 201/203 misaligned tensor(s)`。

---

## 2. LLM 端点探针（OpenAI 兼容聚合端点）

| 探测 | 结果 |
| --- | --- |
| `GET /v1/models` | 200，含 `deepseek-flash / deepseek-v4-flash / deepseek-v4-pro / kimi-k2.6 / glm-5.3 / grok-4.7 …` |
| `POST /chat/completions` `deepseek-flash` | 2.85s 返回；`model=deepseek-v4.1-flash`（别名），内容 `PONG`；usage prompt 38 / completion 17 / total 55 |
| `api.deepseek.com` / `api.minimaxi.com` | 401（可达，需鉴权） |
| **429 限流** | 连续调用触发 `HTTP 429 ModelArts.81111/81114`；Hindsight 重试 4 次仍失败 → API 500（详见 §3） |

---

## 3. `dry-run-extract`（零写入）逐档

样本：`早呀～今天天气不错。…蓝莓味酸奶…上周六看 livehouse…下个月学吉他…`

| 模式 | 耗时 | facts | tokens | 备注 |
| --- | --- | --- | --- | --- |
| `concise`（默认） | — | 3 | — | 首跑 500（429 限流），重试即通；会跳过寒暄 |
| `verbose` | 10.0s | 4 | 4561 | 连寒暄一起抽，五维全量 |
| `verbatim` | 12.7s | 1 | 2097 | dry-run 里 text 为空（原文另存） |
| `chunks` | **0.0s** | 1 | **0** | 零 LLM，原文入库 |
| `concise` + `retain_mission`（只抽偏好/计划） | 4.8s | **2**（4→2） | — | 窄化生效 |
| `custom`（改第一人称、只留个人属性） | 5.3s | 3 | — | 指引整体替换 |

另一次（青柠样本）：**5.85s / 2 facts / input 3129 · output 227 · total 3356 · thoughts 603**。

**429 原文**：`Rate limit exceeded… ModelArts.81114`（scope=`retain_extract_facts`，重试 1/4→4/4 全 429）。

---

## 4. Embedding 区分度（cos，中文对）

| 模型 | 维度 | 相关 | 不相关 | 差值 |
| --- | --- | --- | --- | --- |
| `BAAI/bge-small-en-v1.5`（原） | 384 | 0.9588 | **0.8154** | +0.1434 |
| `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | **384** | 0.9178 | **-0.1001** | **+1.0178** |
| `BAAI/bge-small-zh-v1.5` | 512 | 0.7555 | 0.1826 | +0.5729 |
| `intfloat/multilingual-e5-small`（带 `query:`/`passage:`） | 384 | 0.9386 | 0.8024 | +0.1362 |
| `intfloat/multilingual-e5-small`（无前缀） | 384 | 0.9503 | 0.8013 | +0.1490 |

> 相关=`青柠喜欢冷萃咖啡` vs `青柠爱喝什么咖啡？`；不相关= vs `如何更换汽车轮胎？`

## 5. Reranker 原始分（cross-encoder）

`相关 / 不相关 / 寒暄 / 完全无关`：

| 模型 | 相关 | 不相关 | 寒暄 | 完全无关 |
| --- | --- | --- | --- | --- |
| `ms-marco-MiniLM-L-6-v2`（原） logit | +6.880 | +2.615 | +2.227 | **+4.743** |
| ↳ sigmoid | 0.9990 | 0.9318 | 0.9026 | **0.9914** |
| `mmarco-mMiniLMv2-L12-H384-v1` logit | +1.458 | -10.308 | -4.052 | -9.071 |
| ↳ sigmoid | **0.8113** | **0.0000** | 0.0171 | **0.0001** |

→ 原 reranker 对中文**完全无区分**（「完全无关」竟比「不相关」还高）。

---

## 6. BM25 关键词臂 = 0

一次 `trace:true` 召回的 `retrieval_results` 分组（按 method × fact_type）：

| method | world | experience | observation |
| --- | --- | --- | --- |
| semantic | 99 | 1 | 80 |
| **bm25** | **0** | **0** | **0** |
| graph | 79 | 0 | 58 |

原因：`native` 后端用 `DEFAULT_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE = "english"`；PG 默认 parser 对中文**整串成 1 token** → 查询永不匹配。内嵌 pg0 无 CJK 分词扩展（可换后端但都要求外置 PG）。

---

## 7. Recall + trace（结构实测）

单次召回（`budget=mid`）：响应 **568 KB**，`results=61`。

```
trace.keys = query, retrieval_results, rrf_merged, reranked, entry_points, visits, summary, final_results
  rrf_merged : {node_id, text, rrf_score, source_ranks{semantic_rank,graph_rank}, final_rrf_rank}
  reranked   : {rerank_rank, rrf_rank, rank_change, score_components{cross_encoder_score,
                cross_encoder_score_normalized, rrf_score, rrf_normalized, temporal, recency, proof_norm, combined_score}}
  results[]  : {id, text, type, entities, context, occurred_start/end, mentioned_at, document_id,
                metadata, chunk_id, tags, source_fact_ids, scores{final,reranker,semantic,keyword}, attachments}
  score_name : semantic→similarity / graph→activation / bm25→bm25_score / temporal→temporal_score
```

**summary**：`total_nodes_visited=180, budget_used=180, budget_remaining=120, results_returned=61, total_duration=1.8956s`

**phase 耗时**（s）：`reranking 1.79`（大头）、`parallel_retrieval 0.08`、`retrieval_temporal_extraction 0.046`、`store_recall 0.033`、`generate_query_embedding 0.014`、`rrf_merge 0.001`、其余 ≈0。

---

## 8. `min_scores` 实测（修复前，query=「如何更换汽车轮胎？」）

**基线 63 条**的分数分布：

| 分数 | min | median | max |
| --- | --- | --- | --- |
| final | 1.0868 | 1.0896 | 1.1058 |
| reranker | 0.9953 | 0.9990 | 0.9996 |
| semantic | 0.7002 | 0.7683 | 0.8357 |

地板效果：

| min_scores | 返回条数 |
| --- | --- |
| `{reranker:0.9999}` | **0** |
| `{final:5.0}` | **0** |
| `{reranker:0.2}` | 63 |
| `{semantic:0.99}` | 61 |
| `{final:0.9}` / `{reranker:0.995}` | 63（**地板低于实际最小值 → 不剪**） |

→ 参数本身工作，但**分数饱和**使其对不相关 query 失效。

---

## 9. 记忆生命周期实测（合成数据，均带 `lepi-test` 标签）

**retain**（各 1 item → 2 facts；usage 约 in 3156 / out 269 / total 3425）→ consolidation 后共 **6 units**：

| id(8) | 类型 | 文本（节） | 来源 |
| --- | --- | --- | --- |
| `b6cbf3a6` | world | 青柠将于 2026-10-07 去杭州出差… | |
| `8c09e49e` | world | 青柠特别喜欢冷萃咖啡。 | |
| `0e30e25d` | world | 原计划杭州…后改为南京… | |
| `e132068c` | world | 青柠最近戒了咖啡，现在只喝茶。 | |
| `571a495a` | **observation** | 青柠曾特别喜欢冷萃咖啡，最近戒了…现在只喝茶。 | `8c09e49e`,`e132068c` |
| `a42da515` | **observation** | 青柠原计划去杭州，现改为去南京。 | `b6cbf3a6`,… |

| 实验 | 结果 |
| --- | --- |
| `prefer_observations=false` | 返回 observation + 原始 world（6 条相关） |
| `prefer_observations=true` | **仅 2 条 observation**（原始被回填去除） |
| PATCH observation | **400**（only world/experience can be curated） |
| invalidate 咖啡 fact | `state=invalidated`；召回命中该条 **0**；观察仍可返回 |
| revert（`state=valid`） | 召回命中恢复 **1** |
| `DELETE /documents/{id}` | 每文档删 2 units；残留 `lepi-test` **0**；`fact_count` 回到 **180** |

---

## 10. 重嵌入（export → import）实测

| 步骤 | 数值 |
| --- | --- |
| export（`include_observations=true`） | `bank-documents.zip` **49297 B**；13 documents + `observations.json` + `manifest.json` |
| import（`on_conflict=replace`） | `facts_imported=100, observations_imported=80, documents_imported=13, skipped=0` |
| 结果 | `fact_count` 仍 **180**（**无重复**）；180 = 100 facts + 80 observations |

**修复前后对比**（同一 bank）：

| query | 修复前 | 修复后 |
| --- | --- | --- |
| 相关（bank 内实体的名字类查询） | 分数全挤 0.99 | n=70；semantic **[0.301, 0.745]**；reranker **[0.004, 0.998]**；top-5 全切题 |
| 不相关「如何更换汽车轮胎？」 | 63 条（semantic 0.70+） | **0 条** |
| 弃权 `{reranker:0.5}` | 无效 | **0 条** |

**青柠 bank 冒烟**（`qingning`，空 bank）：retain 后召回「青柠喜欢什么？」→ top **reranker=1.000**「青柠喜欢清晨散步，也喜欢冷萃咖啡」，次条 0.137；不相关 query 0 条；测后清空残留 0。（注：首跑撞 429，退避后通过。）

---

## 11. 可复现命令（速查）

```bash
# 健康 / 版本
curl -s localhost:8888/health/ready; curl -s localhost:8888/version
# 抽取预演（零写入）
curl -s -X POST localhost:8888/v1/default/banks/<bank>/memories/dry-run-extract \
  -H 'Content-Type: application/json' -d '{"content":"…","retain_extraction_mode":"chunks"}'
# 召回 + trace
curl -s -X POST localhost:8888/v1/default/banks/<bank>/memories/recall \
  -H 'Content-Type: application/json' -d '{"query":"…","trace":true,"budget":"mid"}'
# 失效 / 恢复
curl -s -X PATCH localhost:8888/v1/default/banks/<bank>/memories/<id> -d '{"state":"invalidated","reason":"x"}'
curl -s -X PATCH localhost:8888/v1/default/banks/<bank>/memories/<id> -d '{"state":"valid"}'
# 重嵌入（备份→替换）
curl -s -X POST "localhost:8888/v1/default/banks/<bank>/document-transfer/export?include_observations=true"
curl -s -X POST "localhost:8888/v1/default/banks/<bank>/document-transfer?on_conflict=replace" -F file=@archive.zip
```

---

## 12. 变更记录

- 2026-09-28 v0.1：初版，汇总当日全部实测数字。
